import asyncio
from typing import Any, Dict, List, Optional
import re
from fastapi.responses import JSONResponse
from bleak import BleakScanner, BleakClient
from ..server import push_event, DEVICES, SCANNING_ACTIVE, ws_manager

# Simple device state model compatible with frontend expectations
# Fields used by UI: id, address, localName, lastRssi, lastSeen, serviceUuids, manufacturerDataHex, connected, connectionStatus

_device_index = {}  # id -> index in DEVICES
_connected_clients: Dict[str, BleakClient] = {}
_scan_task: Optional[asyncio.Task] = None
_name_refresh_task: Optional[asyncio.Task] = None
_addr_name_by_addr: Dict[str, str] = {}
_addr_rssi_by_addr: Dict[str, int] = {}


async def _bluetoothctl_monitor_task():
    """Read bluetoothctl stream to enrich names and RSSI in real-time."""
    try:
        # Run interactive bluetoothctl
        cmd = "bluetoothctl"
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert proc.stdin is not None
        assert proc.stdout is not None
        # Ensure adapter is powered and scanning
        try:
            proc.stdin.write(b"power on\n")
            await proc.stdin.drain()
            proc.stdin.write(b"agent on\n")
            await proc.stdin.drain()
            proc.stdin.write(b"default-agent\n")
            await proc.stdin.drain()
            proc.stdin.write(b"scan on\n")
            await proc.stdin.drain()
        except Exception:
            pass

        addr_re = re.compile(r"([0-9A-F]{2}(?::[0-9A-F]{2}){5})", re.I)
        rssi_re = re.compile(r"Device\s+([0-9A-F:]{17})\s+RSSI:\s+(-?\d+)", re.I)
        name_re = re.compile(r"Device\s+([0-9A-F:]{17})\s+(?:Name|Alias):\s+(.+)", re.I)
        devices_line_re = re.compile(r"^Device\s+([0-9A-F:]{17})\s+(.+)$", re.I)

        last_keepalive = 0
        last_devices_poll = 0
        while True:
            line = await proc.stdout.readline()
            if not line:
                await asyncio.sleep(0.1)
                continue
            # Periodically reinforce scanning state
            try:
                now_ms = __import__('time').time_ns() // 1_000_000
                if now_ms - last_keepalive > 10000:
                    proc.stdin.write(b"scan on\n")
                    await proc.stdin.drain()
                    last_keepalive = now_ms
                if now_ms - last_devices_poll > 15000:
                    proc.stdin.write(b"devices\n")
                    await proc.stdin.drain()
                    last_devices_poll = now_ms
            except Exception:
                pass
            try:
                txt = line.decode(errors='ignore').strip()
            except Exception:
                continue

            m = rssi_re.search(txt)
            if m:
                address = m.group(1).upper()
                try:
                    rssi_val = int(m.group(2))
                    _addr_rssi_by_addr[address] = rssi_val
                    # Update device entry and push event
                    now = __import__('time').time_ns() // 1_000_000
                    _upsert_device(address, {
                        'id': address,
                        'address': address,
                        'localName': _addr_name_by_addr.get(address),
                        'lastRssi': rssi_val,
                        'lastSeen': now,
                    })
                    asyncio.create_task(push_event({
                        'ts': now,
                        'id': address,
                        'address': address,
                        'rssi': rssi_val,
                        'localName': _addr_name_by_addr.get(address),
                        'serviceUuids': [],
                        'manufacturerData': None,
                        'serviceData': [],
                    }))
                except Exception:
                    pass
                continue

            m = name_re.search(txt)
            if m:
                address = m.group(1).upper()
                name = m.group(2).strip()
                # Normalize placeholder names
                if name and name.lower() not in ("unknown", "n/a"):
                    _addr_name_by_addr[address] = name
                    # If device exists, enrich and broadcast snapshot update
                    now = __import__('time').time_ns() // 1_000_000
                    _upsert_device(address, {
                        'id': address,
                        'address': address,
                        'localName': name,
                        'lastSeen': now,
                    })
                    asyncio.create_task(push_event({
                        'ts': now,
                        'id': address,
                        'address': address,
                        'rssi': _addr_rssi_by_addr.get(address),
                        'localName': name,
                        'serviceUuids': [],
                        'manufacturerData': None,
                        'serviceData': [],
                    }))
                continue

            # Parse "devices" listing lines: Device <MAC> <Name>
            m = devices_line_re.search(txt)
            if m:
                address = m.group(1).upper()
                name = m.group(2).strip()
                if name and name.lower() not in ("device", "unknown", "n/a"):
                    _addr_name_by_addr[address] = name
                    now = __import__('time').time_ns() // 1_000_000
                    _upsert_device(address, {
                        'id': address,
                        'address': address,
                        'localName': name,
                        'lastSeen': now,
                    })
                    asyncio.create_task(push_event({
                        'ts': now,
                        'id': address,
                        'address': address,
                        'rssi': _addr_rssi_by_addr.get(address),
                        'localName': name,
                        'serviceUuids': [],
                        'manufacturerData': None,
                        'serviceData': [],
                    }))
                continue

    except asyncio.CancelledError:
        pass
    except Exception:
        # swallow errors; this is enrichment only
        pass


def _upsert_device(id: str, update: Dict[str, Any]) -> None:
    # merge-like behavior
    existing = None
    idx = _device_index.get(id)
    if idx is not None and 0 <= idx < len(DEVICES):
        existing = DEVICES[idx]
        DEVICES[idx] = { **existing, **update }
    else:
        DEVICES.append(update)
        _device_index[id] = len(DEVICES) - 1


def get_devices_list() -> List[Dict[str, Any]]:
    return list(DEVICES)


def get_scanning_active() -> bool:
    return bool(SCANNING_ACTIVE)


async def _scan_loop(filter_min_rssi: int = -200, allow_duplicates: bool = True):
    global SCANNING_ACTIVE
    SCANNING_ACTIVE = True
    await ws_manager.broadcast({ 'type': 'scan', 'data': { 'active': True, 'ts': __import__('time').time_ns() // 1_000_000, 'reason': 'bleak:start' } })
    # Simplified and robust: manual discovery loop every 3s (works across bleak versions)
    try:
        while SCANNING_ACTIVE:
            try:
                try:
                    results = await BleakScanner.discover(timeout=3.0, return_adv=True)  # type: ignore[call-arg]
                    if isinstance(results, tuple) and len(results) >= 1:
                        devices = results[0]
                        adv_map = (results[1] if len(results) > 1 else {}) or {}
                    else:
                        devices = results
                        adv_map = {}
                except TypeError:
                    devices = await BleakScanner.discover(timeout=3.0)
                    adv_map = {}

                # Normalize advertisement map to address->adv (uppercase MAC)
                adv_by_addr: Dict[str, Any] = {}
                try:
                    for k, v in (adv_map.items() if hasattr(adv_map, 'items') else []):
                        try:
                            if isinstance(k, str):
                                adv_by_addr[k.upper()] = v
                            else:
                                ka = getattr(k, 'address', None)
                                if isinstance(ka, str):
                                    adv_by_addr[ka.upper()] = v
                        except Exception:
                            pass
                except Exception:
                    adv_by_addr = {}

                now = __import__('time').time_ns() // 1_000_000
                for d in (devices or []):
                    try:
                        address = getattr(d, 'address', None)
                        dev_id = getattr(d, 'details', None) or address or getattr(d, 'name', None) or str(d)
                        dev_id = str(dev_id)
                        if not address and re.match(r"^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$", dev_id, re.I):
                            address = dev_id
                        # Pull adv by address (normalized)
                        ad = adv_by_addr.get((address or '').upper())
                        # Prefer adv local name, then device name
                        adv_name = getattr(ad, 'local_name', None) if ad is not None else None
                        local_name = adv_name or getattr(d, 'name', None)
                        # Prefer adv RSSI if present
                        rssi = getattr(ad, 'rssi', None) if ad is not None else getattr(d, 'rssi', None)
                        if isinstance(rssi, (int, float)) and rssi < filter_min_rssi:
                            continue
                        service_uuids = list(getattr(ad, 'service_uuids', None) or []) if ad is not None else []
                        update = {
                            'id': dev_id,
                            'address': address,
                            'localName': (local_name.strip() if isinstance(local_name, str) and local_name.strip() else None),
                            'lastRssi': rssi,
                            'lastSeen': now,
                            'serviceUuids': service_uuids,
                            'manufacturerDataHex': None,
                        }
                        _upsert_device(dev_id, update)
                        asyncio.create_task(push_event({
                            'ts': now,
                            'id': dev_id,
                            'address': address,
                            'rssi': rssi,
                            'localName': update['localName'],
                            'serviceUuids': service_uuids,
                            'manufacturerData': None,
                            'serviceData': [],
                        }))
                    except Exception:
                        pass
            except Exception:
                await asyncio.sleep(2.0)
    finally:
        SCANNING_ACTIVE = False
        await ws_manager.broadcast({ 'type': 'scan', 'data': { 'active': False, 'ts': __import__('time').time_ns() // 1_000_000, 'reason': 'bleak:stop' } })


async def start_scan():
    global _scan_task, SCANNING_ACTIVE
    if _scan_task and not _scan_task.done():
        return True
    SCANNING_ACTIVE = True
    _scan_task = asyncio.create_task(_scan_loop(filter_min_rssi=int(__import__('os').getenv('FILTER_MIN_RSSI', '-200'))))
    # Start bluetoothctl monitor to enrich names/RSSI
    global _name_refresh_task
    try:
        if (_name_refresh_task is None) or _name_refresh_task.done():
            _name_refresh_task = asyncio.create_task(_bluetoothctl_monitor_task())
    except Exception:
        pass
    return True


async def stop_scan():
    global SCANNING_ACTIVE, _scan_task, _name_refresh_task
    SCANNING_ACTIVE = False
    if _scan_task and not _scan_task.done():
        _scan_task.cancel()
        try:
            await _scan_task
        except Exception:
            pass
    # Stop bluetoothctl monitor
    try:
        if _name_refresh_task and not _name_refresh_task.done():
            _name_refresh_task.cancel()
    except Exception:
        pass
    return True


async def connect_device(id: str):
    # Optimistic UI event
    await ws_manager.broadcast({ 'type': 'connect', 'data': { 'id': id, 'status': 'starting', 'ts': __import__('time').time_ns() // 1_000_000 } })
    # Find address by id
    device = next((d for d in DEVICES if str(d.get('id')) == str(id)), None)
    if not device or not device.get('address'):
        return JSONResponse({ 'ok': False, 'error': 'Device not found' }, status_code=404)
    address = device['address']

    # Create client and connect with timeout/retry
    client = BleakClient(address)
    try:
        await asyncio.wait_for(client.connect(), timeout=15.0)
        _connected_clients[id] = client
        # Discover services/characteristics
        services = await client.get_services()
        svc_list = [{ 'uuid': s.uuid } for s in services]
        chars = []
        for s in services:
            for c in s.characteristics:
                chars.append({ 'uuid': c.uuid, 'properties': list(c.properties) })
                if 'notify' in c.properties or 'indicate' in c.properties:
                    try:
                        def _notif(_: int, data: bytearray):
                            try:
                                hexdata = (bytes(data).hex() if data else None)
                                asyncio.create_task(ws_manager.broadcast({ 'type': 'notify', 'data': { 'id': id, 'charUuid': c.uuid, 'data': hexdata, 'ts': __import__('time').time_ns() // 1_000_000 } }))
                            except Exception:
                                pass
                        await client.start_notify(c, _notif)
                    except Exception:
                        pass
        details = {
            'id': id,
            'address': address,
            'localName': device.get('localName'),
            'rssi': device.get('lastRssi'),
            'serviceUuids': device.get('serviceUuids', []),
            'manufacturerDataHex': device.get('manufacturerDataHex'),
            'connectedAt': __import__('time').time_ns() // 1_000_000,
            'services': svc_list,
            'characteristics': chars,
        }
        await ws_manager.broadcast({ 'type': 'connected', 'data': details })
        await ws_manager.broadcast({ 'type': 'connect', 'data': { 'id': id, 'status': 'success', 'ts': __import__('time').time_ns() // 1_000_000 } })
        return JSONResponse({ 'ok': True, 'device': details })
    except Exception as e:
        await ws_manager.broadcast({ 'type': 'connect', 'data': { 'id': id, 'status': 'error', 'error': str(e), 'ts': __import__('time').time_ns() // 1_000_000 } })
        return JSONResponse({ 'ok': False, 'error': str(e) }, status_code=500)


async def disconnect_device(id: str):
    client = _connected_clients.get(id)
    if not client:
        return JSONResponse({ 'ok': False, 'error': 'Device not connected' }, status_code=404)
    try:
        await client.disconnect()
    except Exception:
        pass
    finally:
        _connected_clients.pop(id, None)
    return JSONResponse({ 'ok': True })
