import IconActionButton from '../ui/IconActionButton'
import LinkIcon from '@mui/icons-material/Link'
import LinkOffIcon from '@mui/icons-material/LinkOff'
import InfoIcon from '@mui/icons-material/Info'

export default function DevicesTable({ devices = [], extended = false, connectingSet = new Set(), connectedSet = new Set(), onConnect, onDisconnect, onInfo }){
  function formatName(localName, address, id){
    if (typeof localName === 'string') {
      const trimmed = localName.trim()
      if (trimmed.length > 0) {
        const macColon = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i
        const macHyphen = /^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i
        if (!macColon.test(trimmed) && !macHyphen.test(trimmed)) return trimmed
      }
    }
    return (address && String(address)) || (id && String(id)) || ''
  }
  return (
    <div className="bg-white shadow ring-1 ring-slate-200 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">RSSI</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Name</th>
              {extended && <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">ID</th>}
              {extended && <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Address</th>}
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Last Seen</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {devices.map((d) => (
              <tr key={d.id} className="hover:bg-slate-50">
                <td className="px-4 py-2 text-sm">{typeof d.lastRssi === 'number' ? d.lastRssi : '-'}</td>
                <td className="px-4 py-2 text-sm">{formatName(d.localName, d.address, d.id)}</td>
                {extended && <td className="px-4 py-2 text-xs text-slate-600">{d.id}</td>}
                {extended && <td className="px-4 py-2 text-xs text-slate-600">{d.address || ''}</td>}
                <td className="px-4 py-2 text-xs text-slate-600">{d.lastSeen ? new Date(d.lastSeen).toLocaleString() : ''}</td>
                <td className="px-4 py-2 text-xs">
                  <div className="flex items-center gap-1">
                    {(() => {
                      const isConnecting = connectingSet.has(d.id) || d.connectionStatus === 'connecting'
                      const isConnected = connectedSet.has(d.id) || d.connected || d.connectionStatus === 'connected'
                      const hasError = d.connectionStatus === 'error'

                      if (isConnecting) {
                        return (
                          <IconActionButton title="Connecting..." color="warning" disabled>
                            <LinkIcon fontSize="inherit" />
                          </IconActionButton>
                        )
                      }
                      if (isConnected) {
                        return (
                          <>
                            <IconActionButton title="Info" color="info" onClick={() => onInfo && onInfo(d.id)}>
                              <InfoIcon fontSize="inherit" />
                            </IconActionButton>
                            <IconActionButton title="Disconnect" color="error" onClick={() => onDisconnect && onDisconnect(d.id)}>
                              <LinkOffIcon fontSize="inherit" />
                            </IconActionButton>
                          </>
                        )
                      }
                      // default: not connected
                      return (
                        <IconActionButton title={hasError ? 'Retry connect' : 'Connect'} color={hasError ? 'warning' : 'primary'} onClick={() => onConnect && onConnect(d.id)}>
                          <LinkIcon fontSize="inherit" />
                        </IconActionButton>
                      )
                    })()}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}


