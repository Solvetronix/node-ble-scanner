import asyncio
from typing import Any, Dict, List, Optional
from fastapi.responses import JSONResponse
from bleak import BleakScanner, BleakClient
from ..server import push_event, DEVICES, SCANNING_ACTIVE, ws_manager

# Simple device state model compatible with frontend expectations
# Fields used by UI: id, address, localName, lastRssi, lastSeen, serviceUuids, manufacturerDataHex, connected, connectionStatus

_device_index = {}  # id -> index in DEVICES
_connected_clients: Dict[str, BleakClient] = {}
_scan_task: Optional[asyncio.Task] = None


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

                now = __import__('time').time_ns() // 1_000_000
                for d in (devices or []):
                    try:
                        address = getattr(d, 'address', None)
                        dev_id = getattr(d, 'details', None) or address or getattr(d, 'name', None) or str(d)
                        dev_id = str(dev_id)
                        local_name = getattr(d, 'name', None)
                        rssi = getattr(d, 'rssi', None)
                        if isinstance(rssi, (int, float)) and rssi < filter_min_rssi:
                            continue
                        ad = (adv_map.get(d) if isinstance(adv_map, dict) else None) or {}
                        service_uuids = list(getattr(ad, 'service_uuids', None) or [])
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
    return True


async def stop_scan():
    global SCANNING_ACTIVE, _scan_task
    SCANNING_ACTIVE = False
    if _scan_task and not _scan_task.done():
        _scan_task.cancel()
        try:
            await _scan_task
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
