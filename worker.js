/* ============================================================
   ChatGPT Export Viewer — Web Worker
   Handles parsing of the large conversations.json off the main thread
   ============================================================ */

let conversations = null;
let conversationMap = {};
let index = [];

self.onmessage = function (e) {
  switch (e.data.type) {
    case 'loadData':
      loadData();
      break;
    case 'getConversation':
      getConversation(e.data.id);
      break;
  }
};

async function loadData() {
  post('loadProgress', { phase: 'Fetching archive\u2026', pct: 5 });

  try {
    const response = await fetch('../conversations.json');

    if (!response.ok) {
      throw new Error(
        response.status === 0
          ? 'Cannot load conversations.json. If you opened this via file://, you need a local server. Run: python3 -m http.server 8000'
          : `HTTP ${response.status}: ${response.statusText}`
      );
    }

    post('loadProgress', { phase: 'Reading data\u2026', pct: 20 });
    const text = await response.text();

    post('loadProgress', { phase: 'Parsing JSON\u2026', pct: 45 });
    conversations = JSON.parse(text);

    post('loadProgress', { phase: 'Building index\u2026', pct: 80 });

    index = [];
    conversationMap = {};

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      const id = conv.conversation_id || conv.id;
      conversationMap[id] = conv;

      let msgCount = 0;
      const mapping = conv.mapping || {};
      for (const nodeId in mapping) {
        const msg = mapping[nodeId].message;
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

function getConversation(id) {
  const conv = conversationMap[id];
  if (!conv) {
    post('error', { message: 'Conversation not found: ' + id });
    return;
  }
  post('conversationData', { id: id, conversation: conv });
}

function post(type, data) {
  self.postMessage(Object.assign({ type: type }, data));
}
