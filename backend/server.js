const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const bleRouter = require('./routes/bleRouter');
const { setWss, sseAdd, sseRemove, getLastEvents } = require('./realtime');
const { startScan, getDevicesList, getScanningActive } = require('./services/bleService');

const app = express();
const PORT = process.env.PORT || 3000;

// http server and websocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
setWss(wss);

// static files: serve built client from sibling folder if present
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// REST routes
app.use('/', bleRouter);

// REST handlers moved to router/controller

// SSE stream that emits BLE advertisements to all clients
app.get('/events', (req, res) => {
  // Keep connection open for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial comment to establish stream (useful for some proxies)
  res.write(': ok\n\n');
  // Register client
  sseAdd(res);
  // Send recent buffer to new client
  for (const ev of getLastEvents()) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  // Cleanup on client disconnect
  req.on('close', () => {
    sseRemove(res);
  });
});

// WebSocket: stream advertisements and allow snapshot on connect
wss.on('connection', (ws) => {
  const list = getDevicesList();
  try { ws.send(JSON.stringify({ type: 'snapshot', data: { ts: Date.now(), devices: list, scanningActive: getScanningActive() } })); } catch (_) {}
});

// scanning logic moved to service

server.listen(PORT, () => {
  console.log(`HTTP :${PORT} | SSE /events | WS /ws`);
  startScan({
    allowDuplicates: String(process.env.ALLOW_DUPLICATES || 'true').toLowerCase() === 'true',
    filterMinRssi: Number(process.env.FILTER_MIN_RSSI || -200),
  });
});


