const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { LiveChat } = require('youtube-chat');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Fans Persistence ─────────────────────────────────────────────────────
const FANS_FILE = path.join(__dirname, 'fans.json');
let fansData = {};

function loadFans() {
  try {
    if (fs.existsSync(FANS_FILE)) {
      fansData = JSON.parse(fs.readFileSync(FANS_FILE, 'utf8'));
      console.log(`[fans] Loaded ${Object.keys(fansData).length} fans from fans.json`);
    }
  } catch (e) { fansData = {}; }
}

function saveFans() {
  try { fs.writeFileSync(FANS_FILE, JSON.stringify(fansData, null, 2), 'utf8'); } catch (e) {}
}

loadFans();
// Auto-save every 60 seconds
setInterval(saveFans, 60000);

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// ── Fans API ─────────────────────────────────────────────────────────────
app.get('/fans', (req, res) => {
  res.json(fansData);
});

app.post('/fans', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'invalid' });
  // Merge: add scores, keep highest avatar
  for (const [name, data] of Object.entries(incoming)) {
    if (!fansData[name]) {
      fansData[name] = data;
    } else {
      fansData[name].msgs = (fansData[name].msgs || 0) + (data.msgs || 0);
      fansData[name].cmds = (fansData[name].cmds || 0) + (data.cmds || 0);
      fansData[name].superchats = (fansData[name].superchats || 0) + (data.superchats || 0);
      fansData[name].members = (fansData[name].members || 0) + (data.members || 0);
      if (data.avatar && !fansData[name].avatar) fansData[name].avatar = data.avatar;
      if (data.flag) fansData[name].flag = data.flag;
    }
  }
  saveFans();
  res.json({ ok: true, total: Object.keys(fansData).length });
});

// ── Avatar Proxy (bypasses CORS for ggpht.com) ──────────────────────────
const avatarMemCache = new Map();
const AVATAR_CACHE_TTL = 3600000;

app.get('/avatar-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || (!url.includes('ggpht.com') && !url.includes('googleusercontent.com'))) {
    return res.status(400).send('Invalid avatar URL');
  }
  const cached = avatarMemCache.get(url);
  if (cached && (Date.now() - cached.timestamp < AVATAR_CACHE_TTL)) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(cached.buffer);
  }
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(response.status);
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    avatarMemCache.set(url, { buffer, contentType, timestamp: Date.now() });
    if (avatarMemCache.size > 500) {
      const oldest = [...avatarMemCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < 100; i++) avatarMemCache.delete(oldest[i][0]);
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (e) {
    res.status(502).send('Failed to fetch avatar');
  }
});

// ── Multi-Room Chat System ───────────────────────────────────────────────
// Each room = one youtube-chat instance for a channel/live
// Multiple clients on the same channel share one room
const rooms = new Map(); // key -> { liveChat, clients: Set, channelId, liveId, isConnected, firstBatchDone }

function getRoomKey(channelId, liveId) {
  return liveId || channelId || '';
}

function extractVideoId(input) {
  if (!input) return '';
  const match = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
    || input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
    || input.match(/\/live\/([a-zA-Z0-9_-]{11})/)
    || input.match(/^([a-zA-Z0-9_-]{11})$/);
  return match ? match[1] : '';
}

function broadcastToRoom(room, data) {
  const msg = JSON.stringify(data);
  for (const ws of room.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function destroyRoom(key) {
  const room = rooms.get(key);
  if (!room) return;
  if (room.liveChat) {
    try { room.liveChat.stop(); } catch (e) {}
  }
  if (room.statsInterval) clearInterval(room.statsInterval);
  rooms.delete(key);
  console.log(`[room] Destroyed: ${key} (${rooms.size} rooms active)`);
}

function createRoom(channelId, liveId) {
  // Auto-detect: if channelId looks like a URL, extract video ID
  if (channelId && (channelId.includes('youtube.com') || channelId.includes('youtu.be'))) {
    const extracted = extractVideoId(channelId);
    if (extracted) { liveId = liveId || extracted; channelId = ''; }
  }
  if (liveId && liveId.startsWith('UC') && liveId.length > 20 && !channelId) {
    channelId = liveId; liveId = '';
  }
  if (liveId && liveId.includes('/')) {
    const extracted = extractVideoId(liveId);
    if (extracted) liveId = extracted;
  }

  const key = getRoomKey(channelId, liveId);
  if (!key) return null;

  // Reuse existing room
  if (rooms.has(key)) return rooms.get(key);

  const opts = liveId ? { liveId } : { channelId };
  const liveChat = new LiveChat(opts);
  const room = {
    key, liveChat, channelId, liveId,
    clients: new Set(),
    isConnected: false,
    firstBatchDone: false,
    statsInterval: null,
    statsApiKeys: [],
    statsKeyIndex: 0,
    lastLikeCount: -1
  };

  liveChat.on('start', (resolvedLiveId) => {
    room.isConnected = true;
    room.firstBatchDone = false;
    room.liveId = resolvedLiveId;
    console.log(`[room] ${key} connected! liveId: ${resolvedLiveId}`);
    broadcastToRoom(room, { type: 'status', connected: true, liveId: resolvedLiveId });
    setTimeout(() => {
      room.firstBatchDone = true;
      console.log(`[room] ${key} first batch skipped`);
    }, 2000);
  });

  liveChat.on('end', (reason) => {
    room.isConnected = false;
    room.firstBatchDone = false;
    console.log(`[room] ${key} ended: ${reason || 'unknown'}`);
    broadcastToRoom(room, { type: 'status', connected: false, reason: reason || 'ended' });
    setTimeout(() => {
      if (!room.isConnected && rooms.has(key) && room.clients.size > 0) {
        console.log(`[room] ${key} auto-reconnecting...`);
        liveChat.start();
      }
    }, 10000);
  });

  liveChat.on('chat', (chatItem) => {
    let text = '';
    if (chatItem.message) {
      text = chatItem.message.map(m => m.text || m.emojiText || '').join('');
    }
    const avatarUrl = chatItem.author.thumbnail ? chatItem.author.thumbnail.url : '';
    broadcastToRoom(room, {
      type: 'chat',
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      userName: chatItem.author.name,
      channelId: chatItem.author.channelId,
      avatarUrl,
      message: text,
      isOwner: chatItem.isOwner,
      isModerator: chatItem.isModerator,
      isMembership: chatItem.isMembership,
      isVerified: chatItem.isVerified,
      superchat: chatItem.superchat || null,
      timestamp: chatItem.timestamp,
      isHistory: !room.firstBatchDone
    });
  });

  liveChat.on('error', (err) => {
    console.error(`[room] ${key} error:`, err.message || err);
    broadcastToRoom(room, { type: 'error', message: err.message || 'Unknown error' });
  });

  rooms.set(key, room);
  console.log(`[room] Created: ${key} (${rooms.size} rooms active)`);

  liveChat.start().then(ok => {
    if (!ok) {
      console.log(`[room] ${key} failed to start`);
      broadcastToRoom(room, { type: 'error', message: 'Failed to connect. Check if channel is live.' });
    }
  });

  return room;
}

// ── Like Stats Polling (per room) ────────────────────────────────────────
function startRoomStats(room, keys, intervalMs) {
  if (room.statsInterval) clearInterval(room.statsInterval);
  room.statsApiKeys = keys.map(k => ({ key: k, status: 'ok', error: '' }));
  room.statsKeyIndex = 0;
  room.lastLikeCount = -1;
  const ms = Math.max(1000, intervalMs || 2000);
  console.log(`[stats] Room ${room.key}: polling every ${ms}ms with ${keys.length} key(s)`);
  broadcastRoomStatsStatus(room);
  pollRoomLikes(room);
  room.statsInterval = setInterval(() => pollRoomLikes(room), ms);
}

function stopRoomStats(room) {
  if (room.statsInterval) { clearInterval(room.statsInterval); room.statsInterval = null; }
  room.statsApiKeys = [];
  room.lastLikeCount = -1;
  broadcastRoomStatsStatus(room);
}

function getRoomStatsKey(room) {
  const ok = room.statsApiKeys.filter(k => k.status === 'ok');
  if (ok.length === 0) return '';
  room.statsKeyIndex = room.statsKeyIndex % ok.length;
  return ok[room.statsKeyIndex].key;
}

function rotateRoomStatsKey(room) {
  const ok = room.statsApiKeys.filter(k => k.status === 'ok');
  if (ok.length === 0) return '';
  room.statsKeyIndex = (room.statsKeyIndex + 1) % ok.length;
  return ok[room.statsKeyIndex].key;
}

function broadcastRoomStatsStatus(room) {
  const ok = room.statsApiKeys.filter(k => k.status === 'ok').length;
  const total = room.statsApiKeys.length;
  broadcastToRoom(room, { type: 'stats_status', ok, total, active: !!room.statsInterval });
}

async function pollRoomLikes(room) {
  if (!room.liveId) return;
  const apiKey = getRoomStatsKey(room);
  if (!apiKey) return;
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(room.liveId)}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      const code = data.error.code || 0;
      if (code === 403 || (data.error.message || '').toLowerCase().includes('quota')) {
        room.statsApiKeys.forEach(k => { if (k.key === apiKey) { k.status = 'failed'; k.error = `quota/${code}`; } });
        broadcastRoomStatsStatus(room);
        if (room.statsApiKeys.filter(k => k.status === 'ok').length === 0) {
          stopRoomStats(room);
          broadcastToRoom(room, { type: 'stats_error', message: 'All API keys exhausted' });
        }
      }
      rotateRoomStatsKey(room);
      return;
    }
    if (!data.items || !data.items[0] || !data.items[0].statistics) return;
    const likes = parseInt(data.items[0].statistics.likeCount) || 0;
    if (room.lastLikeCount < 0) { room.lastLikeCount = likes; return; }
    if (likes > room.lastLikeCount) {
      const newLikes = likes - room.lastLikeCount;
      room.lastLikeCount = likes;
      broadcastToRoom(room, { type: 'likes', count: newLikes, total: likes });
    }
    rotateRoomStatsKey(room);
  } catch (e) {
    rotateRoomStatsKey(room);
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws._room = null;
  console.log(`[ws] Client connected (${wss.clients.size} total)`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'connect') {
        // Leave previous room
        if (ws._room) {
          ws._room.clients.delete(ws);
          if (ws._room.clients.size === 0) {
            setTimeout(() => {
              if (ws._room && ws._room.clients.size === 0) destroyRoom(ws._room.key);
            }, 30000);
          }
        }

        const room = createRoom(msg.channelId || '', msg.liveId || '');
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'No valid Channel ID or Live Video ID provided.' }));
          return;
        }
        room.clients.add(ws);
        ws._room = room;

        // Send current status
        ws.send(JSON.stringify({ type: 'status', connected: room.isConnected, liveId: room.liveId }));
        const okKeys = room.statsApiKeys.filter(k => k.status === 'ok').length;
        ws.send(JSON.stringify({ type: 'stats_status', ok: okKeys, total: room.statsApiKeys.length, active: !!room.statsInterval }));
      }

      if (msg.type === 'disconnect' && ws._room) {
        ws._room.clients.delete(ws);
        if (ws._room.clients.size === 0) {
          destroyRoom(ws._room.key);
        }
        ws._room = null;
        ws.send(JSON.stringify({ type: 'status', connected: false, reason: 'manual' }));
      }

      if (msg.type === 'start_stats' && ws._room) {
        const vid = msg.videoId || ws._room.liveId;
        const keys = (msg.apiKeys || []).filter(k => k && k.length > 10);
        if (!vid) {
          ws.send(JSON.stringify({ type: 'stats_error', message: 'No video ID for stats polling' }));
        } else if (keys.length === 0) {
          ws.send(JSON.stringify({ type: 'stats_error', message: 'No API keys provided' }));
        } else {
          startRoomStats(ws._room, keys, msg.interval || 2000);
        }
      }

      if (msg.type === 'stop_stats' && ws._room) {
        stopRoomStats(ws._room);
      }
    } catch (e) {
      console.error('[ws] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    if (ws._room) {
      ws._room.clients.delete(ws);
      if (ws._room.clients.size === 0) {
        setTimeout(() => {
          const room = ws._room;
          if (room && room.clients.size === 0) destroyRoom(room.key);
        }, 30000);
      }
    }
    console.log(`[ws] Client disconnected (${wss.clients.size} total)`);
  });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, () => {
  console.log(`\n  ⛏️  Pickaxe Drop server running at http://localhost:${PORT}`);
  console.log(`  Rooms: multi-tenant, auto-cleanup after 30s idle\n`);
});
