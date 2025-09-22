// Realtime utilities: SSE buffer and WebSocket broadcast

const MAX_BUFFER = 100;

let wss = null;
const sseClients = new Set();
const lastEvents = [];

function setWss(server) {
  wss = server;
}

function wsBroadcast(message) {
  if (!wss) return;
  const data = JSON.stringify(message);
  for (const client of wss.clients || []) {
    if (client.readyState === 1) {
      try { client.send(data); } catch (_) {}
    }
  }
}

function pushEvent(payload) {
  lastEvents.push(payload);
  if (lastEvents.length > MAX_BUFFER) lastEvents.shift();
  // Fanout to SSE
  for (const res of sseClients) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  }
  // Fanout to WebSocket clients
  wsBroadcast({ type: 'adv', data: payload });
}

function sseAdd(res) {
  sseClients.add(res);
}

function sseRemove(res) {
  sseClients.delete(res);
}

function getLastEvents() {
  return lastEvents;
}

module.exports = {
  setWss,
  wsBroadcast,
  pushEvent,
  sseAdd,
  sseRemove,
  getLastEvents,
};


