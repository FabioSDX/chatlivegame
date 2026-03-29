const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { LiveChat } = require('youtube-chat');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(path.join(__dirname)));

// ── Avatar Proxy (bypasses CORS for ggpht.com) ──────────────────────────
const avatarMemCache = new Map(); // url -> { buffer, contentType, timestamp }
const AVATAR_CACHE_TTL = 3600000; // 1 hour

app.get('/avatar-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || (!url.includes('ggpht.com') && !url.includes('googleusercontent.com'))) {
    return res.status(400).send('Invalid avatar URL');
  }

  // Check memory cache
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

    // Cache in memory
    avatarMemCache.set(url, { buffer, contentType, timestamp: Date.now() });
    // Evict old entries if cache grows too large
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

let liveChat = null;
let currentChannelId = '';
let currentLiveId = '';
let isConnected = false;
let connectedClients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of connectedClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function stopChat() {
  if (liveChat) {
    try { liveChat.stop(); } catch (e) {}
    liveChat = null;
  }
  isConnected = false;
  currentChannelId = '';
  currentLiveId = '';
}

function extractVideoId(input) {
  if (!input) return '';
  const match = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
    || input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
    || input.match(/\/live\/([a-zA-Z0-9_-]{11})/)
    || input.match(/^([a-zA-Z0-9_-]{11})$/);
  return match ? match[1] : '';
}

function startChat(channelId, liveId) {
  stopChat();

  // Auto-detect: if channelId looks like a URL, extract video ID from it
  if (channelId && (channelId.includes('youtube.com') || channelId.includes('youtu.be'))) {
    const extracted = extractVideoId(channelId);
    if (extracted) {
      liveId = liveId || extracted;
      channelId = '';
    }
  }

  // If liveId looks like a channel ID (starts with UC), swap them
  if (liveId && liveId.startsWith('UC') && liveId.length > 20 && !channelId) {
    channelId = liveId;
    liveId = '';
  }

  // Extract video ID from URL if liveId is a full URL
  if (liveId && liveId.includes('/')) {
    const extracted = extractVideoId(liveId);
    if (extracted) liveId = extracted;
  }

  if (!channelId && !liveId) {
    broadcast({ type: 'error', message: 'No valid Channel ID or Live Video ID provided.' });
    return;
  }

  console.log(`[youtube-chat] Starting with channelId=${channelId || '(none)'} liveId=${liveId || '(none)'}`);

  const opts = liveId ? { liveId } : { channelId };
  liveChat = new LiveChat(opts);
  currentChannelId = channelId || '';
  currentLiveId = liveId || '';

  let firstBatchDone = false;

  liveChat.on('start', (resolvedLiveId) => {
    isConnected = true;
    firstBatchDone = false;
    console.log(`[youtube-chat] Connected! liveId: ${resolvedLiveId}`);
    broadcast({
      type: 'status',
      connected: true,
      liveId: resolvedLiveId
    });
    // Skip the first batch: mark as done after a short delay
    // youtube-chat fires all cached messages synchronously right after 'start'
    setTimeout(() => {
      firstBatchDone = true;
      console.log('[youtube-chat] First batch skipped, now processing live messages');
    }, 2000);
  });

  liveChat.on('end', (reason) => {
    isConnected = false;
    firstBatchDone = false;
    console.log(`[youtube-chat] Ended: ${reason || 'unknown'}`);
    broadcast({ type: 'status', connected: false, reason: reason || 'ended' });
    // Auto-reconnect after 10s
    setTimeout(() => {
      if (!isConnected && (currentChannelId || currentLiveId)) {
        console.log('[youtube-chat] Auto-reconnecting...');
        startChat(currentChannelId, currentLiveId);
      }
    }, 10000);
  });

  liveChat.on('chat', (chatItem) => {
    // Extract text from message array
    let text = '';
    if (chatItem.message) {
      text = chatItem.message.map(m => m.text || m.emojiText || '').join('');
    }

    const avatarUrl = chatItem.author.thumbnail ? chatItem.author.thumbnail.url : '';

    const msg = {
      type: 'chat',
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      userName: chatItem.author.name,
      channelId: chatItem.author.channelId,
      avatarUrl: avatarUrl,
      message: text,
      isOwner: chatItem.isOwner,
      isModerator: chatItem.isModerator,
      isMembership: chatItem.isMembership,
      isVerified: chatItem.isVerified,
      superchat: chatItem.superchat || null,
      timestamp: chatItem.timestamp,
      isHistory: !firstBatchDone  // flag so frontend can skip commands but still detect owner/avatars
    };

    broadcast(msg);
  });

  liveChat.on('error', (err) => {
    console.error('[youtube-chat] Error:', err.message || err);
    broadcast({ type: 'error', message: err.message || 'Unknown error' });
  });

  liveChat.start().then(ok => {
    if (!ok) {
      console.log('[youtube-chat] Failed to start');
      broadcast({ type: 'error', message: 'Failed to connect. Check if channel is live.' });
    }
  });
}

// ── Like Stats Polling (YouTube API) ──────────────────────────────────────
let statsApiKeys = [];       // pool of API keys for stats
let statsKeyIndex = 0;
let statsVideoId = '';
let statsInterval = null;
let lastLikeCount = -1;

function getStatsKey() {
  const ok = statsApiKeys.filter(k => k.status === 'ok');
  if (ok.length === 0) return '';
  statsKeyIndex = statsKeyIndex % ok.length;
  return ok[statsKeyIndex].key;
}

function rotateStatsKey() {
  const ok = statsApiKeys.filter(k => k.status === 'ok');
  if (ok.length === 0) return '';
  statsKeyIndex = (statsKeyIndex + 1) % ok.length;
  return ok[statsKeyIndex].key;
}

function markStatsKeyFailed(key, reason) {
  statsApiKeys.forEach(k => {
    if (k.key === key) { k.status = 'failed'; k.error = reason; }
  });
  const remaining = statsApiKeys.filter(k => k.status === 'ok').length;
  const total = statsApiKeys.length;
  console.log(`[stats] Key failed: ${key.substring(0, 8)}... (${reason}) | ${remaining}/${total} keys left`);
  broadcastStatsStatus();
  if (remaining === 0) {
    stopStatsPolling();
    broadcast({ type: 'stats_error', message: 'All API keys exhausted for like polling' });
  }
}

function broadcastStatsStatus() {
  const ok = statsApiKeys.filter(k => k.status === 'ok').length;
  const total = statsApiKeys.length;
  broadcast({ type: 'stats_status', ok: ok, total: total, active: !!statsInterval });
}

async function pollLikes() {
  if (!statsVideoId) return;
  const apiKey = getStatsKey();
  if (!apiKey) return;

  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(statsVideoId)}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      const code = data.error.code || 0;
      if (code === 403 || (data.error.message || '').toLowerCase().includes('quota')) {
        markStatsKeyFailed(apiKey, `quota/${code}`);
        rotateStatsKey();
      } else {
        rotateStatsKey(); // rotate but don't remove
      }
      return;
    }

    if (!data.items || !data.items[0] || !data.items[0].statistics) return;
    const likes = parseInt(data.items[0].statistics.likeCount) || 0;

    if (lastLikeCount < 0) {
      lastLikeCount = likes; // baseline
      console.log(`[stats] Like baseline: ${likes}`);
      return;
    }

    if (likes > lastLikeCount) {
      const newLikes = likes - lastLikeCount;
      lastLikeCount = likes;
      console.log(`[stats] +${newLikes} like(s)! Total: ${likes}`);
      broadcast({ type: 'likes', count: newLikes, total: likes });
    }

    rotateStatsKey(); // round-robin per request
  } catch (e) {
    console.error('[stats] Fetch error:', e.message);
    rotateStatsKey();
  }
}

function startStatsPolling(videoId, keys, intervalMs) {
  stopStatsPolling();
  statsVideoId = videoId;
  statsApiKeys = keys.map(k => ({ key: k, status: 'ok', error: '' }));
  statsKeyIndex = 0;
  lastLikeCount = -1;

  const ms = Math.max(1000, intervalMs || 2000);
  console.log(`[stats] Polling likes every ${ms}ms with ${keys.length} key(s) for video ${videoId}`);
  broadcastStatsStatus();
  pollLikes(); // first poll immediately
  statsInterval = setInterval(pollLikes, ms);
}

function stopStatsPolling() {
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  statsVideoId = '';
  statsApiKeys = [];
  lastLikeCount = -1;
  broadcastStatsStatus();
}

// ── WebSocket ────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  connectedClients.add(ws);
  console.log(`[ws] Client connected (${connectedClients.size} total)`);

  // Send current status
  ws.send(JSON.stringify({
    type: 'status',
    connected: isConnected,
    channelId: currentChannelId,
    liveId: currentLiveId
  }));
  // Send stats status
  const okKeys = statsApiKeys.filter(k => k.status === 'ok').length;
  ws.send(JSON.stringify({
    type: 'stats_status',
    ok: okKeys,
    total: statsApiKeys.length,
    active: !!statsInterval
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'connect') {
        console.log(`[ws] Connect request: channelId=${msg.channelId || ''} liveId=${msg.liveId || ''}`);
        startChat(msg.channelId || '', msg.liveId || '');
      }

      if (msg.type === 'disconnect') {
        stopChat();
        stopStatsPolling();
        broadcast({ type: 'status', connected: false, reason: 'manual' });
      }

      if (msg.type === 'start_stats') {
        // { type: 'start_stats', videoId: '...', apiKeys: ['key1','key2'], interval: 2000 }
        const vid = msg.videoId || currentLiveId;
        const keys = (msg.apiKeys || []).filter(k => k && k.length > 10);
        if (!vid) {
          ws.send(JSON.stringify({ type: 'stats_error', message: 'No video ID for stats polling' }));
        } else if (keys.length === 0) {
          ws.send(JSON.stringify({ type: 'stats_error', message: 'No API keys provided for stats' }));
        } else {
          startStatsPolling(vid, keys, msg.interval || 2000);
        }
      }

      if (msg.type === 'stop_stats') {
        stopStatsPolling();
      }
    } catch (e) {
      console.error('[ws] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log(`[ws] Client disconnected (${connectedClients.size} total)`);
  });
});

const PORT = process.env.PORT || 3333;
server.listen(PORT, () => {
  console.log(`\n  ⛏️  Pickaxe Drop server running at http://localhost:${PORT}\n`);
});
