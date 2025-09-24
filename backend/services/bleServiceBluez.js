const { wsBroadcast, pushEvent } = require('../realtime');
const dbus = require('dbus-next');

// Simple BlueZ D-Bus helper using dbus-next to perform discovery and connect
// NOTE: Minimal viable functionality to mirror current API surface

const devicesState = [];
let scanningActive = false;

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

    // Prime state with already known devices so UI gets immediate snapshot
    for (const [path, ifaces] of Object.entries(managed)) {
      const dev = ifaces && ifaces['org.bluez.Device1'];
      if (!dev) continue;
      const id = String(path.split('/').pop());
      const name = (dev.Name || dev.Alias || null);
      const addr = dev.Address || null;
      const rssi = typeof dev.RSSI === 'number' ? dev.RSSI : null;
      setDevice(id, {
        id,
        address: addr,
        localName: name,
        lastRssi: rssi,
        lastSeen: Date.now(),
        serviceUuids: Array.isArray(dev.UUIDs) ? dev.UUIDs : [],
        manufacturerDataHex: null,
        connected: !!dev.Connected,
        connectionStatus: dev.Connected ? 'connected' : null,
      });
      pushEvent({
        ts: Date.now(),
        id,
        address: addr,
        rssi,
        localName: name,
        serviceUuids: Array.isArray(dev.UUIDs) ? dev.UUIDs : [],
        manufacturerData: null,
        serviceData: [],
      });
    }

    // Listen for new devices via ObjectManager signal using dbus-next interface events
    objManager.on('InterfacesAdded', (path, ifaces) => {
      if (!ifaces || !ifaces['org.bluez.Device1']) return;
      const dev = ifaces['org.bluez.Device1'];
      const id = String(path.split('/').pop());
      const name = (dev.Name || dev.Alias || null);
      const addr = dev.Address || null;
      const rssi = typeof dev.RSSI === 'number' ? dev.RSSI : null;
      setDevice(id, {
        id,
        address: addr,
        localName: name,
        lastRssi: rssi,
        lastSeen: Date.now(),
        serviceUuids: Array.isArray(dev.UUIDs) ? dev.UUIDs : [],
        manufacturerDataHex: null,
        connected: !!dev.Connected,
        connectionStatus: dev.Connected ? 'connected' : null,
      });
      pushEvent({
        ts: Date.now(),
        id,
        address: addr,
        rssi,
        localName: name,
        serviceUuids: Array.isArray(dev.UUIDs) ? dev.UUIDs : [],
        manufacturerData: null,
        serviceData: [],
      });
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


