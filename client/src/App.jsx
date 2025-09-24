import { useEffect, useMemo, useRef, useState } from 'react'
import './index.css'
import { Switch, FormControlLabel, Paper, Dialog, DialogTitle, DialogContent, DialogActions, Button } from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import StopIcon from '@mui/icons-material/Stop'
import BluetoothIcon from '@mui/icons-material/Bluetooth'
import IconActionButton from './ui/IconActionButton'
import DevicesTable from './components/DevicesTable'
import { startScan, stopScan } from './api/http'

function useWebSocket(url, onMessage) {
  const [status, setStatus] = useState('connecting')
  const wsRef = useRef(null)
  useEffect(() => {
    let stopped = false
    function connect() {
      if (stopped) return
      try { if (wsRef.current) wsRef.current.close() } catch {}
      setStatus('connecting')
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => setStatus('open')
      ws.onclose = () => setStatus('closed')
      ws.onerror = () => setStatus('error')
      ws.onmessage = (e) => {
        try { onMessage && onMessage(JSON.parse(e.data)) } catch {}
      }
    }
    connect()
    return () => { stopped = true; try { wsRef.current?.close() } catch {} }
  }, [url])
  return { status }
}

function App() {
  const [devices, setDevices] = useState([])
  const [scanActive, setScanActive] = useState(false)
  const [extended, setExtended] = useState(false)
  const [connectingSet, setConnectingSet] = useState(() => new Set())
  const [connectedSet, setConnectedSet] = useState(() => new Set())
  const [infoOpen, setInfoOpen] = useState(false)
  const [infoDeviceId, setInfoDeviceId] = useState(null)
  const [notifyLogsById, setNotifyLogsById] = useState(() => new Map())

  const { status: wsStatus } = useWebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws', (msg) => {
    if (msg?.type === 'snapshot') {
      const list = msg.data?.devices || []
      setDevices(list)
      // initialize connection state sets
      const initConnecting = new Set()
      const initConnected = new Set()
      for (const d of list) {
        if (d?.connectionStatus === 'connecting') initConnecting.add(d.id)
        if (d?.connected || d?.connectionStatus === 'connected') initConnected.add(d.id)
      }
      setConnectingSet(initConnecting)
      setConnectedSet(initConnected)
      setScanActive(!!msg.data?.scanningActive)
      return
    }
    if (msg?.type === 'adv') {
      setDevices((prev) => {
        const map = new Map(prev.map(d => [d.id, d]))
        const d = msg.data
        const prevD = map.get(d.id) || { id: d.id }
        const updated = {
          id: d.id,
          // keep previous address/name if incoming is empty/undefined
          address: d.address || prevD.address || null,
          localName: (typeof d.localName === 'string' && d.localName.trim().length > 0) ? d.localName : (prevD.localName || null),
          lastRssi: d.rssi,
          lastSeen: d.ts,
          serviceUuids: (Array.isArray(d.serviceUuids) && d.serviceUuids.length > 0) ? d.serviceUuids : (prevD.serviceUuids || []),
          manufacturerDataHex: (d.manufacturerData ? d.manufacturerData : (prevD.manufacturerDataHex || null)),
        }
        map.set(d.id, map.has(d.id) ? { ...prevD, ...updated } : updated)
        return Array.from(map.values())
      })
      return
    }
    if (msg?.type === 'scan') {
      setScanActive(!!msg.data?.active)
      return
    }
    if (msg?.type === 'connect') {
      const id = msg.data?.id
      const status = msg.data?.status
      if (!id) return
      if (status === 'starting') {
        setConnectingSet(prev => new Set([...prev, id]))
        setConnectedSet(prev => { const s = new Set(prev); s.delete(id); return s })
        setDevices(prev => prev.map(d => d.id === id ? { ...d, connectionStatus: 'connecting', connectionError: null } : d))
      } else if (status === 'success') {
        setConnectingSet(prev => { const s = new Set(prev); s.delete(id); return s })
        setConnectedSet(prev => new Set([...prev, id]))
        setDevices(prev => prev.map(d => d.id === id ? { ...d, connected: true, connectionStatus: 'connected', connectionError: null } : d))
      } else if (status === 'error') {
        setConnectingSet(prev => { const s = new Set(prev); s.delete(id); return s })
        setConnectedSet(prev => { const s = new Set(prev); s.delete(id); return s })
        const err = msg.data?.error || 'Connection failed'
        setDevices(prev => prev.map(d => d.id === id ? { ...d, connectionStatus: 'error', connectionError: err, lastConnectionError: err, lastConnectionErrorTimestamp: Date.now() } : d))
      }
      return
    }
    if (msg?.type === 'connected') {
      const det = msg.data || {}
      const id = det.id
      if (!id) return
      setConnectingSet(prev => { const s = new Set(prev); s.delete(id); return s })
      setConnectedSet(prev => new Set([...prev, id]))
      setDevices(prev => {
        const map = new Map(prev.map(d => [d.id, d]))
        const prevD = map.get(id) || { id }
        const merged = {
          ...prevD,
          id: det.id,
          address: det.address,
          localName: det.localName || prevD.localName || null,
          lastRssi: typeof det.rssi === 'number' ? det.rssi : prevD.lastRssi,
          lastSeen: Date.now(),
          serviceUuids: det.serviceUuids || prevD.serviceUuids || [],
          manufacturerDataHex: det.manufacturerDataHex || prevD.manufacturerDataHex || null,
          connected: true,
          connectionStatus: 'connected',
          connectionError: null,
          connectedAt: det.connectedAt || prevD.connectedAt || null,
          services: det.services || prevD.services || [],
          characteristics: det.characteristics || prevD.characteristics || [],
        }
        map.set(id, merged)
        return Array.from(map.values())
      })
      return
    }
    if (msg?.type === 'disconnected') {
      const id = msg.data?.id
      if (!id) return
      setConnectedSet(prev => { const s = new Set(prev); s.delete(id); return s })
      setConnectingSet(prev => { const s = new Set(prev); s.delete(id); return s })
      setDevices(prev => prev.map(d => d.id === id ? { ...d, connected: false, connectionStatus: 'disconnected' } : d))
      return
    }
    if (msg?.type === 'notify') {
      const id = msg.data?.id
      if (!id) return
      const now = msg.data?.ts || Date.now()
      const charUuid = msg.data?.charUuid || '-'
      const dataHex = msg.data?.data || ''
      const line = `${new Date(now).toLocaleString()} — ${charUuid}: ${dataHex}`
      setNotifyLogsById(prev => {
        const next = new Map(prev)
        const list = next.get(id) ? next.get(id).slice() : []
        list.unshift(line)
        // cap to last 300 lines per device
        next.set(id, list.slice(0, 300))
        return next
      })
      return
    }
  })

  const onToggleScan = () => {
    const endpoint = scanActive ? '/scan/stop' : '/scan/start'
    fetch(endpoint, { method: 'POST' }).catch(() => {})
  }

  const rows = useMemo(() => {
    const list = devices.slice()
    list.sort((a, b) => {
      const nameA = ((a && a.localName) ? String(a.localName).trim() : '').toLowerCase()
      const nameB = ((b && b.localName) ? String(b.localName).trim() : '').toLowerCase()
      const hasA = nameA.length > 0
      const hasB = nameB.length > 0
      if (hasA && !hasB) return -1
      if (!hasA && hasB) return 1
      if (hasA && hasB) return nameA.localeCompare(nameB)
      return 0
    })
    return list
  }, [devices])

  const onConnect = (id) => {
    // optimistic UI: mark as connecting until server updates
    setConnectingSet(prev => new Set([...prev, id]))
    fetch('/connect/' + encodeURIComponent(id), { method: 'POST' }).catch(() => {})
  }
  const onDisconnect = (id) => {
    fetch('/disconnect/' + encodeURIComponent(id), { method: 'POST' }).catch(() => {})
  }
  const onInfo = (id) => {
    setInfoDeviceId(id)
    setInfoOpen(true)
  }

  const selectedDevice = useMemo(() => rows.find(d => d.id === infoDeviceId) || null, [rows, infoDeviceId])
  const selectedLogs = useMemo(() => notifyLogsById.get(infoDeviceId) || [], [notifyLogsById, infoDeviceId])

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-800 text-2xl font-semibold">
            <BluetoothIcon color={wsStatus === 'open' ? 'success' : 'disabled'} /> BLE Devices
          </div>
          <div className="flex items-center gap-3">
            <FormControlLabel control={<Switch checked={extended} onChange={(e) => setExtended(e.target.checked)} />} label="Extended" />
            <IconActionButton title={scanActive ? 'Stop Scan' : 'Start Scan'} color={scanActive ? 'error' : 'success'} onClick={onToggleScan}>
              {scanActive ? <StopIcon /> : <PlayArrowIcon />}
            </IconActionButton>
          </div>
        </div>

        <Paper className="overflow-x-auto">
          <DevicesTable
            devices={rows}
            extended={extended}
            connectingSet={connectingSet}
            connectedSet={connectedSet}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onInfo={onInfo}
          />
        </Paper>

        <Dialog open={infoOpen} onClose={() => setInfoOpen(false)} maxWidth="md" fullWidth>
          <DialogTitle>Device info</DialogTitle>
          <DialogContent dividers>
            {selectedDevice ? (
              <div className="space-y-2">
                <div><b>Name:</b> {selectedDevice.localName || '-'}</div>
                <div><b>ID:</b> {selectedDevice.id}</div>
                <div><b>Address:</b> {selectedDevice.address || '-'}</div>
                <div><b>RSSI:</b> {typeof selectedDevice.lastRssi === 'number' ? selectedDevice.lastRssi : '-'}</div>
                <div><b>Services:</b> {(selectedDevice.services || []).map(s => s.uuid).join(', ') || '-'}</div>
                <div><b>Characteristics:</b> {(selectedDevice.characteristics || []).map(c => `${c.uuid} [${(c.properties || []).join(', ')}]`).join('; ') || '-'}</div>
                <div>
                  <b>Events:</b>
                  <div className="mt-2 max-h-64 overflow-auto text-sm text-slate-700 space-y-1">
                    {selectedLogs.length === 0 ? (
                      <div className="text-slate-400">No events</div>
                    ) : (
                      selectedLogs.map((ln, idx) => (
                        <div key={idx} className="whitespace-pre-wrap break-words">{ln}</div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div>No device selected</div>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setInfoOpen(false)}>Close</Button>
          </DialogActions>
        </Dialog>
      </div>
    </div>
  )
}

export default App
