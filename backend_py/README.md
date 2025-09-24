# Python BLE backend (FastAPI + Bleak)

## Requirements
- Python 3.11+
- Linux with BlueZ (for Raspberry Pi 5)

## Install
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run
```bash
# Same port 3000 to match frontend expectations
export PORT=3000
export FILTER_MIN_RSSI=-100
uvicorn app.server:app --host 0.0.0.0 --port ${PORT}
```

## API and realtime
- WebSocket: `/ws` — same message types as Node backend: `snapshot`, `adv`, `scan`, `connect`, `connected`, `disconnected`, `notify`
- SSE: `/events`
- REST:
  - `GET /devices`
  - `POST /scan/start`
  - `POST /scan/stop`
  - `GET /scan/status`
  - `POST /connect/{id}`
  - `POST /disconnect/{id}`

## Notes
- Comments in code are in English as requested
- Device `id` is derived from Bleak address/details; stable per run
