const express = require('express');
const router = express.Router();
const useBluez = String(process.env.USE_BLUEZ || '0') === '1';
const { listDevices, connect, disconnect } = useBluez
  ? require('../controllers/bleControllerBluez')
  : require('../controllers/bleController');
const { startScanManual, stopScanManual } = require('../services/bleService');

router.get('/devices', listDevices);
router.post('/connect/:id', connect);
router.post('/disconnect/:id', disconnect);
router.post('/scan/start', async (req, res) => {
  try { await startScanManual(true); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
router.post('/scan/stop', async (req, res) => {
  try { await stopScanManual(); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

module.exports = router;


