const { wsBroadcast, pushEvent } = require('../realtime');
const dbus = require('dbus-next');

// Simple BlueZ D-Bus helper using dbus-next to perform discovery and connect
// NOTE: Minimal viable functionality to mirror current API surface

const devicesState = [];
let scanningActive = false;
const deviceListeners = new Set(); // track device paths with attached listeners

function getDeviceIndex(id) {
  return devicesState.findIndex(d => d && d.id === id);
}

function setDevice(id, data) {
  const idx = getDeviceIndex(id);
  if (idx >= 0) devicesState[idx] = { ...devicesState[idx], ...data };
  else devicesState.push({ id, ...data });
}

function getDevicesList() {
  return devicesState.slice();
}

function getScanningActive() {
  return scanningActive;
}

function unwrap(v) {
  if (v && typeof v === 'object' && 'signature' in v && 'value' in v) return v.value;
  return v;
}

function unwrapDeviceProps(dev) {
  let name = unwrap(dev.Name) || unwrap(dev.Alias) || null;
  const addr = unwrap(dev.Address) || null;
  const rssiRaw = unwrap(dev.RSSI);
  const rssi = typeof rssiRaw === 'number' ? rssiRaw : null;
  const uuidsRaw = unwrap(dev.UUIDs);
  const uuids = Array.isArray(uuidsRaw) ? uuidsRaw.map(unwrap) : [];
  const connected = !!unwrap(dev.Connected);
  // If BlueZ reports address-like string as name, drop it (it's not a human-friendly name)
  const macLike = /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i;
  const macHyphen = /^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i;
  if (name && (macLike.test(name) || macHyphen.test(name))) name = null;
  return { name, addr, rssi, uuids, connected };
}

async function startScan() {
  // Best-effort discovery using BlueZ Adapter1.StartDiscovery via D-Bus
  try {
    const systemBus = dbus.systemBus();
    const bluez = await systemBus.getProxyObject('org.bluez', '/');
    // Find first adapter path by introspecting
    const objManager = bluez.getInterface('org.freedesktop.DBus.ObjectManager');
    const managed = await objManager.GetManagedObjects();
    const adapterPath = Object.keys(managed).find(p => managed[p]['org.bluez.Adapter1']);
    if (!adapterPath) throw new Error('No Bluetooth adapter found');
    const adapterObj = await systemBus.getProxyObject('org.bluez', adapterPath);
    const adapter = adapterObj.getInterface('org.bluez.Adapter1');
    // Hint BlueZ to perform LE discovery with duplicate data to receive scan responses (names)
    try {
      const Variant = dbus.Variant;
      const filter = {
        Transport: new Variant('s', 'le'),
        DuplicateData: new Variant('b', true),
      };
      await adapter.SetDiscoveryFilter(filter);
    } catch (_) {}

    // Prime state with already known devices so UI gets immediate snapshot
    async function attachDeviceListener(path) {
      if (deviceListeners.has(path)) return;
      try {
        const devObj = await systemBus.getProxyObject('org.bluez', path);
        const propsIf = devObj.getInterface('org.freedesktop.DBus.Properties');
        propsIf.on('PropertiesChanged', (iface, changed) => {
          if (iface !== 'org.bluez.Device1') return;
          try {
            const id = String(path.split('/').pop());
            const name = unwrap(changed.Name) || unwrap(changed.Alias) || undefined;
            const addr = unwrap(changed.Address) || undefined;
            const rssiRaw = unwrap(changed.RSSI);
            const rssi = (typeof rssiRaw === 'number') ? rssiRaw : undefined;
            const uuidsRaw = unwrap(changed.UUIDs);
            const uuids = Array.isArray(uuidsRaw) ? uuidsRaw.map(unwrap) : undefined;
            const connected = (typeof changed.Connected !== 'undefined') ? !!unwrap(changed.Connected) : undefined;

            const update = { id };
            if (typeof addr !== 'undefined') update.address = addr;
            if (typeof name !== 'undefined') update.localName = name;
            if (typeof rssi !== 'undefined') update.lastRssi = rssi;
            update.lastSeen = Date.now();
            if (typeof uuids !== 'undefined') update.serviceUuids = uuids;
            if (typeof connected !== 'undefined') {
              update.connected = connected;
              update.connectionStatus = connected ? 'connected' : null;
            }
            setDevice(id, update);

            // Emit advertisement-like event for UI updates when meaningful fields change
            pushEvent({
              ts: Date.now(),
              id,
              address: update.address,
              rssi: update.lastRssi,
              localName: update.localName,
              serviceUuids: update.serviceUuids || [],
              manufacturerData: null,
              serviceData: [],
            });
          } catch (_) {}
        });
        deviceListeners.add(path);
      } catch (_) {}
    }

    for (const [path, ifaces] of Object.entries(managed)) {
      const dev = ifaces && ifaces['org.bluez.Device1'];
      if (!dev) continue;
      const id = String(path.split('/').pop());
      const { name, addr, rssi, uuids, connected } = unwrapDeviceProps(dev);
      setDevice(id, {
        id,
        address: addr,
        localName: name,
        lastRssi: rssi,
        lastSeen: Date.now(),
        serviceUuids: uuids,
        manufacturerDataHex: null,
        connected,
        connectionStatus: connected ? 'connected' : null,
      });
      pushEvent({
        ts: Date.now(),
        id,
        address: addr,
        rssi,
        localName: name,
        serviceUuids: uuids,
        manufacturerData: null,
        serviceData: [],
      });

      // Attach listener for runtime updates
      await attachDeviceListener(path);
    }

    // Listen for new devices via ObjectManager signal using dbus-next interface events
    objManager.on('InterfacesAdded', async (path, ifaces) => {
      if (!ifaces || !ifaces['org.bluez.Device1']) return;
      const dev = ifaces['org.bluez.Device1'];
      const id = String(path.split('/').pop());
      const { name, addr, rssi, uuids, connected } = unwrapDeviceProps(dev);
      setDevice(id, {
        id,
        address: addr,
        localName: name,
        lastRssi: rssi,
        lastSeen: Date.now(),
        serviceUuids: uuids,
        manufacturerDataHex: null,
        connected,
        connectionStatus: connected ? 'connected' : null,
      });
      pushEvent({
        ts: Date.now(),
        id,
        address: addr,
        rssi,
        localName: name,
        serviceUuids: uuids,
        manufacturerData: null,
        serviceData: [],
      });

      // Attach listener for subsequent updates
      await attachDeviceListener(path);
    });

    await adapter.StartDiscovery();
    scanningActive = true;
    wsBroadcast({ type: 'scan', data: { active: true, ts: Date.now(), reason: 'bluez:start' } });
    return true;
  } catch (err) {
    console.error('[bluez] startScan failed:', err);
    return false;
  }
}

module.exports = {
  startScan,
  getDevicesList,
  getScanningActive,
  setDevice,
};


