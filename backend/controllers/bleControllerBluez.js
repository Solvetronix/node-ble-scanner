const dbus = require('dbus-next');
const { wsBroadcast } = require('../realtime');
const { getDevicesList, setDevice } = require('../services/bleServiceBluez');

// Keep simple in-memory map of connected devices (BlueZ proxies and details)
const connectedMap = new Map(); // id -> { deviceObj, deviceIf, charIfaces: Map<charPath, iface> }

function unwrap(v) {
  if (v && typeof v === 'object' && 'signature' in v && 'value' in v) return v.value;
  return v;
}

function unwrapDeviceProps(devProps) {
  const address = unwrap(devProps.Address) || null;
  const localName = unwrap(devProps.Name) || unwrap(devProps.Alias) || null;
  const rssiRaw = unwrap(devProps.RSSI);
  const rssi = typeof rssiRaw === 'number' ? rssiRaw : null;
  const uuidsRaw = unwrap(devProps.UUIDs);
  const serviceUuids = Array.isArray(uuidsRaw) ? uuidsRaw.map(unwrap) : [];
  return { address, localName, rssi, serviceUuids };
}

async function getBluezAndManaged() {
  const bus = dbus.systemBus();
  const root = await bus.getProxyObject('org.bluez', '/');
  const objMgr = root.getInterface('org.freedesktop.DBus.ObjectManager');
  const managed = await objMgr.GetManagedObjects();
  return { bus, managed };
}

function findDevicePathById(managed, id) {
  const suffix = '/' + String(id);
  const paths = Object.keys(managed).filter(p => p.endsWith(suffix) && managed[p]['org.bluez.Device1']);
  return paths.length ? paths[0] : null;
}

async function listDevices(req, res) {
  const list = getDevicesList().map(d => ({ ...d }));
  res.json({ ts: Date.now(), count: list.length, devices: list });
}

async function connect(req, res) {
  const id = String(req.params.id || '').trim();
  const { bus, managed } = await getBluezAndManaged();
  const devPath = findDevicePathById(managed, id);
  if (!devPath) {
    res.status(404).json({ ok: false, error: 'Device not found' });
    return;
  }

  // Optimistic state update and broadcast
  setDevice(id, { id, connectionStatus: 'connecting', connectionTimestamp: Date.now(), connectionError: null });
  wsBroadcast({ type: 'connect', data: { id, status: 'starting', ts: Date.now() } });

  async function awaitConnected(timeoutMs = 15000) {
    const devObj = await bus.getProxyObject('org.bluez', devPath);
    const propsIf = devObj.getInterface('org.freedesktop.DBus.Properties');
    const start = Date.now();
    return await new Promise((resolve, reject) => {
      let resolved = false;
      const onChange = (iface, changed) => {
        if (iface !== 'org.bluez.Device1' || resolved) return;
        const connected = typeof changed.Connected !== 'undefined' ? !!(changed.Connected.value ?? changed.Connected) : undefined;
        const servicesResolved = typeof changed.ServicesResolved !== 'undefined' ? !!(changed.ServicesResolved.value ?? changed.ServicesResolved) : undefined;
        if (connected === true || servicesResolved === true) {
          resolved = true;
          cleanup();
          resolve(true);
        }
      };
      const cleanup = () => { try { propsIf.off('PropertiesChanged', onChange); } catch(_) {} };
      try { propsIf.on('PropertiesChanged', onChange); } catch(_) {}
      const t = setInterval(async () => {
        if (Date.now() - start > timeoutMs) {
          clearInterval(t);
          cleanup();
          return reject(new Error('Connect timeout'));
        }
        try {
          const connectedVar = await propsIf.Get('org.bluez.Device1', 'Connected');
          const srVar = await propsIf.Get('org.bluez.Device1', 'ServicesResolved');
          const connected = !!(connectedVar.value ?? connectedVar);
          const servicesResolved = !!(srVar.value ?? srVar);
          if (connected || servicesResolved) {
            clearInterval(t);
            cleanup();
            return resolve(true);
          }
        } catch(_) {}
      }, 300);
    });
  }

  try {
    const devObj = await bus.getProxyObject('org.bluez', devPath);
    const devIf = devObj.getInterface('org.bluez.Device1');

    // Retry strategy for transient "le-connection-abort-by-local"
    let attempt = 0;
    const maxAttempts = 3;
    // Ensure we listen for later disconnects
    const propsIf = devObj.getInterface('org.freedesktop.DBus.Properties');
    try {
      propsIf.on('PropertiesChanged', (iface, changed) => {
        if (iface !== 'org.bluez.Device1') return;
        const isConnected = typeof changed.Connected !== 'undefined' ? !!(changed.Connected.value ?? changed.Connected) : undefined;
        if (isConnected === false) {
          const now = Date.now();
          setDevice(id, { id, connected: false, connectionStatus: 'disconnected', connectionTimestamp: now, connectionError: 'automatic disconnect' });
          wsBroadcast({ type: 'disconnected', data: { id, ts: now, reason: 'automatic' } });
        }
      });
    } catch(_) {}

    // Try connect
    while (true) {
      try {
        await devIf.Connect();
        await awaitConnected(15000);
        break;
      } catch (err) {
        const msg = String(err || '');
        attempt += 1;
        if (attempt >= maxAttempts || !/le-connection-abort-by-local/i.test(msg)) {
          throw err;
        }
        // small delay and retry
        await new Promise(r => setTimeout(r, 700));
      }
    }

    // Discover characteristics under this device path
    const { managed: managed2 } = await getBluezAndManaged();
    const charPaths = Object.keys(managed2).filter(p => p.startsWith(devPath + '/') && managed2[p]['org.bluez.GattCharacteristic1']);

    const charIfaces = new Map();
    for (const cp of charPaths) {
      try {
        const chObj = await bus.getProxyObject('org.bluez', cp);
        const chIf = chObj.getInterface('org.bluez.GattCharacteristic1');
        charIfaces.set(cp, chIf);

        // If characteristic supports notify/indicate, try StartNotify
        const propsIf = chObj.getInterface('org.freedesktop.DBus.Properties');
        const flagsRaw = (managed2[cp]['org.bluez.GattCharacteristic1'].Flags) || [];
        const flags = Array.isArray(flagsRaw) ? flagsRaw.map(unwrap) : [];
        if (Array.isArray(flags) && (flags.includes('notify') || flags.includes('indicate'))) {
          try { await chIf.StartNotify(); } catch (_) {}
          // Listen for Value changes
          propsIf.on('PropertiesChanged', (iface, changed) => {
            if (iface !== 'org.bluez.GattCharacteristic1') return;
            if (!changed || !('Value' in changed)) return;
            try {
              const val = unwrap(changed.Value); // array of bytes
              const hex = Array.isArray(val) ? Buffer.from(val).toString('hex') : null;
              const uuid = unwrap(managed2[cp]['org.bluez.GattCharacteristic1'].UUID) || '';
              wsBroadcast({ type: 'notify', data: { id, charUuid: uuid, data: hex, ts: Date.now() } });
            } catch (_) {}
          });
        }
      } catch (_) {}
    }

    connectedMap.set(id, { deviceObj: devObj, deviceIf: devIf, charIfaces });

    // Update device details for snapshot
    const devProps = managed2[devPath]['org.bluez.Device1'] || {};
    const un = unwrapDeviceProps(devProps);
    const details = {
      id,
      address: un.address,
      localName: un.localName,
      rssi: un.rssi,
      serviceUuids: un.serviceUuids,
      manufacturerDataHex: null,
      connectedAt: Date.now(),
      services: [],
      characteristics: [],
    };

    setDevice(id, {
      id,
      address: details.address,
      localName: details.localName,
      lastRssi: details.rssi,
      lastSeen: Date.now(),
      serviceUuids: details.serviceUuids,
      manufacturerDataHex: null,
      connected: true,
      connectionStatus: 'connected',
      connectionTimestamp: Date.now(),
      connectionError: null,
    });

    wsBroadcast({ type: 'connected', data: details });
    wsBroadcast({ type: 'connect', data: { id, status: 'success', ts: Date.now() } });
    res.json({ ok: true, device: details });
  } catch (err) {
    const errorMsg = String(err);
    setDevice(id, { id, connectionStatus: 'error', connectionTimestamp: Date.now(), connectionError: errorMsg, lastConnectionError: errorMsg, lastConnectionErrorTimestamp: Date.now() });
    wsBroadcast({ type: 'connect', data: { id, status: 'error', error: errorMsg, ts: Date.now() } });
    res.status(500).json({ ok: false, error: errorMsg });
  }
}

async function disconnect(req, res) {
  const id = String(req.params.id || '').trim();
  const entry = connectedMap.get(id);
  if (!entry) {
    res.status(404).json({ ok: false, error: 'Device not connected' });
    return;
  }
  try {
    await entry.deviceIf.Disconnect();
    connectedMap.delete(id);
    setDevice(id, { id, connected: false, connectionStatus: 'disconnected', connectionTimestamp: Date.now(), connectionError: 'manual disconnect' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}

module.exports = { listDevices, connect, disconnect };


