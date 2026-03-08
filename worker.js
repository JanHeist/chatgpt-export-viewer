/* ============================================================
   ChatGPT Export Viewer — Web Worker
   Handles parsing of the large conversations-xxx.json parts off the main thread
   ============================================================ */

let conversations = null;
let conversationMap = {};
let index = [];
let searchTextCache = {};

self.onmessage = function (e) {
  switch (e.data.type) {
    case 'loadData':
      loadData();
      break;
    case 'getConversation':
      getConversation(e.data.id);
      break;
    case 'searchConversations':
      searchConversations(e.data.query, e.data.token);
      break;
  }
};

async function loadData() {
  post('loadProgress', { phase: 'Fetching archive\u2026', pct: 5 });

  try {
    conversations = await fetchConversationParts();
    searchTextCache = {};

    post('loadProgress', { phase: 'Building index\u2026', pct: 80 });

    index = [];
    conversationMap = {};

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      const id = conv.conversation_id || conv.id;
      conversationMap[id] = conv;

      const gizmoCollector = createGizmoCollector();
      gizmoCollector.addFromConversation(conv);

      let msgCount = 0;
      const mapping = conv.mapping || {};
      for (const nodeId in mapping) {
        const msg = mapping[nodeId].message;
        if (msg && msg.metadata) gizmoCollector.addFromMeta(msg.metadata);
        if (msg && msg.author && msg.author.role !== 'system') {
          if (!msg.metadata || !msg.metadata.is_visually_hidden_from_conversation) {
            msgCount++;
          }
        }
      }

      index.push({
        id: id,
        title: conv.title || 'Untitled',
        createTime: conv.create_time || 0,
        updateTime: conv.update_time || 0,
        model: conv.default_model_slug || null,
        msgCount: msgCount,
        isStarred: conv.is_starred || false,
        gizmos: gizmoCollector.entries(),
      });
    }

    index.sort(function (a, b) {
      return (b.createTime || 0) - (a.createTime || 0);
    });

    post('loadProgress', { phase: 'Ready', pct: 100 });
    post('indexReady', { index: index });
  } catch (err) {
    post('error', { message: err.message || String(err) });
  }
}

function createGizmoCollector() {
  const map = {};

  function add(id, name) {
    if (!id && !name) return;
    const key = id || name;
    if (!map[key]) {
      map[key] = { id: id || null, name: name || null, key: key };
      return;
    }
    if (!map[key].id && id) map[key].id = id;
    if (!map[key].name && name) map[key].name = name;
  }

  function addFromMeta(meta) {
    if (!meta) return;
    const id = meta.gizmo_id || meta.gizmoId || (meta.gizmo && (meta.gizmo.id || meta.gizmo.gizmo_id));
    const name = meta.gizmo_name || meta.gizmo_display_name || meta.gizmo_title ||
      (meta.gizmo && (meta.gizmo.name || meta.gizmo.title || meta.gizmo.display_name));
    add(id, name);
  }

  function addFromConversation(conv) {
    if (!conv) return;
    add(conv.gizmo_id, conv.gizmo_name || conv.gizmo_display_name || conv.gizmo_title);
    if (conv.gizmo) {
      add(conv.gizmo.id || conv.gizmo.gizmo_id, conv.gizmo.name || conv.gizmo.title || conv.gizmo.display_name);
    }
    if (conv.metadata) addFromMeta(conv.metadata);
  }

  function entries() {
    const list = [];
    for (const key in map) list.push(map[key]);
    return list;
  }

  return {
    addFromMeta: addFromMeta,
    addFromConversation: addFromConversation,
    entries: entries,
  };
}

async function fetchConversationParts() {
  const allConversations = [];
  let part = 0;
  let foundAny = false;

  while (true) {
    const suffix = String(part).padStart(3, '0');
    const filename = `../conversations-${suffix}.json`;
    const pct = Math.min(5 + part * 4, 45);

    post('loadProgress', { phase: `Fetching conversations-${suffix}.json\u2026`, pct: pct });

    const response = await fetch(filename);

    if (!response.ok) {
      if (response.status === 404) {
        if (!foundAny) {
          throw new Error(
            'Cannot find conversations-000.json. Expected files named conversations-000.json, conversations-001.json, etc. If you opened this via file://, you need a local server. Run: python3 -m http.server 8000'
          );
        }
        break;
      }

      throw new Error(
        response.status === 0
          ? 'Cannot load conversation parts. If you opened this via file://, you need a local server. Run: python3 -m http.server 8000'
          : `HTTP ${response.status}: ${response.statusText}`
      );
    }

    foundAny = true;

    post('loadProgress', { phase: `Reading conversations-${suffix}.json\u2026`, pct: Math.min(pct + 3, 48) });
    const text = await response.text();

    post('loadProgress', { phase: `Parsing conversations-${suffix}.json\u2026`, pct: Math.min(pct + 6, 50) });
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected an array in conversations-${suffix}.json`);
    }

    allConversations.push.apply(allConversations, parsed);
    part++;
  }

  return allConversations;
}

function getConversation(id) {
  const conv = conversationMap[id];
  if (!conv) {
    post('error', { message: 'Conversation not found: ' + id });
    return;
  }
  post('conversationData', { id: id, conversation: conv });
}

function searchConversations(query, token) {
  const q = (query || '').trim().toLowerCase();
  if (!q || !Array.isArray(conversations)) {
    post('searchResults', { token: token, query: query || '', ids: [] });
    return;
  }

  const matches = [];
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const id = conv.conversation_id || conv.id;
    if (!id) continue;

    let text = searchTextCache[id];
    if (text === undefined) {
      text = buildConversationSearchText(conv);
      searchTextCache[id] = text;
    }

    if (text && text.indexOf(q) !== -1) {
      matches.push(id);
    }
  }

  post('searchResults', { token: token, query: query || '', ids: matches });
}

function buildConversationSearchText(conv) {
  if (!conv) return '';
  const parts = [];
  if (conv.title) parts.push(conv.title);

  const mapping = conv.mapping || {};
  for (const nodeId in mapping) {
    const node = mapping[nodeId];
    const msg = node ? node.message : null;
    if (!msg || !msg.author) continue;
    if (msg.author.role === 'system') continue;
    if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;

    const text = extractMessageText(msg);
    if (text) parts.push(text);
  }

  return parts.join('\n').toLowerCase();
}

function extractMessageText(msg) {
  const content = msg.content || {};
  const chunks = [];

  if (Array.isArray(content.parts)) {
    for (let i = 0; i < content.parts.length; i++) {
      const part = content.parts[i];
      if (typeof part === 'string' && part.trim()) chunks.push(part);
    }
  }

  if (typeof content.text === 'string' && content.text.trim()) chunks.push(content.text);
  if (typeof content.content === 'string' && content.content.trim()) chunks.push(content.content);
  if (typeof content.result === 'string' && content.result.trim()) chunks.push(content.result);
  if (typeof content.summary === 'string' && content.summary.trim()) chunks.push(content.summary);
  if (typeof content.title === 'string' && content.title.trim()) chunks.push(content.title);
  if (typeof content.name === 'string' && content.name.trim()) chunks.push(content.name);

  return chunks.join('\n');
}

function post(type, data) {
  self.postMessage(Object.assign({ type: type }, data));
}
