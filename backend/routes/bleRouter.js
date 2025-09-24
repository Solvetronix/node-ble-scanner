const express = require('express');
const router = express.Router();
const useBluez = String(process.env.USE_BLUEZ || '0') === '1';
const { listDevices, connect, disconnect } = useBluez
  ? require('../controllers/bleControllerBluez')
  : require('../controllers/bleController');
const { startScanManual, stopScanManual } = require('../services/bleService');
const { startScan: startScanBluez, stopScan: stopScanBluez } = require('../services/bleServiceBluez');

router.get('/devices', listDevices);
router.post('/connect/:id', connect);
router.post('/disconnect/:id', disconnect);
// Fire-and-forget to avoid pending HTTP if BlueZ takes long
router.post('/scan/start', (req, res) => {
  try {
    if (useBluez) { startScanBluez().catch(() => {}); } else { startScanManual(true).catch(() => {}); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
router.post('/scan/stop', (req, res) => {
  try {
    if (useBluez) { stopScanBluez().catch(() => {}); } else { stopScanManual().catch(() => {}); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Quick status endpoint
router.get('/scan/status', (req, res) => {
  try {
    const list = require('../services/bleService').getDevicesList?.() || [];
    res.json({ ok: true, scanningActive: useBluez ? require('../services/bleServiceBluez').getScanningActive() : require('../services/bleService').getScanningActive(), count: list.length, ts: Date.now() });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

module.exports = router;


