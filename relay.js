// relay.js —— 自托管 WebSocket relay（房间转发）。
// 手机和 bridge 各自连 relay，按 /relay/<sessionId> 房间转发。
// x-role 头区分 mac/iphone。relay 看不到明文（E2EE 叠在上面）。
//
// 可独立运行或合并到 server.js：
//   node relay.js [--port 3099]
// 公网穿透推荐 Tailscale / Cloudflare tunnel。

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.RELAY_PORT) || 3099;

const rooms = new Map(); // sessionId -> Set<ws>
const clients = new Map(); // ws -> { sessionId, role }

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('codex-chat-mobile relay');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const sessionId = url.pathname.replace(/^\/relay\//, '').replace(/\/$/, '') || 'default';
  const role = req.headers['x-role'] || 'unknown';

  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
  rooms.get(sessionId).add(ws);
  clients.set(ws, { sessionId, role });

  console.log(`[relay] ${role} joined /relay/${sessionId} (room size: ${rooms.get(sessionId).size})`);

  ws.on('message', (data, isBinary) => {
    const room = rooms.get(sessionId);
    if (!room) return;
    for (const client of room) {
      if (client !== ws && client.readyState === 1) {
        client.send(data, { binary: isBinary });
      }
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    const room = rooms.get(sessionId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) rooms.delete(sessionId);
    }
    clients.delete(ws);
    console.log(`[relay] ${info?.role || '?'} left /relay/${sessionId}`);
  });

  ws.on('error', err => {
    console.error(`[relay] ws error:`, err.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[relay] listening on ws://localhost:${PORT}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  for (const [, room] of rooms) {
    for (const ws of room) ws.close(1001, 'relay shutdown');
  }
  rooms.clear();
  wss.close();
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
