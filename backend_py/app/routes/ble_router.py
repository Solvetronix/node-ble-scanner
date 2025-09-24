from fastapi import APIRouter
from fastapi.responses import JSONResponse
from typing import Any, Dict
from ..services.ble_service import get_devices_list, start_scan, stop_scan, get_scanning_active, connect_device, disconnect_device

router = APIRouter()

@router.get('/devices')
async def list_devices():
    devices = get_devices_list()
    return JSONResponse({ 'ts': __import__('time').time_ns() // 1_000_000, 'count': len(devices), 'devices': devices })

@router.post('/scan/start')
async def scan_start():
    try:
        await start_scan()
        return JSONResponse({ 'ok': True })
    except Exception as e:
        return JSONResponse({ 'ok': False, 'error': str(e) }, status_code=500)

@router.post('/scan/stop')
async def scan_stop():
    try:
        await stop_scan()
        return JSONResponse({ 'ok': True })
    except Exception as e:
        return JSONResponse({ 'ok': False, 'error': str(e) }, status_code=500)

@router.get('/scan/status')
async def scan_status():
    devices = get_devices_list()
    return JSONResponse({ 'ok': True, 'scanningActive': get_scanning_active(), 'count': len(devices), 'ts': __import__('time').time_ns() // 1_000_000 })

@router.post('/connect/{id}')
async def connect(id: str):
    return await connect_device(id)

@router.post('/disconnect/{id}')
async def disconnect(id: str):
    return await disconnect_device(id)
