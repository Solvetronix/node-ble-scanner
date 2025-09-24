const BASE_URL = 'http://192.168.88.103:3000'

export const API_BASE_URL = BASE_URL

function apiUrl(path) {
  // ensure single slash join
  return BASE_URL.replace(/\/$/, '') + path
}

export function post(path) {
  // perform POST request to remote backend
  return fetch(apiUrl(path), { method: 'POST' })
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


