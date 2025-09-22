export function post(path) {
  return fetch(path, { method: 'POST' })
}

export function connectDevice(id) {
  return post('/connect/' + encodeURIComponent(id))
}

export function disconnectDevice(id) {
  return post('/disconnect/' + encodeURIComponent(id))
}

export function startScan() {
  return post('/scan/start')
}

export function stopScan() {
  return post('/scan/stop')
}


