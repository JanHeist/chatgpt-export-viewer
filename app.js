/* ============================================================
   ChatGPT Export Viewer — Main Application
   Editorial Archive / Dark Library
   ============================================================ */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  var State = {
    index: [],
    filtered: [],
    activeId: null,
    activeConv: null,
    activeMessages: [],

    searchQuery: '',
    modelFilter: 'all',
    dateFrom: null,
    dateTo: null,
    sortOrder: 'newest',
    starredOnly: false,

    stars: new Set(),
    models: [],
    fileCache: {},
    manifestMap: null,
    manifestPromise: null,
  };

  // ── DOM refs ───────────────────────────────────────────────
  var $loading     = document.getElementById('loading-screen');
  var $loadStatus  = document.getElementById('loading-status');
  var $loadBar     = document.getElementById('loading-bar');
  var $loadError   = document.getElementById('loading-error');
  var $app         = document.getElementById('app');
  var $headerStats = document.getElementById('header-stats');
  var $search      = document.getElementById('search-input');
  var $modelFilter = document.getElementById('model-filter');
  var $dateFrom    = document.getElementById('date-from');
  var $dateTo      = document.getElementById('date-to');
  var $sortBtn     = document.getElementById('sort-btn');
  var $starFilter  = document.getElementById('star-filter');
  var $convList    = document.getElementById('conv-list');
  var $convSpacer  = document.getElementById('conv-list-spacer');
  var $convContent = document.getElementById('conv-list-content');
  var $content     = document.getElementById('content');
  var $emptyState  = document.getElementById('empty-state');
  var $convHeader  = document.getElementById('conv-header');
  var $convTitle   = document.getElementById('conv-title');
  var $convModel   = document.getElementById('conv-model');
  var $convGizmo   = document.getElementById('conv-gizmo');
  var $convDate    = document.getElementById('conv-date');
  var $convStats   = document.getElementById('conv-stats');
  var $starBtn     = document.getElementById('star-btn');
  var $exportBtn   = document.getElementById('export-btn');
  var $messages    = document.getElementById('messages');
  var $imageModal  = document.getElementById('image-modal');
  var $modalImage  = document.getElementById('modal-image');
  var $menuToggle  = document.getElementById('menu-toggle');
  var $sidebar     = document.getElementById('sidebar');
  var $overlay     = document.getElementById('sidebar-overlay');

  // ── Constants ──────────────────────────────────────────────
  var ITEM_HEIGHT = 72;
  var OVERSCAN = 8;
  var SEARCH_DEBOUNCE = 180;

  // ── Configure marked ──────────────────────────────────────
  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
  });

  // ── Worker ─────────────────────────────────────────────────
  var worker = new Worker('worker.js');
  var convCallbacks = {};

  worker.onmessage = function (e) {
    var d = e.data;
    switch (d.type) {
      case 'loadProgress':
        $loadStatus.textContent = d.phase;
        $loadBar.style.width = d.pct + '%';
        break;
      case 'indexReady':
        onIndexReady(d.index);
        break;
      case 'conversationData':
        if (convCallbacks[d.id]) {
          convCallbacks[d.id](d.conversation);
          delete convCallbacks[d.id];
        }
        break;
      case 'error':
        $loadStatus.style.display = 'none';
        $loadBar.parentElement.style.display = 'none';
        $loadError.style.display = 'block';
        $loadError.querySelector('strong').textContent = d.message;
        break;
    }
  };

  worker.postMessage({ type: 'loadData' });

  function requestConversation(id, cb) {
    convCallbacks[id] = cb;
    worker.postMessage({ type: 'getConversation', id: id });
  }

  // ── Initialization ─────────────────────────────────────────
  function onIndexReady(index) {
    State.index = index;
    State.stars = loadStars();

    // Collect unique models
    var modelSet = {};
    for (var i = 0; i < index.length; i++) {
      var m = index[i].model;
      if (m) modelSet[m] = (modelSet[m] || 0) + 1;
    }
    State.models = Object.keys(modelSet).sort(function (a, b) {
      return modelSet[b] - modelSet[a];
    });

    // Populate model filter
    State.models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m;
      opt.textContent = formatModel(m) + ' (' + modelSet[m] + ')';
      $modelFilter.appendChild(opt);
    });

    // Show app
    $loading.classList.add('fade-out');
    setTimeout(function () {
      $loading.style.display = 'none';
      $app.style.display = '';
      // Force reflow then add visible class for fade-in
      void $app.offsetHeight;
      $app.classList.add('visible');
    }, 500);

    // Load export manifest (for image filename mapping)
    ensureManifestLoaded();

    applyFilters();
    initEvents();
  }

  // ── Filtering ──────────────────────────────────────────────
  function applyFilters() {
    var arr = State.index;
    var q = State.searchQuery.toLowerCase();

    State.filtered = arr.filter(function (c) {
      if (q && c.title.toLowerCase().indexOf(q) === -1) return false;
      if (State.modelFilter !== 'all' && c.model !== State.modelFilter) return false;
      if (State.dateFrom) {
        var from = State.dateFrom.getTime() / 1000;
        if ((c.createTime || 0) < from) return false;
      }
      if (State.dateTo) {
        var to = State.dateTo.getTime() / 1000 + 86400;
        if ((c.createTime || 0) > to) return false;
      }
      if (State.starredOnly && !State.stars.has(c.id)) return false;
      return true;
    });

    if (State.sortOrder === 'newest') {
      State.filtered.sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
    } else {
      State.filtered.sort(function (a, b) { return (a.createTime || 0) - (b.createTime || 0); });
    }

    updateHeaderStats();
    renderSidebar();
  }

  function updateHeaderStats() {
    var total = State.index.length;
    var shown = State.filtered.length;
    $headerStats.textContent = shown === total
      ? total + ' conversations'
      : shown + ' of ' + total + ' conversations';
  }

  // ── Sidebar Virtual List ───────────────────────────────────
  function renderSidebar() {
    var items = State.filtered;
    $convSpacer.style.height = (items.length * ITEM_HEIGHT) + 'px';

    if (items.length === 0) {
      $convContent.innerHTML = '<div class="sidebar__empty">No conversations found</div>';
      return;
    }

    renderVisibleItems();
  }

  function renderVisibleItems() {
    var items = State.filtered;
    var scrollTop = $convList.scrollTop;
    var viewH = $convList.clientHeight;

    var startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
    var endIdx = Math.min(items.length, Math.ceil((scrollTop + viewH) / ITEM_HEIGHT) + OVERSCAN);

    var fragment = document.createDocumentFragment();

    for (var i = startIdx; i < endIdx; i++) {
      var c = items[i];
      var el = document.createElement('div');
      el.className = 'conv-item' + (c.id === State.activeId ? ' active' : '');
      el.style.height = ITEM_HEIGHT + 'px';
      el.dataset.id = c.id;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', c.id === State.activeId ? 'true' : 'false');
      // Stagger animation
      el.style.animationDelay = Math.min((i - startIdx) * 15, 300) + 'ms';

      var starred = State.stars.has(c.id);

      el.innerHTML =
        '<div class="conv-item__top">' +
          '<span class="conv-item__title">' + escapeHtml(c.title) + '</span>' +
          '<span class="conv-item__star ' + (starred ? 'visible' : '') + '">&#9733;</span>' +
        '</div>' +
        '<div class="conv-item__meta">' +
          '<span class="model-badge ' + modelBadgeClass(c.model) + '">' + escapeHtml(formatModel(c.model)) + '</span>' +
          '<span>' + formatRelativeDate(c.createTime) + '</span>' +
          '<span class="conv-item__msgs">' + c.msgCount + ' msgs</span>' +
        '</div>';

      fragment.appendChild(el);
    }

    $convContent.style.transform = 'translateY(' + (startIdx * ITEM_HEIGHT) + 'px)';
    $convContent.innerHTML = '';
    $convContent.appendChild(fragment);
  }

  var scrollRaf = 0;
  $convList.addEventListener('scroll', function () {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      renderVisibleItems();
    });
  });

  // ── Event Binding ──────────────────────────────────────────
  function initEvents() {
    // Sidebar click
    $convContent.addEventListener('click', function (e) {
      var item = e.target.closest('.conv-item');
      if (item) openConversation(item.dataset.id);
    });

    // Search
    var searchTimer;
    $search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        State.searchQuery = $search.value;
        applyFilters();
      }, SEARCH_DEBOUNCE);
    });

    // Model filter
    $modelFilter.addEventListener('change', function () {
      State.modelFilter = $modelFilter.value;
      applyFilters();
    });

    // Date filters
    $dateFrom.addEventListener('change', function () {
      State.dateFrom = $dateFrom.value ? new Date($dateFrom.value) : null;
      applyFilters();
    });
    $dateTo.addEventListener('change', function () {
      State.dateTo = $dateTo.value ? new Date($dateTo.value) : null;
      applyFilters();
    });

    // Sort
    $sortBtn.addEventListener('click', function () {
      State.sortOrder = State.sortOrder === 'newest' ? 'oldest' : 'newest';
      $sortBtn.textContent = State.sortOrder === 'newest' ? 'Newest' : 'Oldest';
      applyFilters();
    });

    // Starred filter
    $starFilter.addEventListener('click', function () {
      State.starredOnly = !State.starredOnly;
      $starFilter.classList.toggle('active', State.starredOnly);
      applyFilters();
    });

    // Star button in header
    $starBtn.addEventListener('click', function () {
      if (State.activeId) toggleStar(State.activeId);
    });

    // Export button
    $exportBtn.addEventListener('click', function () {
      if (State.activeConv && State.activeMessages.length) {
        exportMarkdown(State.activeConv, State.activeMessages);
      }
    });

    // Keyboard navigation
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') {
          document.activeElement.blur();
          e.preventDefault();
        }
        return;
      }

      switch (e.key) {
        case '/':
          e.preventDefault();
          $search.focus();
          break;
        case 'ArrowDown':
          e.preventDefault();
          navigateList(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          navigateList(-1);
          break;
        case 'Escape':
          if ($imageModal.style.display !== 'none') {
            closeImageModal();
          } else {
            closeConversation();
          }
          e.preventDefault();
          break;
      }
    });

    // Image modal close
    $imageModal.addEventListener('click', closeImageModal);

    // Mobile menu
    $menuToggle.addEventListener('click', function () {
      $sidebar.classList.toggle('open');
      $overlay.classList.toggle('visible');
    });
    $overlay.addEventListener('click', function () {
      $sidebar.classList.remove('open');
      $overlay.classList.remove('visible');
    });
  }

  // ── Navigate conversation list ─────────────────────────────
  function navigateList(dir) {
    var list = State.filtered;
    if (!list.length) return;
    var idx = -1;
    if (State.activeId) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === State.activeId) { idx = i; break; }
      }
    }
    var next = Math.max(0, Math.min(list.length - 1, idx + dir));
    openConversation(list[next].id);

    // Scroll sidebar to keep active item visible
    var top = next * ITEM_HEIGHT;
    var viewH = $convList.clientHeight;
    if (top < $convList.scrollTop) {
      $convList.scrollTop = top;
    } else if (top + ITEM_HEIGHT > $convList.scrollTop + viewH) {
      $convList.scrollTop = top + ITEM_HEIGHT - viewH;
    }
  }

  // ── Open / Close Conversation ──────────────────────────────
  function openConversation(id) {
    if (id === State.activeId) return;
    State.activeId = id;

    // Update sidebar active state
    renderVisibleItems();

    // Close mobile sidebar
    $sidebar.classList.remove('open');
    $overlay.classList.remove('visible');

    // Show loading in content area
    $emptyState.style.display = 'none';
    $convHeader.classList.add('visible');
    $messages.innerHTML = '<div style="padding:40px;text-align:center;color:var(--cream-dim);">Loading&hellip;</div>';

    requestConversation(id, function (conv) {
      State.activeConv = conv;
      var msgs = linearizeConversation(conv);
      State.activeMessages = msgs;

      // Header
      $convTitle.textContent = conv.title || 'Untitled';
      var model = conv.default_model_slug || 'unknown';
      $convModel.textContent = formatModel(model);
      $convModel.className = 'model-badge ' + modelBadgeClass(model);
      renderGizmoBadges(extractGizmoEntries(conv, msgs));
      $convDate.textContent = conv.create_time ? formatFullDate(conv.create_time) : '';
      $convStats.textContent = msgs.length + ' messages';

      // Star
      updateStarBtn();

      // Render messages
      renderMessages(msgs);

      // Scroll to top
      $content.scrollTop = 0;
    });
  }

  function closeConversation() {
    State.activeId = null;
    State.activeConv = null;
    State.activeMessages = [];
    $convHeader.classList.remove('visible');
    $messages.innerHTML = '';
    $convGizmo.innerHTML = '';
    $convGizmo.style.display = 'none';
    $emptyState.style.display = '';
    renderVisibleItems();
  }

  // ── Tree Traversal ─────────────────────────────────────────
  function linearizeConversation(conv) {
    var mapping = conv.mapping;
    var current = conv.current_node;
    if (!current || !mapping || !mapping[current]) return [];

    // Walk from current_node to root
    var path = [];
    var nodeId = current;
    while (nodeId) {
      path.push(nodeId);
      var node = mapping[nodeId];
      nodeId = node ? node.parent : null;
    }
    path.reverse();

    var messages = [];
    for (var i = 0; i < path.length; i++) {
      var n = mapping[path[i]];
      var msg = n ? n.message : null;
      if (!msg) continue;
      if (!msg.author) continue;

      // Skip hidden
      if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;

      var ct = msg.content ? msg.content.content_type : null;
      // Skip non-displayable types
      if (ct === 'user_editable_context' || ct === 'app_pairing_content') continue;

      messages.push({
        id: msg.id,
        role: msg.author.role,
        authorName: msg.author.name,
        contentType: ct,
        content: msg.content,
        createTime: msg.create_time,
        metadata: msg.metadata || {},
        recipient: msg.recipient,
        status: msg.status,
      });
    }

    return messages;
  }

  // ── Render Messages ────────────────────────────────────────
  function renderMessages(msgs) {
    var groups = groupMessages(msgs);
    var fragment = document.createDocumentFragment();

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.type === 'tool-group') {
        fragment.appendChild(renderToolGroup(g));
      } else if (g.type === 'thinking-group') {
        fragment.appendChild(renderThinkingGroup(g));
      } else {
        var el = renderSingleMessage(g.message);
        if (el) fragment.appendChild(el);
      }
    }

    $messages.innerHTML = '';
    $messages.appendChild(fragment);

    // Post-process: syntax highlighting for code blocks
    $messages.querySelectorAll('pre code[class*="language-"]').forEach(function (block) {
      try { hljs.highlightElement(block); } catch (e) { /* skip */ }
    });

    // Post-process: KaTeX math rendering
    try {
      renderMathInElement($messages, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
      });
    } catch (e) { /* KaTeX not loaded or error */ }

    // Post-process: wrap code blocks with copy buttons
    $messages.querySelectorAll('pre').forEach(function (pre) {
      if (pre.closest('.code-block-wrapper')) return;
      var wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      var code = pre.querySelector('code');
      var lang = '';
      if (code) {
        var cls = code.className || '';
        var match = cls.match(/language-(\S+)/);
        if (match) lang = match[1];
      }

      var bar = document.createElement('div');
      bar.className = 'code-block-wrapper__bar';
      bar.innerHTML =
        '<span class="code-block-wrapper__lang">' + escapeHtml(lang || 'code') + '</span>' +
        '<button class="copy-btn" aria-label="Copy code">Copy</button>';

      bar.querySelector('.copy-btn').addEventListener('click', function () {
        var text = code ? code.textContent : pre.textContent;
        navigator.clipboard.writeText(text).then(function () {
          bar.querySelector('.copy-btn').textContent = 'Copied';
          bar.querySelector('.copy-btn').classList.add('copied');
          setTimeout(function () {
            bar.querySelector('.copy-btn').textContent = 'Copy';
            bar.querySelector('.copy-btn').classList.remove('copied');
          }, 2000);
        });
      });

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(bar);
      wrapper.appendChild(pre);
    });
  }

  // ── Message Grouping ───────────────────────────────────────
  function groupMessages(msgs) {
    var groups = [];
    var i = 0;
    while (i < msgs.length) {
      var msg = msgs[i];

      // Tool call: assistant code message with recipient != 'all'
      if (msg.role === 'assistant' && msg.contentType === 'code' && msg.recipient && msg.recipient !== 'all') {
        var group = { type: 'tool-group', call: msg, responses: [] };
        i++;
        while (i < msgs.length && msgs[i].role === 'tool') {
          group.responses.push(msgs[i]);
          i++;
        }
        groups.push(group);
        continue;
      }

      // Thinking: thoughts possibly followed by reasoning_recap
      if (msg.contentType === 'thoughts') {
        var tg = { type: 'thinking-group', thoughts: msg, recap: null };
        if (i + 1 < msgs.length && msgs[i + 1].contentType === 'reasoning_recap') {
          tg.recap = msgs[i + 1];
          i++;
        }
        groups.push(tg);
        i++;
        continue;
      }

      // Skip standalone reasoning_recap (already handled)
      if (msg.contentType === 'reasoning_recap') {
        groups.push({ type: 'single', message: msg });
        i++;
        continue;
      }

      groups.push({ type: 'single', message: msg });
      i++;
    }
    return groups;
  }

  // ── Render Single Message ──────────────────────────────────
  function renderSingleMessage(msg) {
    // Skip system messages with empty content
    if (msg.role === 'system') {
      var parts = msg.content ? msg.content.parts : null;
      if (!parts || !parts.length) return null;
      var txt = parts.filter(function (p) { return typeof p === 'string'; }).join('');
      if (!txt.trim()) return null;
    }

    var div = document.createElement('div');
    div.className = 'message message--' + msg.role;

    // Label
    var label = document.createElement('div');
    label.className = 'message__label';
    label.textContent = roleName(msg.role);
    div.appendChild(label);

    // Body
    var body = document.createElement('div');
    body.className = 'message__body';

    var content = renderContent(msg);
    // Skip messages with no renderable content (e.g. empty assistant messages before tool use)
    if (!content) return null;
    body.appendChild(content);
    div.appendChild(body);

    // Timestamp
    if (msg.createTime) {
      var time = document.createElement('time');
      time.className = 'message__time';
      time.textContent = formatTime(msg.createTime);
      time.dateTime = new Date(msg.createTime * 1000).toISOString();
      div.appendChild(time);
    }

    return div;
  }

  // ── Content Dispatch ───────────────────────────────────────
  function renderContent(msg) {
    switch (msg.contentType) {
      case 'text':              return renderText(msg);
      case 'code':              return renderCode(msg);
      case 'thoughts':          return renderThoughts(msg);
      case 'reasoning_recap':   return renderReasoningRecap(msg);
      case 'multimodal_text':   return renderMultimodal(msg);
      case 'tether_browsing_display': return renderBrowsing(msg);
      case 'tether_quote':      return renderTetherQuote(msg);
      case 'execution_output':  return renderExecution(msg);
      case 'computer_output':   return renderComputerOutput(msg);
      case 'system_error':      return renderSystemError(msg);
      case 'super_widget':      return renderSuperWidget(msg);
      case 'sonic_webpage':     return renderSonicWebpage(msg);
      default:                  return renderFallback(msg);
    }
  }

  // ── Text Renderer ──────────────────────────────────────────
  function renderText(msg) {
    var parts = msg.content.parts || [];
    var text = parts.filter(function (p) { return typeof p === 'string'; }).join('\n');
    if (!text.trim()) return null;

    // Strip ChatGPT citation markers like [cite:turn0search0]
    text = text.replace(/\[cite:[^\]]*\]/g, '');

    var div = document.createElement('div');
    div.innerHTML = marked.parse(text);
    return div;
  }

  // ── Code Renderer (standalone tool-call code) ──────────────
  function renderCode(msg) {
    var text = msg.content.text || '';
    var lang = msg.content.language || 'plaintext';
    if (!text.trim()) return null;

    var pre = document.createElement('pre');
    var code = document.createElement('code');
    code.className = 'language-' + lang;
    code.textContent = text;
    pre.appendChild(code);
    return pre;
  }

  // ── Thoughts Renderer ─────────────────────────────────────
  function renderThoughts(msg) {
    var thoughts = msg.content.thoughts || [];
    if (!thoughts.length) return null;

    var details = document.createElement('details');
    details.className = 'collapsible-block collapsible-block--thoughts';

    var summary = document.createElement('summary');
    var summaryText = thoughts.map(function (t) { return t.summary || ''; }).filter(Boolean).join(' \u203a ') || 'Thinking\u2026';
    summary.innerHTML = '<span class="chevron">\u25B6</span> <span class="collapsible-block__icon">\u{1F9E0}</span> ' + escapeHtml(summaryText);
    details.appendChild(summary);

    var content = document.createElement('div');
    content.className = 'collapsible-block__content';
    for (var i = 0; i < thoughts.length; i++) {
      if (thoughts[i].content) {
        var p = document.createElement('div');
        p.innerHTML = marked.parse(thoughts[i].content);
        content.appendChild(p);
      }
    }
    details.appendChild(content);
    return details;
  }

  // ── Reasoning Recap ────────────────────────────────────────
  function renderReasoningRecap(msg) {
    var text = '';
    if (msg.content && msg.content.content) {
      text = msg.content.content;
    } else if (msg.content && msg.content.parts) {
      text = msg.content.parts.filter(function (p) { return typeof p === 'string'; }).join('');
    }
    if (!text.trim()) return null;

    var div = document.createElement('div');
    div.className = 'reasoning-recap';
    div.textContent = text;
    return div;
  }

  // ── Multimodal Text ────────────────────────────────────────
  function renderMultimodal(msg) {
    var parts = msg.content.parts || [];
    var container = document.createElement('div');

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (typeof part === 'string') {
        var cleaned = part.replace(/\[cite:[^\]]*\]/g, '');
        if (cleaned.trim()) {
          var textDiv = document.createElement('div');
          textDiv.innerHTML = marked.parse(cleaned);
          container.appendChild(textDiv);
        }
      } else if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
        container.appendChild(createImageElement(part));
      }
    }

    return container;
  }

  function createImageElement(assetPart) {
    var pointer = assetPart.asset_pointer || '';
    var fileId = extractFileId(pointer);

    if (!fileId) {
      var placeholder = document.createElement('div');
      placeholder.className = 'message-image--missing';
      placeholder.textContent = 'Image not available';
      return placeholder;
    }

    var img = document.createElement('img');
    img.className = 'message-image';
    img.loading = 'lazy';
    img.alt = 'Image';

    if (assetPart.width && assetPart.height) {
      img.style.aspectRatio = assetPart.width + '/' + assetPart.height;
      img.style.maxWidth = Math.min(assetPart.width, 600) + 'px';
    }

    resolveImageSrc(fileId, img, assetPart);
    img.addEventListener('click', function () { openImageModal(img.src); });

    return img;
  }

  function extractFileId(pointer) {
    if (!pointer) return null;
    if (pointer.startsWith('sediment://')) {
      var stripped = pointer.substring(11);
      if (stripped.indexOf('#') !== -1) {
        var segments = stripped.split('#');
        for (var i = 0; i < segments.length; i++) {
          if (segments[i].startsWith('file_') || segments[i].startsWith('file-')) return segments[i];
        }
        return null;
      }
      return stripped;
    }
    if (pointer.startsWith('file-service://')) {
      return pointer.substring(15);
    }
    return null;
  }

  function resolveImageSrc(fileId, img, assetPart) {
    if (State.fileCache[fileId] === false) {
      // Known missing — show placeholder immediately
      showImagePlaceholder(img);
      return;
    }
    if (State.fileCache[fileId]) {
      img.src = State.fileCache[fileId];
      return;
    }

    ensureManifestLoaded().then(function () {
      if (State.fileCache[fileId]) {
        img.src = State.fileCache[fileId];
        return;
      }

      var manifestPath = lookupManifestPath(fileId);
      if (manifestPath) {
        setImageSrc(fileId, manifestPath, img);
        return;
      }

      var stems = buildCandidateStems(fileId, assetPart);
      // Only try the most common export formats to minimize 404 noise
      var exts = ['.png', '.jpg', '.jpeg', '.webp', '-sanitized.jpeg', '-sanitized.png', '-sanitized.jpg'];
      tryCandidateStems(fileId, stems, exts, 0, 0, img);
    });
  }

  function tryCandidateStems(fileId, stems, exts, stemIdx, extIdx, img) {
    if (stemIdx >= stems.length) {
      State.fileCache[fileId] = false; // Cache negative result
      showImagePlaceholder(img);
      return;
    }

    if (extIdx >= exts.length) {
      tryCandidateStems(fileId, stems, exts, stemIdx + 1, 0, img);
      return;
    }

    var path = buildDataPath(stems[stemIdx] + exts[extIdx]);
    fetch(path, { method: 'HEAD' }).then(function (resp) {
      if (resp.ok) {
        setImageSrc(fileId, path, img);
      } else {
        tryCandidateStems(fileId, stems, exts, stemIdx, extIdx + 1, img);
      }
    }).catch(function () {
      tryCandidateStems(fileId, stems, exts, stemIdx, extIdx + 1, img);
    });
  }

  function showImagePlaceholder(img) {
    var placeholder = document.createElement('div');
    placeholder.className = 'message-image--missing';
    placeholder.textContent = 'Image not in export';
    if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
  }

  function ensureManifestLoaded() {
    if (State.manifestPromise) return State.manifestPromise;

    State.manifestPromise = fetch('../export_manifest.json').then(function (resp) {
      if (!resp.ok) throw new Error('No manifest');
      return resp.json();
    }).then(function (manifest) {
      State.manifestMap = buildManifestMap(manifest);
      return State.manifestMap;
    }).catch(function () {
      State.manifestMap = {};
      return State.manifestMap;
    });

    return State.manifestPromise;
  }

  function buildManifestMap(manifest) {
    var map = {};
    var files = manifest && manifest.export_files;
    if (!files || !files.length) return map;

    for (var i = 0; i < files.length; i++) {
      var path = files[i].path;
      if (!path || typeof path !== 'string') continue;

      var parts = path.split('/');
      var filename = parts[parts.length - 1];
      if (!filename) continue;
      if (filename.indexOf('file_') !== 0 && filename.indexOf('file-') !== 0) continue;

      var noExt = stripExtension(filename);
      addManifestEntry(map, noExt, path);

      var baseId = extractBaseFileIdFromName(filename);
      if (baseId) addManifestEntry(map, baseId, path);
    }

    return map;
  }

  function addManifestEntry(map, key, path) {
    if (!key) return;
    if (!map[key]) map[key] = path;
  }

  function lookupManifestPath(fileId) {
    if (!State.manifestMap) return null;
    if (State.manifestMap[fileId]) return State.manifestMap[fileId];

    var baseId = extractBaseFileIdFromName(fileId);
    if (baseId && State.manifestMap[baseId]) return State.manifestMap[baseId];

    return null;
  }

  function buildCandidateStems(fileId, assetPart) {
    var stems = [fileId];
    if (!assetPart) return uniqueList(stems);

    if (isBareFileId(fileId)) {
      var w = assetPart.width || 0;
      var h = assetPart.height || 0;
      var max = (w && h) ? Math.max(w, h) : 0;

      if (max) stems.push(fileId + '-' + max);
      if (w) stems.push(fileId + '-' + w);
      if (h) stems.push(fileId + '-' + h);
    }

    return uniqueList(stems);
  }

  function isBareFileId(fileId) {
    if (!fileId) return false;
    if (/^file_[0-9a-f]+$/i.test(fileId)) return true;
    if (/^file-[A-Za-z0-9]+$/.test(fileId)) return true;
    return false;
  }

  function extractBaseFileIdFromName(name) {
    if (!name) return null;
    var match = name.match(/^(file[_-][A-Za-z0-9]+)/);
    return match ? match[1] : null;
  }

  function stripExtension(name) {
    return name.replace(/\.[^/.]+$/, '');
  }

  function uniqueList(arr) {
    var seen = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var val = arr[i];
      if (!val || seen[val]) continue;
      seen[val] = true;
      out.push(val);
    }
    return out;
  }

  function buildDataPath(path) {
    if (!path) return path;
    if (
      path.indexOf('../') === 0 ||
      path.indexOf('./') === 0 ||
      path.indexOf('http://') === 0 ||
      path.indexOf('https://') === 0 ||
      path.indexOf('data:') === 0 ||
      path.indexOf('blob:') === 0
    ) {
      return encodeURI(path);
    }
    return encodeURI('../' + path);
  }

  function setImageSrc(fileId, path, img) {
    var fullPath = buildDataPath(path);
    State.fileCache[fileId] = fullPath;
    img.src = fullPath;
  }

  // ── Browsing Display ───────────────────────────────────────
  function renderBrowsing(msg) {
    var details = document.createElement('details');
    details.className = 'collapsible-block';

    var summary = document.createElement('summary');
    summary.innerHTML = '<span class="chevron">\u25B6</span> <span class="collapsible-block__icon">\u{1F310}</span> Browsing results';
    details.appendChild(summary);

    var content = document.createElement('div');
    content.className = 'collapsible-block__content';

    var text = (msg.content.result || msg.content.summary || '').trim();
    if (text) {
      content.innerHTML = marked.parse(text);
    } else {
      content.textContent = '(No browsing content available)';
    }
    details.appendChild(content);
    return details;
  }

  // ── Tether Quote ───────────────────────────────────────────
  function renderTetherQuote(msg) {
    var container = document.createElement('div');
    container.className = 'tether-quote';

    var source = document.createElement('cite');
    source.className = 'tether-quote__source';
    var title = msg.content.title || msg.content.domain || 'Source';
    if (msg.content.url) {
      source.innerHTML = '<a href="' + escapeAttr(msg.content.url) + '" target="_blank" rel="noopener">' + escapeHtml(title) + '</a>';
    } else {
      source.textContent = title;
    }
    container.appendChild(source);

    if (msg.content.text) {
      var p = document.createElement('div');
      p.className = 'tether-quote__text';
      p.textContent = msg.content.text.length > 600 ? msg.content.text.substring(0, 600) + '\u2026' : msg.content.text;
      container.appendChild(p);
    }

    return container;
  }

  // ── Execution Output ───────────────────────────────────────
  function renderExecution(msg) {
    var text = msg.content.text || '';
    if (!text.trim()) return null;

    var details = document.createElement('details');
    details.className = 'collapsible-block';

    var summary = document.createElement('summary');
    summary.innerHTML = '<span class="chevron">\u25B6</span> <span class="collapsible-block__icon">\u{1F4BB}</span> Execution output';
    details.appendChild(summary);

    var content = document.createElement('div');
    content.className = 'collapsible-block__content';
    var pre = document.createElement('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';
    pre.style.fontFamily = 'var(--font-mono)';
    pre.style.fontSize = 'var(--text-xs)';
    pre.textContent = text.length > 5000 ? text.substring(0, 5000) + '\n\u2026 (truncated)' : text;
    content.appendChild(pre);
    details.appendChild(content);
    return details;
  }

  // ── Computer Output ────────────────────────────────────────
  function renderComputerOutput(msg) {
    var details = document.createElement('details');
    details.className = 'collapsible-block';

    var summary = document.createElement('summary');
    summary.innerHTML = '<span class="chevron">\u25B6</span> <span class="collapsible-block__icon">\u{1F5A5}</span> Computer screenshot';
    details.appendChild(summary);

    var content = document.createElement('div');
    content.className = 'collapsible-block__content';

    if (msg.content.screenshot && msg.content.screenshot.asset_pointer) {
      content.appendChild(createImageElement(msg.content.screenshot));
    } else {
      content.textContent = '(Screenshot not available)';
    }

    details.appendChild(content);
    return details;
  }

  // ── System Error ───────────────────────────────────────────
  function renderSystemError(msg) {
    var div = document.createElement('div');
    div.className = 'system-error';
    var name = (msg.content.name || 'Error');
    var text = (msg.content.text || msg.content.message || '');
    div.innerHTML = '\u26A0\uFE0F <strong>' + escapeHtml(name) + '</strong>' + (text ? ': ' + escapeHtml(text) : '');
    return div;
  }

  // ── Super Widget (Link Cards) ──────────────────────────────
  function renderSuperWidget(msg) {
    var navlinks = (msg.content.widgets && msg.content.widgets.navlinks) || [];
    if (!navlinks.length) return null;

    var container = document.createElement('div');
    for (var i = 0; i < navlinks.length; i++) {
      var link = navlinks[i];
      var card = document.createElement('a');
      card.className = 'link-card';
      card.href = link.url || '#';
      card.target = '_blank';
      card.rel = 'noopener';
      card.innerHTML =
        '<div class="link-card__title">' + escapeHtml(link.title || '') + '</div>' +
        '<div class="link-card__domain">' + escapeHtml(link.domain || '') + '</div>' +
        (link.snippet ? '<div class="link-card__snippet">' + escapeHtml(link.snippet) + '</div>' : '');
      container.appendChild(card);
    }
    return container;
  }

  // ── Sonic Webpage ──────────────────────────────────────────
  function renderSonicWebpage(msg) {
    var card = document.createElement('a');
    card.className = 'link-card';
    card.href = msg.content.url || '#';
    card.target = '_blank';
    card.rel = 'noopener';
    card.innerHTML =
      '<div class="link-card__title">' + escapeHtml(msg.content.title || '') + '</div>' +
      '<div class="link-card__domain">' + escapeHtml(msg.content.domain || '') + '</div>';
    return card;
  }

  // ── Fallback ───────────────────────────────────────────────
  function renderFallback(msg) {
    if (!msg.content) return null;
    var parts = msg.content.parts;
    if (parts && parts.length) {
      var text = parts.filter(function (p) { return typeof p === 'string'; }).join('\n');
      if (text.trim()) {
        var div = document.createElement('div');
        div.innerHTML = marked.parse(text);
        return div;
      }
    }
    // Try .text field
    if (msg.content.text && msg.content.text.trim()) {
      var div2 = document.createElement('div');
      div2.innerHTML = marked.parse(msg.content.text);
      return div2;
    }
    return null;
  }

  // ── Tool Group Renderer ────────────────────────────────────
  function renderToolGroup(group) {
    var details = document.createElement('details');
    details.className = 'collapsible-block';

    var summary = document.createElement('summary');
    var toolName = getToolName(group.call.recipient);
    var toolIcon = getToolIcon(group.call.recipient);
    summary.innerHTML = '<span class="chevron">\u25B6</span> <span class="collapsible-block__icon">' + toolIcon + '</span> ' + escapeHtml(toolName);
    details.appendChild(summary);

    var content = document.createElement('div');
    content.className = 'collapsible-block__content';

    // Tool call code
    if (group.call.content && group.call.content.text) {
      var pre = document.createElement('pre');
      pre.style.fontFamily = 'var(--font-mono)';
      pre.style.fontSize = 'var(--text-xs)';
      pre.style.marginBottom = 'var(--sp-3)';
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.wordBreak = 'break-word';
      var code = document.createElement('code');
      var lang = group.call.content.language || 'plaintext';
      code.className = 'language-' + lang;
      code.textContent = group.call.content.text;
      pre.appendChild(code);
      content.appendChild(pre);
    }

    // Tool responses
    for (var i = 0; i < group.responses.length; i++) {
      var resp = group.responses[i];
      var rendered = renderContent(resp);
      if (rendered) content.appendChild(rendered);
    }

    details.appendChild(content);

    var wrapper = document.createElement('div');
    wrapper.className = 'message message--tool';
    wrapper.appendChild(details);
    return wrapper;
  }

  // ── Thinking Group Renderer ────────────────────────────────
  function renderThinkingGroup(group) {
    var div = document.createElement('div');
    div.className = 'message message--assistant';

    var thoughtsEl = renderThoughts(group.thoughts);
    if (thoughtsEl) div.appendChild(thoughtsEl);

    if (group.recap) {
      var recapEl = renderReasoningRecap(group.recap);
      if (recapEl) div.appendChild(recapEl);
    }

    return div;
  }

  // ── Stars ──────────────────────────────────────────────────
  function loadStars() {
    try {
      var data = localStorage.getItem('chatgpt-viewer-stars');
      return new Set(data ? JSON.parse(data) : []);
    } catch (e) {
      return new Set();
    }
  }

  function saveStars() {
    localStorage.setItem('chatgpt-viewer-stars', JSON.stringify(Array.from(State.stars)));
  }

  function toggleStar(id) {
    if (State.stars.has(id)) {
      State.stars.delete(id);
    } else {
      State.stars.add(id);
    }
    saveStars();
    updateStarBtn();
    renderVisibleItems();
  }

  function updateStarBtn() {
    if (!State.activeId) return;
    var starred = State.stars.has(State.activeId);
    $starBtn.innerHTML = starred ? '&#9733;' : '&#9734;';
    $starBtn.classList.toggle('starred', starred);
  }

  // ── Export Markdown ────────────────────────────────────────
  function exportMarkdown(conv, msgs) {
    var md = '# ' + (conv.title || 'Untitled Conversation') + '\n\n';
    md += '**Model:** ' + (conv.default_model_slug || 'Unknown') + '\n';
    md += '**Date:** ' + (conv.create_time ? formatFullDate(conv.create_time) : 'Unknown') + '\n\n---\n\n';

    for (var i = 0; i < msgs.length; i++) {
      var msg = msgs[i];
      if (msg.role === 'system') continue;

      md += '## ' + roleName(msg.role) + '\n\n';

      if (msg.contentType === 'text' || msg.contentType === 'multimodal_text') {
        var parts = msg.content.parts || [];
        for (var j = 0; j < parts.length; j++) {
          if (typeof parts[j] === 'string') md += parts[j] + '\n';
        }
      } else if (msg.contentType === 'code') {
        md += '```' + (msg.content.language || '') + '\n' + (msg.content.text || '') + '\n```\n';
      } else if (msg.contentType === 'execution_output') {
        md += '```\n' + (msg.content.text || '') + '\n```\n';
      } else if (msg.contentType === 'thoughts') {
        var thoughts = msg.content.thoughts || [];
        for (var k = 0; k < thoughts.length; k++) {
          if (thoughts[k].content) md += '> ' + thoughts[k].content.replace(/\n/g, '\n> ') + '\n';
        }
      }

      md += '\n---\n\n';
    }

    var blob = new Blob([md], { type: 'text/markdown' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (conv.title || 'conversation').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80) + '.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Image Modal ────────────────────────────────────────────
  function openImageModal(src) {
    if (!src) return;
    $modalImage.src = src;
    $imageModal.style.display = 'flex';
  }

  function closeImageModal() {
    $imageModal.style.display = 'none';
    $modalImage.src = '';
  }

  // ── Utility Functions ──────────────────────────────────────
  function extractGizmoEntries(conv, msgs) {
    var map = {};

    function add(id, name) {
      if (!id && !name) return;
      var key = id || name;
      if (!map[key]) {
        map[key] = { id: id || null, name: name || null };
        return;
      }
      if (!map[key].id && id) map[key].id = id;
      if (!map[key].name && name) map[key].name = name;
    }

    function addFromMeta(meta) {
      if (!meta) return;
      var id = meta.gizmo_id || meta.gizmoId || (meta.gizmo && (meta.gizmo.id || meta.gizmo.gizmo_id));
      var name = meta.gizmo_name || meta.gizmo_display_name || meta.gizmo_title ||
        (meta.gizmo && (meta.gizmo.name || meta.gizmo.title || meta.gizmo.display_name));
      add(id, name);
    }

    if (conv) {
      add(conv.gizmo_id, conv.gizmo_name || conv.gizmo_display_name || conv.gizmo_title);
      if (conv.gizmo) {
        add(conv.gizmo.id || conv.gizmo.gizmo_id, conv.gizmo.name || conv.gizmo.title || conv.gizmo.display_name);
      }
      if (conv.metadata) addFromMeta(conv.metadata);
    }

    if (msgs && msgs.length) {
      for (var i = 0; i < msgs.length; i++) {
        addFromMeta(msgs[i].metadata);
      }
    }

    var entries = [];
    for (var key in map) entries.push(map[key]);
    return entries;
  }

  function renderGizmoBadges(entries) {
    if (!entries || !entries.length) {
      $convGizmo.innerHTML = '';
      $convGizmo.style.display = 'none';
      return;
    }

    var label = entries.length > 1 ? 'Categories' : 'Category';
    var html = '<span class="gizmo-label">' + escapeHtml(label) + '</span>';

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var text = entry.name || entry.id || 'Unknown';
      var title = entry.id ? ' title="' + escapeAttr(entry.id) + '"' : '';
      html += '<span class="gizmo-badge"' + title + '>' + escapeHtml(text) + '</span>';
    }

    $convGizmo.style.display = 'inline-flex';
    $convGizmo.innerHTML = html;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function roleName(role) {
    switch (role) {
      case 'user':      return 'You';
      case 'assistant':  return 'Assistant';
      case 'tool':       return 'Tool';
      case 'system':     return 'System';
      default:           return role || 'Unknown';
    }
  }

  function formatModel(slug) {
    if (!slug) return 'Unknown';
    // Truncate absurdly long internal model slugs
    if (slug.length > 30) return slug.substring(0, 24) + '\u2026';
    var map = {
      'gpt-4o': 'GPT-4o', 'gpt-4o-mini': 'GPT-4o mini',
      'gpt-4': 'GPT-4', 'gpt-4-5': 'GPT-4.5',
      'gpt-5': 'GPT-5', 'gpt-5-1': 'GPT-5.1', 'gpt-5-2': 'GPT-5.2',
      'gpt-5-thinking': 'GPT-5 Thinking', 'gpt-5-1-thinking': 'GPT-5.1 Thinking',
      'gpt-5-2-thinking': 'GPT-5.2 Thinking',
      'o1': 'o1', 'o1-preview': 'o1 Preview', 'o1-mini': 'o1 mini',
      'o3': 'o3', 'o3-mini': 'o3 mini', 'o3-mini-high': 'o3 mini High',
      'o4-mini': 'o4 mini', 'o4-mini-high': 'o4 mini High',
      'auto': 'Auto',
    };
    if (map[slug]) return map[slug];
    return slug
      .replace(/-/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); })
      .replace(/Gpt /i, 'GPT-')
      .replace(/^O(\d)/, 'o$1')
      .replace(/Mini/g, 'mini');
  }

  function modelBadgeClass(slug) {
    if (!slug) return 'model-badge--unknown';
    // Normalize to a CSS-safe class
    var base = slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    // Map to known badge classes
    if (base.indexOf('gpt-4o') !== -1) return 'model-badge--gpt-4o';
    if (base.indexOf('gpt-5') !== -1 || base.indexOf('gpt-4-5') !== -1) return 'model-badge--gpt-5';
    if (base.indexOf('gpt-4') !== -1) return 'model-badge--gpt-4';
    if (base.match(/^o[134]/)) return 'model-badge--o1';
    if (base === 'auto') return 'model-badge--auto';
    return 'model-badge--unknown';
  }

  function formatRelativeDate(ts) {
    if (!ts) return '';
    var date = new Date(ts * 1000);
    var now = new Date();
    var diffMs = now - date;
    var diffDays = Math.floor(diffMs / 86400000);

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return diffDays + 'd ago';
    if (diffDays < 30) return Math.floor(diffDays / 7) + 'w ago';
    if (diffDays < 365) return Math.floor(diffDays / 30) + 'mo ago';
    return Math.floor(diffDays / 365) + 'y ago';
  }

  function formatFullDate(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit',
    });
  }

  function getToolName(recipient) {
    var map = {
      'web.run': 'Web Search', 'web': 'Web Search', 'web.search': 'Web Search',
      'browser.open': 'Browsing', 'browser.search': 'Browser Search',
      'browser.find': 'Browser Find', 'browser.run': 'Browsing',
      'python': 'Python', 'python3': 'Python',
      'container.exec': 'Code Execution',
      'file_search.msearch': 'File Search', 'file_search.mclick': 'File Search',
      'computer.do': 'Computer Use', 'computer.get': 'Computer Use',
      'computer.dom_do': 'Computer Use', 'computer.initialize': 'Computer Use',
      'computer.get_dom': 'Computer Use', 'computer.sync_file': 'Computer Use',
      'computer.create_tabs': 'Computer Use', 'computer.list_tabs': 'Computer Use',
      'canmore.create_textdoc': 'Canvas', 'canmore.update_textdoc': 'Canvas',
      'canmore.comment_textdoc': 'Canvas',
      'research_kickoff_tool.start_research_task': 'Deep Research',
      'dalle.text2im': 'DALL-E',
    };
    return map[recipient] || recipient || 'Tool Call';
  }

  function getToolIcon(recipient) {
    if (!recipient) return '\u{1F527}';
    if (recipient.indexOf('web') !== -1 || recipient.indexOf('browser') !== -1) return '\u{1F310}';
    if (recipient.indexOf('python') !== -1 || recipient.indexOf('container') !== -1) return '\u{1F4BB}';
    if (recipient.indexOf('computer') !== -1) return '\u{1F5A5}';
    if (recipient.indexOf('dalle') !== -1) return '\u{1F3A8}';
    if (recipient.indexOf('canmore') !== -1) return '\u{1F4DD}';
    if (recipient.indexOf('research') !== -1) return '\u{1F50D}';
    if (recipient.indexOf('file_search') !== -1) return '\u{1F4C2}';
    return '\u{1F527}';
  }

})();
