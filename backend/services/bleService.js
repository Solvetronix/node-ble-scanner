const noble = require('@abandonware/noble');
const chalk = require('chalk');
const Table = require('cli-table3');
const { pushEvent, wsBroadcast } = require('../realtime');

// In-memory unified devices state kept as a single array
let devicesState = [];
const peripherals = new Map();
const connectedDevices = new Map();

let scanningActive = false;

const TAG = {
  SCAN: chalk.bgMagenta.white(' SCAN '),
  NEW: chalk.bgGreen.black(' NEW '),
  DISCOVER: chalk.bgCyan.black(' DISCOVER '),
  SUMMARY: chalk.bgGray.black(' SUMMARY '),
  ALERT: chalk.bgYellow.black(' ALERT '),
  ERROR: chalk.bgRed.white(' ERROR '),
  CONNECT: chalk.bgGreen.white(' CONNECT '),
};

function compareDevicesByNameUnnamedLast(a, b) {
  const nameA = ((a && a.localName) ? String(a.localName).trim() : '').toLowerCase();
  const nameB = ((b && b.localName) ? String(b.localName).trim() : '').toLowerCase();
  const hasA = nameA.length > 0;
  const hasB = nameB.length > 0;
  if (hasA && !hasB) return -1;
  if (!hasA && hasB) return 1;
  if (hasA && hasB) return nameA.localeCompare(nameB);
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

function getDeviceIndex(id) {
  return devicesState.findIndex(d => d && d.id === id);
}

function getDevice(id) {
  const idx = getDeviceIndex(id);
  return idx >= 0 ? devicesState[idx] : undefined;
}

function setDevice(id, data) {
  const idx = getDeviceIndex(id);
  if (idx >= 0) {
    devicesState[idx] = { ...devicesState[idx], ...data };
  } else {
    devicesState.push({ id, ...data });
  }
}

function getDevicesList() {
  return devicesState.slice();
}

async function startScan({ allowDuplicates = true, filterMinRssi = -200, summaryIntervalMs = 10000, summaryMaxRows = 50 } = {}) {
  noble.removeAllListeners('stateChange');
  noble.removeAllListeners('discover');

  noble.on('stateChange', async (state) => {
    if (state === 'poweredOn') {
      try {
        await noble.startScanningAsync([], allowDuplicates);
        scanningActive = true;
        wsBroadcast({ type: 'scan', data: { active: true, ts: Date.now(), reason: 'poweredOn' } });
      } catch (err) {
        console.error(TAG.SCAN, `Failed to start scanning: ${chalk.red(String(err))}`);
      }
    } else {
      try { await noble.stopScanningAsync(); } catch {}
      scanningActive = false;
      wsBroadcast({ type: 'scan', data: { active: false, ts: Date.now(), reason: 'stateChange:' + state } });
    }
  });

  if (noble.state === 'poweredOn') {
    try {
      await noble.startScanningAsync([], allowDuplicates);
      scanningActive = true;
      wsBroadcast({ type: 'scan', data: { active: true, ts: Date.now(), reason: 'initial' } });
    } catch (err) {
      console.error(TAG.SCAN, `Failed to start scanning (initial): ${chalk.red(String(err))}`);
    }
  }

  let discoveredCount = 0;
  let lastEventTs = 0;
  noble.on('discover', (peripheral) => {
    const adv = peripheral.advertisement || {};
    const rssi = peripheral.rssi;
    if (Number.isFinite(filterMinRssi) && typeof rssi === 'number' && rssi < filterMinRssi) {
      return;
    }
    const existingDevice = getDevice(peripheral.id) || {};
    const info = {
      id: peripheral.id,
      address: peripheral.address,
      localName: adv.localName || null,
      lastRssi: rssi,
      lastSeen: Date.now(),
      serviceUuids: adv.serviceUuids || [],
      manufacturerDataHex: adv.manufacturerData ? adv.manufacturerData.toString('hex') : null,
      connected: existingDevice.connected || false,
      connectionStatus: existingDevice.connectionStatus || null,
      connectionTimestamp: existingDevice.connectionTimestamp || null,
      connectionError: existingDevice.connectionError || null,
      lastConnectionError: existingDevice.lastConnectionError || null,
      lastConnectionErrorTimestamp: existingDevice.lastConnectionErrorTimestamp || null,
      connectionTimeoutId: existingDevice.connectionTimeoutId || null,
    };
    peripherals.set(peripheral.id, peripheral);
    const was = !!existingDevice.id;
    setDevice(peripheral.id, info);
    if (!was) {
      console.log(TAG.NEW, `id=${info.id} addr=${info.address || '-'} rssi=${colorRssi(info.lastRssi)} name=${displayName(info.localName)}`);
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
    if (discoveredCount % 50 === 0) {
      console.log(TAG.DISCOVER, `events=${discoveredCount}`);
    }
  });

  setInterval(() => {
    if (scanningActive && (!lastEventTs || (Date.now() - lastEventTs > 15000))) {
      console.warn(TAG.ALERT, 'No BLE advertisements received in the last 15s.');
    }
  }, 15000);

  setInterval(() => {
    if (devicesState.length === 0) return;
    const list = devicesState.slice().sort(compareDevicesByNameUnnamedLast).slice(0, 50);
    const table = new Table({ head: ['RSSI', 'Name', 'ID', 'Addr'], style: { compact: true } });
    for (const d of list) {
      table.push([colorRssi(d.lastRssi), displayName(d.localName), shortId(d.id), d.address || '-']);
    }
    console.log(TAG.SUMMARY, `devices=${devicesState.length}\n${table.toString()}`);
  }, 10000);

  return true;
}

async function startScanManual(allowDuplicates) {
  await noble.startScanningAsync([], allowDuplicates);
  scanningActive = true;
  wsBroadcast({ type: 'scan', data: { active: true, ts: Date.now(), reason: 'manual_resume' } });
}

async function stopScanManual() {
  await noble.stopScanningAsync();
  scanningActive = false;
  wsBroadcast({ type: 'scan', data: { active: false, ts: Date.now(), reason: 'manual_stop' } });
}

function getScanningActive() {
  return scanningActive;
}

function getPeripheral(id) {
  return peripherals.get(id);
}

function setConnected(id, payload) {
  connectedDevices.set(id, payload);
}

function getConnected(id) {
  return connectedDevices.get(id);
}

function deleteConnected(id) {
  connectedDevices.delete(id);
}

module.exports = {
  startScan,
  startScanManual,
  stopScanManual,
  getDevicesList,
  getScanningActive,
  getPeripheral,
  setDevice,
  getDevice,
  setConnected,
  getConnected,
  deleteConnected,
};


