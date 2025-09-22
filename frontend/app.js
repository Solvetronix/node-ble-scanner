(function(){
  // Simple React UI without JSX
  const e = React.createElement;

  function useWebSocket(url, onMessage){
    const [status, setStatus] = React.useState('connecting');
    const [reconnectIn, setReconnectIn] = React.useState(null);
    const wsRef = React.useRef(null);
    const timerRef = React.useRef({ interval: null });

    React.useEffect(() => {
      let stopped = false;

      function clearCountdown(){
        if (timerRef.current.interval) {
          clearInterval(timerRef.current.interval);
          timerRef.current.interval = null;
        }
        setReconnectIn(null);
      }

      function connect(){
        if (stopped) return;
        try { if (wsRef.current) wsRef.current.close(); } catch(_) {}
        setStatus('connecting');
        clearCountdown();
        const ws = new WebSocket(url);
        wsRef.current = ws;
        
        // 10 second connection timeout
        const connectTimeout = setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            ws.close();
            setStatus('timeout');
          }
        }, 10000);
        
        ws.addEventListener('open', () => {
          clearTimeout(connectTimeout);
          setStatus('open');
          clearCountdown();
        });
        ws.addEventListener('close', () => {
          clearTimeout(connectTimeout);
          setStatus('closed');
          clearCountdown();
          // start 10s countdown then reconnect
          let left = 10;
          setReconnectIn(left);
          timerRef.current.interval = setInterval(() => {
            left -= 1;
            if (left <= 0) {
              clearCountdown();
              connect();
            } else {
              setReconnectIn(left);
            }
          }, 1000);
        });
        ws.addEventListener('error', () => {
          clearTimeout(connectTimeout);
          setStatus('error');
        });
        ws.addEventListener('message', (evt) => {
          try { onMessage && onMessage(JSON.parse(evt.data)); } catch(_) {}
        });
      }

      connect();

      return () => {
        stopped = true;
        clearCountdown();
        try { if (wsRef.current) wsRef.current.close(); } catch(_) {}
      };
    }, [url]);

    return { status, reconnectIn };
  }

  // Shared RSSI color helper for UI (used in table and modal)
  function rssiColorClass(rssi){
    if (typeof rssi !== 'number') return 'text-slate-400';
    if (rssi >= -70) return 'text-green-600';
    if (rssi >= -85) return 'text-yellow-600';
    return 'text-red-600';
  }

  function DevicesTable(props = {}){
    const { extendedMode = false, onScanActiveChange } = props;
    const [devices, setDevices] = React.useState([]);
    const [total, setTotal] = React.useState(0);
    const [lastTs, setLastTs] = React.useState(null);
    const [modalOpen, setModalOpen] = React.useState(false);
    const [modalLoading, setModalLoading] = React.useState(false);
    const [selectedDevice, setSelectedDevice] = React.useState(null);
    const [connectingDevices, setConnectingDevices] = React.useState(new Set());
    const [connectedDevices, setConnectedDevices] = React.useState(new Set());

    // No RSSI-based sorting; optional smoothing kept for UI stability if needed
    const smoothMapRef = React.useRef(new Map());

    // comparator: named first by name asc; unnamed after without ordering
    function compareDevicesByNameUnnamedLast(a, b){
      const nameA = ((a && a.localName) ? String(a.localName).trim() : '').toLowerCase();
      const nameB = ((b && b.localName) ? String(b.localName).trim() : '').toLowerCase();
      const hasA = nameA.length > 0;
      const hasB = nameB.length > 0;
      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;
      if (hasA && hasB) return nameA.localeCompare(nameB);
      return 0; // both unnamed: keep current/insertion order
    }

    // Map RSSI to Tailwind text color similar to server console coloring
    function rssiColorClass(rssi){
      if (typeof rssi !== 'number') return 'text-slate-400';
      if (rssi >= -70) return 'text-green-600';
      if (rssi >= -85) return 'text-yellow-600';
      return 'text-red-600';
    }

    // Initial data will be loaded via WebSocket snapshot message

    const [scanActive, setScanActive] = React.useState(false);
    const [eventLog, setEventLog] = React.useState([]);
    const { status, reconnectIn } = useWebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws', (msg) => {
      if (msg && msg.type === 'snapshot') {
        const raw = (msg.data?.devices || []).slice();
        const list = raw.sort(compareDevicesByNameUnnamedLast);
        setDevices(list);
        setTotal(list.length);
        setLastTs(Date.now());
        const newScanActive = !!msg.data?.scanningActive;
        setScanActive(newScanActive);
        onScanActiveChange && onScanActiveChange(newScanActive);
        
        // Initialize connection states from server data
        const connected = new Set();
        const connecting = new Set();
        raw.forEach(device => {
          if (device.connectionStatus === 'connected' || device.connected) {
            connected.add(device.id);
          } else if (device.connectionStatus === 'connecting') {
            connecting.add(device.id);
          }
        });
        setConnectedDevices(connected);
        setConnectingDevices(connecting);
        return;
      }
      if (msg && msg.type === 'scan') {
        const newScanActive = !!msg.data?.active;
        setScanActive(newScanActive);
        onScanActiveChange && onScanActiveChange(newScanActive);
        setEventLog(prev => [{ ts: msg.data?.ts || Date.now(), text: `Scan ${msg.data?.active ? 'started' : 'stopped'} (${msg.data?.reason || ''})` }, ...prev].slice(0, 100));
        return;
      }
      if (msg && msg.type === 'connect') {
        const id = msg.data?.id || '-';
        const statusTxt = msg.data?.status || 'unknown';
        const extra = msg.data?.error ? `: ${msg.data.error}` : '';
        setEventLog(prev => [{ ts: msg.data?.ts || Date.now(), text: `Connect ${statusTxt} (${id})${extra}` }, ...prev].slice(0, 200));
        
        // Update connecting/connected states for button display
        if (statusTxt === 'starting') {
          setConnectingDevices(prev => new Set([...prev, id]));
          setConnectedDevices(prev => {
            const newSet = new Set(prev);
            newSet.delete(id);
            return newSet;
          });
        } else if (statusTxt === 'success') {
          setConnectingDevices(prev => {
            const newSet = new Set(prev);
            newSet.delete(id);
            return newSet;
          });
          setConnectedDevices(prev => new Set([...prev, id]));
        } else if (statusTxt === 'error') {
          setConnectingDevices(prev => {
            const newSet = new Set(prev);
            newSet.delete(id);
            return newSet;
          });
          // Immediately update device status in local state
          setDevices(prev => prev.map(device => 
            device.id === id 
              ? { 
                  ...device, 
                  connectionStatus: 'error',
                  connectionError: msg.data?.error || 'Connection failed',
                  lastConnectionError: msg.data?.error || 'Connection failed',
                  lastConnectionErrorTimestamp: msg.data?.ts || Date.now()
                }
              : device
          ));
        }
        
        // Modal is only opened via Info button, not during connection process
        return;
      }
      if (msg && msg.type === 'connected') {
        // Device connected - no modal auto-opening, just update button states
        return;
      }
      if (msg && msg.type === 'disconnected') {
        const id = msg.data?.id || '-';
        setConnectedDevices(prev => {
          const newSet = new Set(prev);
          newSet.delete(id);
          return newSet;
        });
        setConnectingDevices(prev => {
          const newSet = new Set(prev);
          newSet.delete(id);
          return newSet;
        });
        return;
      }
      if (msg && msg.type === 'notify') {
        // Append notify events to log and modal status
        const charUuid = msg.data?.charUuid || '-';
        const dataHex = msg.data?.data || '';
        setEventLog(prev => [{ ts: msg.data?.ts || Date.now(), text: `Notify ${charUuid}: ${dataHex}` }, ...prev].slice(0, 300));
        if (window.__modal) {
          const current = (window.__modal.getStatus && window.__modal.getStatus()) || '';
          const add = `${new Date(msg.data?.ts || Date.now()).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })} — ${charUuid}: ${dataHex}`;
          window.__modal.appendLog(add);
        }
        return;
      }
      if (msg && msg.type === 'adv') {
        const d = msg.data;
        setLastTs(d.ts || Date.now());
        setDevices(prev => {
          const map = new Map(prev.map(x => [x.id, x]));
          const existing = map.get(d.id);
          const updated = {
            id: d.id,
            address: d.address,
            localName: d.localName || null,
            lastRssi: d.rssi,
            lastSeen: d.ts,
            serviceUuids: d.serviceUuids || [],
            manufacturerDataHex: d.manufacturerData || null,
          };
          map.set(d.id, existing ? { ...existing, ...updated } : updated);
          const list = Array.from(map.values()).sort(compareDevicesByNameUnnamedLast);
          setTotal(list.length);
          return list;
        });
      }
    });

    React.useEffect(() => {
      const meta = document.getElementById('meta');
      if (!meta) return;
      const tsStr = lastTs ? new Date(lastTs).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
      // Choose color based on websocket status
      const statusColorClass = status === 'open'
        ? 'bg-green-500'
        : (status === 'connecting' ? 'bg-yellow-500' : 'bg-red-500');
      const countdownHtml = (status === 'closed' && typeof reconnectIn === 'number')
        ? `<span class="text-xs text-slate-500">reconnect in ${reconnectIn}s</span>`
        : '';
      const scanGear = `<span title="Scanning" class="material-icons align-middle text-base ${scanActive ? 'animate-spin' : ''}">${scanActive ? 'radar' : 'radar'}</span>`;
      meta.innerHTML = `
        <span class="inline-flex items-center gap-2">
          <span class="inline-block w-2.5 h-2.5 rounded-full ${statusColorClass}" title="WebSocket status: ${status}"></span>
          <span>ws: ${status}</span>
          ${countdownHtml}
          <span class="text-slate-400">|</span>
          ${scanGear}
          <span>${scanActive ? 'scanning' : 'scan paused'}</span>
          <span class="text-slate-400">|</span>
          <span>devices: ${total}</span>
          <span class="text-slate-400">|</span>
          <span>last: ${tsStr}</span>
        </span>
      `;
    }, [total, status, lastTs, reconnectIn, scanActive]);

    // columns
    const headers = ['RSSI (dB)', 'Name', ...(extendedMode ? ['ID', 'Address', 'Service UUIDs', 'Manufacturer Data'] : []), 'Last Seen', 'Actions'];

    return e('div', { className: 'bg-white shadow ring-1 ring-slate-200 rounded-lg overflow-hidden' }, [
      e('div', { className: 'overflow-x-auto' }, [
        e('table', { className: 'min-w-full divide-y divide-slate-200' }, [
          e('thead', { className: 'bg-slate-50' }, [
            e('tr', {}, headers.map((h, i) => e('th', { key: i, className: 'px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider' }, h)))
          ]),
          e('tbody', { className: 'divide-y divide-slate-100' }, devices.map((d) => e('tr', { key: d.id, className: 'hover:bg-slate-50' }, [
            e('td', { className: 'px-4 py-2 text-sm' }, e('span', { className: 'font-medium ' + rssiColorClass(d.lastRssi) }, (typeof d.lastRssi === 'number') ? String(d.lastRssi) : '')),
            e('td', { className: 'px-4 py-2 text-sm text-slate-800' }, d.localName || ''),
            ...(extendedMode ? [
              e('td', { className: 'px-4 py-2 text-xs text-slate-600' }, d.id),
              e('td', { className: 'px-4 py-2 text-xs text-slate-600' }, d.address || ''),
              e('td', { className: 'px-4 py-2 text-xs text-slate-600' }, (d.serviceUuids || []).join(', ')),
              e('td', { className: 'px-4 py-2 text-xs text-slate-600 break-all' }, d.manufacturerDataHex || '')
            ] : []),
            e('td', { className: 'px-4 py-2 text-xs text-slate-600' }, d.lastSeen ? new Date(d.lastSeen).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''),
            e('td', { className: 'px-4 py-2 text-xs' }, [
              (() => {
                const isConnecting = connectingDevices.has(d.id);
                const isConnected = connectedDevices.has(d.id);
                const hasError = d.connectionStatus === 'error' && d.connectionError;
                const isDisconnected = d.connectionStatus === 'disconnected';
                const hasLastError = d.lastConnectionError && !isConnected && !isConnecting;
                
                if (isConnecting) {
                  return e('button', {
                    className: 'inline-flex items-center px-3 py-1 rounded-md bg-yellow-600 text-white cursor-not-allowed',
                    disabled: true
                  }, [
                    e('span', { className: 'material-icons text-sm' }, 'sync'),
                    e('span', {}, 'Connecting...')
                  ]);
                }
                
                if (isConnected) {
                  const hasLastError = d.lastConnectionError;
                  return e('div', { className: 'flex items-center gap-2' }, [
                    e('button', {
                      className: 'inline-flex items-center px-3 py-1 rounded-md bg-green-600 text-white cursor-not-allowed',
                      disabled: true
                    }, [
                      e('span', { className: 'material-icons text-sm' }, 'link'),
                      e('span', {}, 'Connected')
                    ]),
                    e('button', {
                      className: 'inline-flex items-center px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700',
                      onClick: () => {
                        if (window.__modal) {
                          window.__modal.open(false, { id: d.id, localName: d.localName || null });
                          window.__modal.setStatus('Connected');
                          // Load device details for connected device
                          fetch('/connect/' + encodeURIComponent(d.id), { method: 'POST' })
                            .then(r => r.json())
                            .then(json => {
                              if (json && json.ok && json.device) {
                                window.__modal.setDevice(json.device);
                              }
                            })
                            .catch(() => {});
                        }
                      }
                    }, [
                      e('span', { className: 'material-icons text-sm' }, 'info'),
                      e('span', {}, 'Info')
                    ]),
                    e('button', {
                      className: 'inline-flex items-center px-3 py-1 rounded-md bg-red-600 text-white hover:bg-red-700',
                      onClick: () => {
                        fetch('/disconnect/' + encodeURIComponent(d.id), { method: 'POST' })
                          .then(r => r.json())
                          .then(json => {
                            if (json && json.ok) {
                              // Update local state immediately
                              setConnectedDevices(prev => {
                                const newSet = new Set(prev);
                                newSet.delete(d.id);
                                return newSet;
                              });
                              setConnectingDevices(prev => {
                                const newSet = new Set(prev);
                                newSet.delete(d.id);
                                return newSet;
                              });
                            }
                          })
                          .catch(() => {});
                      }
                    }, [
                      e('span', { className: 'material-icons text-sm' }, 'link_off'),
                      e('span', {}, 'Disconnect')
                    ]),
                    ...(hasLastError ? [
                      e('button', {
                        className: 'inline-flex items-center px-3 py-1 rounded-md bg-red-600 text-white hover:bg-red-700',
                        onClick: () => {
                          if (window.__modal) {
                            window.__modal.open(false, { 
                              id: d.id, 
                              localName: d.localName || null,
                              error: d.lastConnectionError,
                              errorTimestamp: d.lastConnectionErrorTimestamp
                            });
                            window.__modal.setStatus('Connection Error');
                          }
                        }
                      }, [
                        e('span', { className: 'material-icons text-sm' }, 'error'),
                        e('span', {}, 'Error')
                      ])
                    ] : [])
                  ]);
                }
                
                if (hasError) {
                  return e('div', { className: 'flex items-center gap-2' }, [
                    e('button', {
                      className: 'inline-flex items-center px-3 py-1 rounded-md bg-slate-800 text-white hover:bg-slate-700',
                      onClick: () => {
                        fetch('/connect/' + encodeURIComponent(d.id), { method: 'POST' })
                          .then(r => r.json())
                          .catch(() => {});
                      }
                    }, [e('span', { className: 'material-icons text-sm' }, 'link'), e('span', {}, 'Connect')]),
                    e('button', {
                      className: 'inline-flex items-center px-3 py-1 rounded-md bg-red-600 text-white hover:bg-red-700',
                      onClick: () => {
                        if (window.__modal) {
                          window.__modal.open(false, { 
                            id: d.id, 
                            localName: d.localName || null,
                            error: d.connectionError,
                            errorTimestamp: d.connectionTimestamp
                          });
                          window.__modal.setStatus('Connection Error');
                        }
                      }
                    }, [e('span', { className: 'material-icons text-sm' }, 'error'), e('span', {}, 'Error')])
                  ]);
                }
                
                if (isDisconnected) {
                  const reason = d.connectionError || (d.connectionTimestamp ? 'Disconnected' : 'Unknown');
                  return e('div', { className: 'flex flex-col gap-1' }, [
                    e('button', {
                      className: 'inline-flex items-center px-3 py-1 rounded-md bg-slate-800 text-white hover:bg-slate-700',
                      onClick: () => {
                        fetch('/connect/' + encodeURIComponent(d.id), { method: 'POST' })
                          .then(r => r.json())
                          .catch(() => {});
                      }
                    }, [e('span', { className: 'material-icons text-sm' }, 'link'), e('span', {}, 'Connect')]),
                    e('div', { 
                      className: 'text-xs text-orange-600 max-w-32 truncate',
                      title: reason
                    }, reason)
                  ]);
                }
                
                if (hasLastError) {
                  return e('div', { className: 'flex items-center gap-2' }, [
                    e('button', {
                      className: 'inline-flex items-center px-3 py-1 rounded-md bg-slate-800 text-white hover:bg-slate-700',
                      onClick: () => {
                        fetch('/connect/' + encodeURIComponent(d.id), { method: 'POST' })
                          .then(r => r.json())
                          .catch(() => {});
                      }
                    }, [e('span', { className: 'material-icons text-sm' }, 'link'), e('span', {}, 'Connect')]),
                    e('button', {
                      className: 'inline-flex items-center px-3 py-1 rounded-md bg-red-600 text-white hover:bg-red-700',
                      onClick: () => {
                        if (window.__modal) {
                          window.__modal.open(false, { 
                            id: d.id, 
                            localName: d.localName || null,
                            error: d.lastConnectionError,
                            errorTimestamp: d.lastConnectionErrorTimestamp
                          });
                          window.__modal.setStatus('Connection Error');
                        }
                      }
                    }, [e('span', { className: 'material-icons text-sm' }, 'error'), e('span', {}, 'Error')])
                  ]);
                }
                
                return e('button', {
                  className: 'inline-flex items-center px-3 py-1 rounded-md bg-slate-800 text-white hover:bg-slate-700',
                  onClick: () => {
                    fetch('/connect/' + encodeURIComponent(d.id), { method: 'POST' })
                      .then(r => r.json())
                      .catch(() => {});
                  }
                }, [e('span', { className: 'material-icons text-sm' }, 'link'), e('span', {}, 'Connect')]);
              })()
            ])
          ])))
        ])
      ])
    ]);
  }

  function App(){
    const [open, setOpen] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [device, setDevice] = React.useState(null);
    const [statusText, setStatusText] = React.useState('');
    const [extendedMode, setExtendedMode] = React.useState(false);
    const [scanActive, setScanActive] = React.useState(false);

    // Proxy down setters to child via context-less prop drilling using closures
    const Devices = DevicesTable.bind(null);

    // Render modal overlay
    function Modal(){
      if (!open) return null;
      return e('div', { className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/30' }, [
        e('div', { className: 'bg-white w-full max-w-2xl rounded-lg shadow ring-1 ring-slate-200 p-4' }, [
          e('div', { className: 'flex items-center justify-between mb-3' }, [
            e('h2', { className: 'text-lg font-semibold text-slate-800' }, 'Device connection'),
            e('button', { className: 'text-slate-500 hover:text-slate-700', onClick: () => { if (!loading) { setOpen(false); setDevice(null); /* Don't restart scanning automatically */ } } }, e('span', { className: 'material-icons' }, 'close'))
          ]),
          loading ?
            e('div', { className: 'flex items-center justify-center py-10' }, [
              e('span', { className: 'material-icons animate-spin text-4xl text-slate-600' }, 'sync'),
              e('span', { className: 'ml-3 text-sm text-slate-600' }, statusText || 'Connecting...')
            ])
            :
            (device && !device.error) ? e('div', { className: 'space-y-3' }, [
              e('div', { className: 'text-sm text-slate-600' }, (statusText ? statusText + ' · ' : '') + 'Connected: ' + (device.localName || device.id)),
              e('div', { className: 'overflow-x-auto' }, [
                e('table', { className: 'min-w-full divide-y divide-slate-200' }, [
                  e('tbody', { className: 'divide-y divide-slate-100' }, [
                    e('tr', {}, [ e('td', { className: 'px-3 py-2 text-xs text-slate-500' }, 'ID'), e('td', { className: 'px-3 py-2 text-sm text-slate-800 break-all' }, device.id) ]),
                    e('tr', {}, [ e('td', { className: 'px-3 py-2 text-xs text-slate-500' }, 'Address'), e('td', { className: 'px-3 py-2 text-sm text-slate-800' }, device.address || '-') ]),
                    e('tr', {}, [ e('td', { className: 'px-3 py-2 text-xs text-slate-500' }, 'Name'), e('td', { className: 'px-3 py-2 text-sm text-slate-800' }, device.localName || '-') ]),
                    e('tr', {}, [ e('td', { className: 'px-3 py-2 text-xs text-slate-500' }, 'RSSI (dB)'), e('td', { className: 'px-3 py-2 text-sm ' + rssiColorClass(device.rssi) }, (typeof device.rssi === 'number') ? String(device.rssi) : '-') ]),
                    e('tr', {}, [ e('td', { className: 'px-3 py-2 text-xs text-slate-500' }, 'Services'), e('td', { className: 'px-3 py-2 text-sm text-slate-800 break-all' }, (device.services || []).map(s => s.uuid).join(', ') || '-') ]),
                    e('tr', {}, [ e('td', { className: 'px-3 py-2 text-xs text-slate-500' }, 'Characteristics'), e('td', { className: 'px-3 py-2 text-sm text-slate-800 break-all' }, (device.characteristics || []).map(c => `${c.uuid} [${(c.properties || []).join(', ')}]`).join('; ') || '-') ])
                  ])
                ])
              ])
              , e('div', { className: 'text-xs text-slate-500' }, [
                e('div', { className: 'font-semibold mb-1' }, 'Device events'),
                e('div', { id: 'modal-log', className: 'space-y-0.5 max-h-40 overflow-auto' })
              ])
            ])
            : (device && device.error) ? e('div', { className: 'text-sm text-red-600 py-4' }, String(device.error))
            : (device && device.error) ? e('div', { className: 'space-y-3' }, [
                e('div', { className: 'text-sm text-slate-600' }, 'Connection Error: ' + (device.localName || device.id)),
                e('div', { className: 'bg-red-50 border border-red-200 rounded-lg p-4' }, [
                  e('div', { className: 'text-sm font-medium text-red-800 mb-2' }, 'Error Details:'),
                  e('div', { className: 'text-sm text-red-700 break-words' }, device.error || 'Unknown error'),
                  ...(device.errorTimestamp ? [
                    e('div', { className: 'text-xs text-red-600 mt-2' }, 
                      'Time: ' + new Date(device.errorTimestamp).toLocaleString())
                  ] : [])
                ])
              ])
            : e('div', { className: 'text-sm text-slate-600 py-4' }, 'No device data'),
        ])
      ]);
    }

    // Sync modal states with DevicesTable via global setters
    React.useEffect(() => {
      // Expose setters for use in DevicesTable connect handler
      window.__modal = {
        open: (loading, device) => { setOpen(true); setLoading(!!loading); setDevice(device || null); },
        setLoading: (v) => setLoading(!!v),
        setDevice: (d) => setDevice(d || null),
        setStatus: (s) => setStatusText(String(s || '')),
        getStatus: () => statusText,
        appendLog: (line) => {
          try {
            const el = document.getElementById('modal-log');
            if (!el) return;
            const div = document.createElement('div');
            div.textContent = line;
            el.prepend(div);
          } catch(_) {}
        }
      };
      return () => { delete window.__modal; };
    }, []);

    // Patch DevicesTable to call modal via window.__modal
    const PatchedDevicesTable = (props) => {
      // Monkey-patch by wrapping the original component render and tapping into buttons via closures above
      return e(DevicesTable, props);
    };

    return e('div', { className: 'min-h-screen bg-slate-50' }, [
      e('div', { className: 'max-w-7xl mx-auto p-6' }, [
        e('div', { className: 'flex items-center justify-between mb-4' }, [
          e('div', { className: 'flex items-center gap-4' }, [
            e('label', { className: 'inline-flex items-center gap-2 text-sm text-slate-600' }, [
              e('input', { 
                type: 'checkbox', 
                checked: extendedMode,
                onChange: (e) => setExtendedMode(e.target.checked),
                className: 'rounded border-slate-300'
              }),
              e('span', {}, 'Extended mode')
            ]),
            e('button', {
              className: 'inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ' + 
                (scanActive ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-green-600 text-white hover:bg-green-700'),
              onClick: () => {
                const endpoint = scanActive ? '/scan/stop' : '/scan/start';
                fetch(endpoint, { method: 'POST' })
                  .then(r => r.json())
                  .catch(() => {});
              }
            }, [
              e('span', { className: 'material-icons text-base' }, scanActive ? 'stop' : 'play_arrow'),
              e('span', {}, scanActive ? 'Stop Scan' : 'Start Scan')
            ])
          ])
        ]),
        e('div', { id: 'meta', className: 'text-slate-600 text-sm mb-4' }),
        e(PatchedDevicesTable, { extendedMode, onScanActiveChange: setScanActive }),
        e(Modal, {})
      ])
    ]);
  }

  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(e(App));
})();


