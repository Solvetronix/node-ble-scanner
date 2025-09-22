const {
  getDevicesList,
  getPeripheral,
  getDevice,
  setDevice,
  setConnected,
  getConnected,
  deleteConnected,
} = require('../services/bleService');
const { wsBroadcast } = require('../realtime');

async function listDevices(req, res) {
  const list = getDevicesList().map(d => ({ ...d, peripheral: undefined }));
  res.json({ ts: Date.now(), count: list.length, devices: list });
}

async function connect(req, res) {
  const id = String(req.params.id || '').trim();
  const peripheral = getPeripheral(id);
  if (!peripheral) {
    res.status(404).json({ ok: false, error: 'Device not found or not in range' });
    return;
  }
  try {
    if (getConnected(id)) {
      res.status(400).json({ ok: false, error: 'Device already connected' });
      return;
    }
  const current = getDevice(id) || {};
  setDevice(id, { ...current, id, connectionStatus: 'connecting', connectionTimestamp: Date.now(), connectionError: null });
    wsBroadcast({ type: 'connect', data: { id, status: 'starting', ts: Date.now() } });

    const timeoutId = setTimeout(() => {
      const d = getDevice(id);
      if (d?.connectionStatus === 'connecting') {
        const now = Date.now();
        setDevice(id, { ...d, connectionStatus: 'error', connectionTimestamp: now, connectionError: 'Connection timeout (20s)', lastConnectionError: 'Connection timeout (20s)', lastConnectionErrorTimestamp: now, connectionTimeoutId: null });
        wsBroadcast({ type: 'connect', data: { id, status: 'error', error: 'Connection timeout (20s)', ts: now } });
      }
    }, 20000);
    setDevice(id, { ...(getDevice(id) || {}), connectionTimeoutId: timeoutId });

    await peripheral.connectAsync();
    const dwt = getDevice(id);
    if (dwt?.connectionTimeoutId) clearTimeout(dwt.connectionTimeoutId);

    peripheral.on('disconnect', () => {
      if (getConnected(id)) {
        deleteConnected(id);
        const dd = getDevice(id);
        if (dd?.connectionTimeoutId) clearTimeout(dd.connectionTimeoutId);
        const now = Date.now();
        setDevice(id, { ...dd, connected: false, connectionStatus: 'disconnected', connectionTimestamp: now, connectionError: 'automatic disconnect', connectionTimeoutId: null });
        wsBroadcast({ type: 'disconnected', data: { id, ts: now, reason: 'automatic' } });
      }
    });

    let connectedRssi = null;
    try { connectedRssi = await peripheral.updateRssiAsync(); } catch {}
    let services = [];
    let characteristics = [];
    try {
      const result = await peripheral.discoverAllServicesAndCharacteristicsAsync();
      services = (result.services || []).map(s => ({ uuid: s.uuid }));
      characteristics = (result.characteristics || []).map(c => ({ uuid: c.uuid, properties: c.properties || [] }));
      for (const ch of (result.characteristics || [])) {
        const props = ch.properties || [];
        if (props.includes('notify') || props.includes('indicate')) {
          try {
            ch.on('data', (buf) => {
              try { wsBroadcast({ type: 'notify', data: { id, charUuid: ch.uuid, data: buf ? buf.toString('hex') : null, ts: Date.now() } }); } catch {}
            });
            await new Promise((resolve) => ch.subscribe(() => resolve()));
          } catch {}
        }
      }
    } catch {}

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

    setConnected(peripheral.id, { peripheral, details, connectedAt: Date.now() });
    const successDevice = getDevice(peripheral.id) || {};
    setDevice(peripheral.id, {
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
      connectionTimeoutId: null,
      lastConnectionError: successDevice.lastConnectionError,
      lastConnectionErrorTimestamp: successDevice.lastConnectionErrorTimestamp,
    });
    wsBroadcast({ type: 'connected', data: details });
    wsBroadcast({ type: 'connect', data: { id, status: 'success', ts: Date.now() } });
    res.json({ ok: true, device: details });
  } catch (err) {
    const d = getDevice(id);
    if (d?.connectionTimeoutId) clearTimeout(d.connectionTimeoutId);
    const errorMsg = String(err);
    const now = Date.now();
    const ed = getDevice(id) || {};
    setDevice(id, { ...ed, connectionStatus: 'error', connectionTimestamp: now, connectionError: errorMsg, lastConnectionError: errorMsg, lastConnectionErrorTimestamp: now, connectionTimeoutId: null });
    wsBroadcast({ type: 'connect', data: { id, status: 'error', error: errorMsg, ts: now } });
    res.status(500).json({ ok: false, error: errorMsg });
  }
}

async function disconnect(req, res) {
  const id = String(req.params.id || '').trim();
  const found = getConnected(id);
  if (!found) {
    res.status(404).json({ ok: false, error: 'Device not connected' });
    return;
  }
  try {
    await found.peripheral.disconnectAsync();
    deleteConnected(id);
    const d = getDevice(id);
    if (d?.connectionTimeoutId) clearTimeout(d.connectionTimeoutId);
    const now = Date.now();
    setDevice(id, { ...d, connected: false, connectionStatus: 'disconnected', connectionTimestamp: now, connectionError: 'manual disconnect', connectionTimeoutId: null });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}

module.exports = { listDevices, connect, disconnect };


