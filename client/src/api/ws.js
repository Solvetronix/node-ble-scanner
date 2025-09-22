export function useWebSocket(url, onMessage, onStatus){
  const wsRef = { current: null }
  let stopped = false
  function connect(){
    if (stopped) return
    try { if (wsRef.current) wsRef.current.close() } catch {}
    onStatus && onStatus('connecting')
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => onStatus && onStatus('open')
    ws.onclose = () => onStatus && onStatus('closed')
    ws.onerror = () => onStatus && onStatus('error')
    ws.onmessage = (e) => { try { onMessage && onMessage(JSON.parse(e.data)) } catch {} }
  }
  return { connect, stop: () => { stopped = true; try { wsRef.current?.close() } catch {} } }
}


