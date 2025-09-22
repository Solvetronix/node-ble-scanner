import IconActionButton from '../ui/IconActionButton'
import LinkIcon from '@mui/icons-material/Link'
import LinkOffIcon from '@mui/icons-material/LinkOff'
import InfoIcon from '@mui/icons-material/Info'
import { connectDevice, disconnectDevice } from '../api/http'

export default function DevicesTable({ devices = [], extended = false }){
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
                <td className="px-4 py-2 text-sm">{typeof d.lastRssi === 'number' ? d.lastRssi : ''}</td>
                <td className="px-4 py-2 text-sm">{d.localName || ''}</td>
                {extended && <td className="px-4 py-2 text-xs text-slate-600">{d.id}</td>}
                {extended && <td className="px-4 py-2 text-xs text-slate-600">{d.address || ''}</td>}
                <td className="px-4 py-2 text-xs text-slate-600">{d.lastSeen ? new Date(d.lastSeen).toLocaleString() : ''}</td>
                <td className="px-4 py-2 text-xs">
                  <div className="flex items-center gap-1">
                    <IconActionButton title="Connect" color="primary" onClick={() => connectDevice(d.id).catch(() => {})}>
                      <LinkIcon fontSize="inherit" />
                    </IconActionButton>
                    <IconActionButton title="Info" color="info" onClick={() => connectDevice(d.id).then(r=>r.json()).catch(() => {})}>
                      <InfoIcon fontSize="inherit" />
                    </IconActionButton>
                    <IconActionButton title="Disconnect" color="error" onClick={() => disconnectDevice(d.id).catch(() => {})}>
                      <LinkOffIcon fontSize="inherit" />
                    </IconActionButton>
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


