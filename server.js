const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const noble = require('@abandonware/noble');
const chalk = require('chalk');
const Table = require('cli-table3');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOW_DUPLICATES = String(process.env.ALLOW_DUPLICATES || 'true').toLowerCase() === 'true';
const FILTER_MIN_RSSI = Number(process.env.FILTER_MIN_RSSI || -200);

// global SSE clients and ring buffer of last events
const sseClients = new Set();
const lastEvents = [];
const MAX_BUFFER = 100;

// unified device storage - everything in one place
const devices = new Map(); // id -> { id, address, localName, lastRssi, lastSeen, serviceUuids, manufacturerDataHex, connected, connectionStatus, connectionTimestamp, connectionError, lastConnectionError, lastConnectionErrorTimestamp, connectionTimeoutId?, peripheral? }
// keep in-memory references to noble peripherals for connect operations
const peripherals = new Map();
// track connected devices separately (for BLE operations)
const connectedDevices = new Map();
const SUMMARY_INTERVAL_MS = Number(process.env.SUMMARY_INTERVAL_MS || 10000);
const SUMMARY_MAX_ROWS = Number(process.env.SUMMARY_MAX_ROWS || 50);

// http server and websocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
let scanningActive = false; // whether BLE scanning is currently running

function wsBroadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(data); } catch (_) {}
    }
  }
}

// simple colored logger with timestamps
function nowIso() {
  return new Date().toISOString();
}

const TAG = {
  HTTP: chalk.bgBlue.white(' HTTP '),
  SCAN: chalk.bgMagenta.white(' SCAN '),
  NEW: chalk.bgGreen.black(' NEW '),
  DISCOVER: chalk.bgCyan.black(' DISCOVER '),
  SUMMARY: chalk.bgGray.black(' SUMMARY '),
  ALERT: chalk.bgYellow.black(' ALERT '),
  ERROR: chalk.bgRed.white(' ERROR '),
  CONNECT: chalk.bgGreen.white(' CONNECT '),
};

const logger = {
  info(tag, message) {
    console.log(`${chalk.gray(nowIso())} ${tag} ${message}`);
  },
  warn(tag, message) {
    console.warn(`${chalk.gray(nowIso())} ${tag} ${chalk.yellow(message)}`);
  },
  error(tag, message) {
    console.error(`${chalk.gray(nowIso())} ${TAG.ERROR} ${message}`);
  },
  debug(tag, message) {
    console.log(`${chalk.gray(nowIso())} ${tag} ${chalk.dim(message)}`);
  },
};

// Order: named devices first (alphabetically by name), unnamed after (keep insertion order)
function compareDevicesByNameUnnamedLast(a, b) {
  const nameA = ((a && a.localName) ? String(a.localName).trim() : '').toLowerCase();
  const nameB = ((b && b.localName) ? String(b.localName).trim() : '').toLowerCase();
  const hasA = nameA.length > 0;
  const hasB = nameB.length > 0;
  if (hasA && !hasB) return -1;
  if (!hasA && hasB) return 1;
  if (hasA && hasB) return nameA.localeCompare(nameB);
  // both unnamed -> keep stable order
  return 0;
}

function colorRssi(rssi) {
  if (typeof rssi !== 'number') return chalk.gray('N/A');
  const text = `${rssi} dB`;
  if (rssi >= -70) return chalk.green(text);
  if (rssi >= -85) return chalk.yellow(text);
  return chalk.red(text);
}

function displayName(name) {
  return name ? chalk.white(name) : chalk.gray('(unnamed)');
}

function shortId(id) {
  if (!id) return '';
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function pushEvent(payload) {
  lastEvents.push(payload);
  if (lastEvents.length > MAX_BUFFER) lastEvents.shift();
  for (const res of sseClients) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  }
  // broadcast to WebSocket clients as well
  wsBroadcast({ type: 'adv', data: payload });
}

// static files: prefer frontend/, fallback to public/
app.use(express.static(path.join(__dirname, 'frontend')));
app.use(express.static(path.join(__dirname, 'public')));

// REST: list of currently known devices (named first, alphabetical)
app.get('/devices', (req, res) => {
  const list = Array.from(devices.values()).sort(compareDevicesByNameUnnamedLast).map(d => {
    // Return all data from unified storage, excluding peripheral reference
    const { peripheral, ...deviceData } = d;
    return deviceData;
  });
  res.json({
    ts: Date.now(),
    count: list.length,
    devices: list,
  });
});

// REST: connect to a specific device by id (stops scanning before connecting)
app.post('/connect/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  const peripheral = peripherals.get(id);
  if (!peripheral) {
    logger.warn(TAG.CONNECT, `Requested connect to unknown device id=${id}`);
    res.status(404).json({ ok: false, error: 'Device not found or not in range' });
    return;
  }
  try {
    // check if already connected
    if (connectedDevices.has(id)) {
      res.status(400).json({ ok: false, error: 'Device already connected' });
      return;
    }
    
    // Set connecting status in unified storage
    const deviceData = devices.get(id) || {};
    devices.set(id, {
      ...deviceData,
      id,
      connectionStatus: 'connecting',
      connectionTimestamp: Date.now(),
      connectionError: null
    });
    
    logger.info(TAG.CONNECT, `Connecting to id=${chalk.white(peripheral.id)} addr=${chalk.white(peripheral.address || '-')}`);
    wsBroadcast({ type: 'connect', data: { id, status: 'starting', ts: Date.now() } });
    
    // Set individual timeout for this device (20 seconds)
    const connectionTimeout = setTimeout(() => {
      const timeoutDevice = devices.get(id);
      if (timeoutDevice?.connectionStatus === 'connecting') {
        const errorMsg = 'Connection timeout (20s)';
        const now = Date.now();
        devices.set(id, {
          ...timeoutDevice,
          connectionStatus: 'error',
          connectionTimestamp: now,
          connectionError: errorMsg,
          lastConnectionError: errorMsg,
          lastConnectionErrorTimestamp: now,
          connectionTimeoutId: null // Clear timeout ID
        });
        wsBroadcast({ type: 'connect', data: { id, status: 'error', error: errorMsg, ts: now } });
        logger.error(TAG.CONNECT, `Connection timeout for id=${id}`);
      }
    }, 20000);
    
    // Store the timeout ID in unified device storage
    const timeoutStoreDevice = devices.get(id) || {};
    devices.set(id, {
      ...timeoutStoreDevice,
      connectionTimeoutId: connectionTimeout
    });

    // attempt connection
    await peripheral.connectAsync();
    
    // Clear timeout on successful connection
    const deviceWithTimeout = devices.get(peripheral.id);
    if (deviceWithTimeout?.connectionTimeoutId) {
      clearTimeout(deviceWithTimeout.connectionTimeoutId);
    }
    
    // Add disconnect event handler for automatic disconnections
    peripheral.on('disconnect', () => {
      if (connectedDevices.has(id)) {
        connectedDevices.delete(id);
        
        // Clear any pending timeout for this device
        const autoDisconnectDevice = devices.get(id);
        if (autoDisconnectDevice?.connectionTimeoutId) {
          clearTimeout(autoDisconnectDevice.connectionTimeoutId);
        }
        
        const now = Date.now();
        devices.set(id, {
          ...autoDisconnectDevice,
          connected: false,
          connectionStatus: 'disconnected',
          connectionTimestamp: now,
          connectionError: 'automatic disconnect',
          connectionTimeoutId: null // Clear timeout ID
          // Keep lastConnectionError if it exists
        });
        
        wsBroadcast({ type: 'disconnected', data: { id, ts: now, reason: 'automatic' } });
        logger.info(TAG.CONNECT, `Device disconnected automatically id=${chalk.white(id)}`);
      }
    });
    // update RSSI after connect if possible
    let connectedRssi = null;
    try { connectedRssi = await peripheral.updateRssiAsync(); } catch (_) {}
    // discover all services and characteristics
    let services = [];
    let characteristics = [];
    try {
      const result = await peripheral.discoverAllServicesAndCharacteristicsAsync();
      services = (result.services || []).map(s => ({ uuid: s.uuid }));
      characteristics = (result.characteristics || []).map(c => ({ uuid: c.uuid, properties: c.properties || [] }));

      // Subscribe to notifications/indications if available to stream device events
      for (const ch of (result.characteristics || [])) {
        const props = ch.properties || [];
        if (props.includes('notify') || props.includes('indicate')) {
          try {
            ch.on('data', (buf, isNotification) => {
              try {
                wsBroadcast({ type: 'notify', data: { id, charUuid: ch.uuid, data: buf ? buf.toString('hex') : null, ts: Date.now() } });
              } catch (_) {}
            });
            await new Promise((resolve) => ch.subscribe(() => resolve()));
            logger.info(TAG.CONNECT, `Subscribed to notifications id=${id} char=${ch.uuid}`);
          } catch (subErr) {
            logger.warn(TAG.CONNECT, `Subscribe failed id=${id} char=${ch.uuid}: ${String(subErr)}`);
          }
        }
      }
    } catch (e) {
      logger.warn(TAG.CONNECT, `Discovery warning for id=${peripheral.id}: ${String(e)}`);
      // continue with basic info
    }

    const adv = peripheral.advertisement || {};
    const details = {
      id: peripheral.id,
      address: peripheral.address,
      localName: adv.localName || null,
      rssi: typeof connectedRssi === 'number' ? connectedRssi : peripheral.rssi,
      serviceUuids: adv.serviceUuids || [],
      manufacturerDataHex: adv.manufacturerData ? adv.manufacturerData.toString('hex') : null,
      connectedAt: Date.now(),
      services,
      characteristics,
    };

    // update devices registry with latest info and mark as connected
    // store connected device details
    connectedDevices.set(peripheral.id, {
      peripheral,
      details,
      connectedAt: Date.now()
    });

    // update unified device storage with connection success
    const successDevice = devices.get(peripheral.id) || {};
    devices.set(peripheral.id, {
      ...successDevice,
      id: peripheral.id,
      address: peripheral.address,
      localName: details.localName,
      lastRssi: details.rssi,
      lastSeen: Date.now(),
      serviceUuids: details.serviceUuids,
      manufacturerDataHex: details.manufacturerDataHex,
      connected: true,
      connectionStatus: 'connected',
      connectionTimestamp: Date.now(),
      connectionError: null,
      connectionTimeoutId: null, // Clear timeout ID
      // Keep lastConnectionError if it exists
      lastConnectionError: successDevice.lastConnectionError,
      lastConnectionErrorTimestamp: successDevice.lastConnectionErrorTimestamp
    });

    // notify websocket clients
    wsBroadcast({ type: 'connected', data: details });
    wsBroadcast({ type: 'connect', data: { id, status: 'success', ts: Date.now() } });
    logger.info(TAG.CONNECT, `Connected to id=${chalk.white(peripheral.id)} services=${services.length} chars=${characteristics.length}`);

    res.json({ ok: true, device: details });
  } catch (err) {
    // Clear timeout on error
    const deviceWithTimeout = devices.get(id);
    if (deviceWithTimeout?.connectionTimeoutId) {
      clearTimeout(deviceWithTimeout.connectionTimeoutId);
    }
    
    const errorMsg = String(err);
    const now = Date.now();
    // Update connection status to error in unified storage
    const errorDevice = devices.get(id) || {};
    devices.set(id, {
      ...errorDevice,
      connectionStatus: 'error',
      connectionTimestamp: now,
      connectionError: errorMsg,
      lastConnectionError: errorMsg,
      lastConnectionErrorTimestamp: now,
      connectionTimeoutId: null // Clear timeout ID
    });
    
    logger.error(TAG.CONNECT, `Connect failed for id=${id}: ${errorMsg}`);
    wsBroadcast({ type: 'connect', data: { id, status: 'error', error: errorMsg, ts: now } });
    res.status(500).json({ ok: false, error: errorMsg });
  }
});

// REST: disconnect from a specific device
app.post('/disconnect/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  const connectedDevice = connectedDevices.get(id);
  
  if (!connectedDevice) {
    res.status(404).json({ ok: false, error: 'Device not connected' });
    return;
  }
  
  try {
    const { peripheral } = connectedDevice;
    await peripheral.disconnectAsync();
    connectedDevices.delete(id);
    
    // Clear any pending timeout for this device
    const disconnectDevice = devices.get(id);
    if (disconnectDevice?.connectionTimeoutId) {
      clearTimeout(disconnectDevice.connectionTimeoutId);
    }
    
    // Update connection status to disconnected (manual disconnect) in unified storage
    const now = Date.now();
    devices.set(id, {
      ...disconnectDevice,
      connected: false,
      connectionStatus: 'disconnected',
      connectionTimestamp: now,
      connectionError: 'manual disconnect',
      connectionTimeoutId: null // Clear timeout ID
      // Keep lastConnectionError if it exists
    });
    
    wsBroadcast({ type: 'disconnected', data: { id, ts: Date.now() } });
    logger.info(TAG.CONNECT, `Disconnected from id=${chalk.white(id)}`);
    
    res.json({ ok: true });
  } catch (err) {
    logger.error(TAG.CONNECT, `Disconnect failed for id=${id}: ${String(err)}`);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// REST: manually resume/start scanning after it was paused (e.g., after modal closed)
app.post('/scan/start', async (req, res) => {
  if (noble.state !== 'poweredOn') {
    res.status(400).json({ ok: false, error: `Adapter state is ${noble.state}` });
    return;
  }
  try {
    await noble.startScanningAsync([], ALLOW_DUPLICATES);
    scanningActive = true;
    logger.info(TAG.SCAN, `BLE scan started (manual resume)`);
    wsBroadcast({ type: 'scan', data: { active: true, ts: Date.now(), reason: 'manual_resume' } });
    res.json({ ok: true });
  } catch (err) {
    logger.error(TAG.SCAN, `Failed to start scanning (manual): ${String(err)}`);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// SSE stream that emits BLE advertisements to all clients
app.get('/events', (req, res) => {
  // Keep connection open for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial comment to establish stream (useful for some proxies)
  res.write(': ok\n\n');
  // Register client
  sseClients.add(res);
  // Send recent buffer to new client
  for (const ev of lastEvents) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  // Cleanup on client disconnect
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// WebSocket: stream advertisements and allow snapshot on connect
wss.on('connection', (ws, req) => {
  // send snapshot of known devices on new connection
  const list = Array.from(devices.values()).sort(compareDevicesByNameUnnamedLast);
  try {
    ws.send(JSON.stringify({ type: 'snapshot', data: { ts: Date.now(), devices: list, scanningActive } }));
  } catch (_) {}
});

async function startScan() {
  // Optional: report all HCI events even without scan response
  // Use: NOBLE_REPORT_ALL_HCI_EVENTS=1 node server.js
  noble.on('stateChange', async (state) => {
    if (state === 'poweredOn') {
      try {
        await noble.startScanningAsync([], ALLOW_DUPLICATES); // duplicates for telemetry
        logger.info(TAG.SCAN, `BLE scan started (duplicates ${ALLOW_DUPLICATES ? 'ON' : 'OFF'})`);
        scanningActive = true;
        wsBroadcast({ type: 'scan', data: { active: true, ts: Date.now(), reason: 'poweredOn' } });
      } catch (err) {
        logger.error(TAG.SCAN, `Failed to start scanning: ${chalk.red(String(err))}`);
      }
    } else {
      try {
        await noble.stopScanningAsync();
      } catch (e) {
        // ignore
      }
      scanningActive = false;
      wsBroadcast({ type: 'scan', data: { active: false, ts: Date.now(), reason: 'stateChange:' + state } });
    }
  });

  // If adapter is already poweredOn by the time we attach the listener, start scanning immediately
  if (noble.state === 'poweredOn') {
    try {
      await noble.startScanningAsync([], ALLOW_DUPLICATES);
      logger.info(TAG.SCAN, `BLE scan started (duplicates ${ALLOW_DUPLICATES ? 'ON' : 'OFF'})`);
      scanningActive = true;
      wsBroadcast({ type: 'scan', data: { active: true, ts: Date.now(), reason: 'initial' } });
    } catch (err) {
      logger.error(TAG.SCAN, `Failed to start scanning (initial): ${chalk.red(String(err))}`);
    }
  }

  // Single global discover handler with optional filtering and diagnostics
  let discoveredCount = 0;
  let lastEventTs = 0;
  noble.on('discover', (peripheral) => {
    const adv = peripheral.advertisement || {};
    const rssi = peripheral.rssi;
    if (Number.isFinite(FILTER_MIN_RSSI) && typeof rssi === 'number' && rssi < FILTER_MIN_RSSI) {
      return; // filter by RSSI if configured
    }
    // update device registry - preserve existing connection data
    const existingDevice = devices.get(peripheral.id) || {};
    const info = {
      id: peripheral.id,
      address: peripheral.address,
      localName: adv.localName || null,
      lastRssi: rssi,
      lastSeen: Date.now(),
      serviceUuids: adv.serviceUuids || [],
      manufacturerDataHex: adv.manufacturerData ? adv.manufacturerData.toString('hex') : null,
      // Preserve existing connection data
      connected: existingDevice.connected || false,
      connectionStatus: existingDevice.connectionStatus || null,
      connectionTimestamp: existingDevice.connectionTimestamp || null,
      connectionError: existingDevice.connectionError || null,
      lastConnectionError: existingDevice.lastConnectionError || null,
      lastConnectionErrorTimestamp: existingDevice.lastConnectionErrorTimestamp || null,
      connectionTimeoutId: existingDevice.connectionTimeoutId || null,
    };
    // store peripheral reference for potential connect operation
    peripherals.set(peripheral.id, peripheral);
    const isNew = !devices.has(peripheral.id);
    devices.set(peripheral.id, info);
    if (isNew) {
      logger.info(
        TAG.NEW,
        `id=${chalk.white(info.id)} addr=${chalk.white(info.address || '-')}` +
          ` rssi=${colorRssi(info.lastRssi)} name=${displayName(info.localName)}`
      );
    }
    const payload = {
      ts: Date.now(),
      id: peripheral.id,
      address: peripheral.address,
      rssi,
      localName: adv.localName || null,
      serviceUuids: adv.serviceUuids || [],
      manufacturerData: adv.manufacturerData ? adv.manufacturerData.toString('hex') : null,
      serviceData: (adv.serviceData || []).map(({ uuid, data }) => ({ uuid, data: data.toString('hex') })),
    };
    pushEvent(payload);
    discoveredCount += 1;
    lastEventTs = Date.now();
    // light console diagnostics (every 50 events)
    if (discoveredCount % 50 === 0) {
      logger.debug(
        TAG.DISCOVER,
        `events=${discoveredCount}, last ${colorRssi(rssi)}, name=${displayName(payload.localName)}`
      );
    }
  });

  // Periodic warning if nothing arrives
  setInterval(() => {
    // warn only when scanning is active; otherwise user may be connecting or scanning paused intentionally
    if (scanningActive && (!lastEventTs || (Date.now() - lastEventTs > 15000))) {
      logger.warn(
        TAG.ALERT,
        'No BLE advertisements received in the last 15s. On macOS ensure Bluetooth permission for your terminal/editor (Privacy > Bluetooth), Bluetooth is ON, and no other BLE-heavy apps are blocking. Try toggling Bluetooth.'
      );
    }
  }, 15000);

  // Periodic devices summary to console
  setInterval(() => {
    if (devices.size === 0) return;
    const list = Array.from(devices.values())
      .sort(compareDevicesByNameUnnamedLast)
      .slice(0, SUMMARY_MAX_ROWS);

    const table = new Table({ head: ['RSSI', 'Name', 'ID', 'Addr'], style: { compact: true } });
    for (const d of list) {
      table.push([
        colorRssi(d.lastRssi),
        displayName(d.localName),
        chalk.white(shortId(d.id)),
        chalk.white(d.address || '-')
      ]);
    }
    logger.info(TAG.SUMMARY, `devices=${devices.size}\n${table.toString()}`);
  }, SUMMARY_INTERVAL_MS);
}

server.listen(PORT, () => {
  logger.info(TAG.HTTP, `HTTP :${PORT} | SSE /events | WS /ws`);
  startScan();
});


