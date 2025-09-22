import { useEffect, useMemo, useRef, useState } from 'react'
import './index.css'
import { Switch, FormControlLabel, Paper } from '@mui/material'
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

  useWebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws', (msg) => {
    if (msg?.type === 'snapshot') {
      setDevices(msg.data?.devices || [])
      setScanActive(!!msg.data?.scanningActive)
      return
    }
    if (msg?.type === 'adv') {
      setDevices((prev) => {
        const map = new Map(prev.map(d => [d.id, d]))
        const d = msg.data
        const updated = {
          id: d.id,
          address: d.address,
          localName: d.localName || null,
          lastRssi: d.rssi,
          lastSeen: d.ts,
          serviceUuids: d.serviceUuids || [],
          manufacturerDataHex: d.manufacturerData || null,
        }
        map.set(d.id, map.has(d.id) ? { ...map.get(d.id), ...updated } : updated)
        return Array.from(map.values())
      })
      return
    }
    if (msg?.type === 'scan') {
      setScanActive(!!msg.data?.active)
      return
    }
  })

  const onToggleScan = () => {
    const endpoint = scanActive ? '/scan/stop' : '/scan/start'
    fetch(endpoint, { method: 'POST' }).catch(() => {})
  }

  const rows = useMemo(() => devices, [devices])

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-800 text-2xl font-semibold">
            <BluetoothIcon /> BLE Devices
          </div>
          <div className="flex items-center gap-3">
            <FormControlLabel control={<Switch checked={extended} onChange={(e) => setExtended(e.target.checked)} />} label="Extended" />
            <IconActionButton title={scanActive ? 'Stop Scan' : 'Start Scan'} color={scanActive ? 'error' : 'success'} onClick={onToggleScan}>
              {scanActive ? <StopIcon /> : <PlayArrowIcon />}
            </IconActionButton>
          </div>
        </div>

        <Paper className="overflow-x-auto">
          <DevicesTable devices={rows} extended={extended} />
        </Paper>
      </div>
    </div>
  )
}

export default App
