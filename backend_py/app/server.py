from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
from starlette.responses import FileResponse
from sse_starlette.sse import EventSourceResponse
import asyncio
import os
from typing import Dict, Any, List, Set

# In-memory state similar to Node.js version
DEVICES: List[Dict[str, Any]] = []
SCANNING_ACTIVE: bool = False
LAST_EVENTS: List[Dict[str, Any]] = []
SSE_CLIENTS: Set[asyncio.Queue] = set()

MAX_BUFFER = 100

app = FastAPI()

# CORS disabled by default; enable if serving from different host
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Realtime helpers (mirror of realtime.js) ---
async def push_event(payload: Dict[str, Any]):
    LAST_EVENTS.append(payload)
    if len(LAST_EVENTS) > MAX_BUFFER:
        del LAST_EVENTS[0]
    for q in list(SSE_CLIENTS):
        try:
            await q.put(payload)
        except Exception:
            pass
    # WebSocket broadcast is handled by WS manager
    await ws_manager.broadcast({"type": "adv", "data": payload})


def get_last_events():
    return LAST_EVENTS


class WSConnectionManager:
    def __init__(self) -> None:
        self.active: Set[WebSocket] = set()
        self.lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self.lock:
            self.active.add(websocket)

    async def disconnect(self, websocket: WebSocket):
        async with self.lock:
            if websocket in self.active:
                self.active.remove(websocket)

    async def broadcast(self, message: Dict[str, Any]):
        data = None
        for ws in list(self.active):
            try:
                if data is None:
                    data = message
                await ws.send_json(data)
            except Exception:
                try:
                    await self.disconnect(ws)
                except Exception:
                    pass


ws_manager = WSConnectionManager()


# --- Static files (serve client/dist and public like Node) ---
BASE_DIR = os.path.dirname(os.path.dirname(__file__))
CLIENT_DIST = os.path.abspath(os.path.join(BASE_DIR, "..", "client", "dist"))
PUBLIC_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "public"))

if os.path.isdir(CLIENT_DIST):
    app.mount("/", StaticFiles(directory=CLIENT_DIST, html=True), name="client")
elif os.path.isdir(PUBLIC_DIR):
    app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")


# --- SSE endpoint to mirror /events ---
@app.get("/events")
async def sse_events():
    async def event_generator():
        q: asyncio.Queue = asyncio.Queue()
        SSE_CLIENTS.add(q)
        # Send recent buffer first
        for ev in get_last_events():
            yield {"event": "message", "data": ev}
        try:
            while True:
                payload = await q.get()
                yield {"event": "message", "data": payload}
        except asyncio.CancelledError:
            pass
        finally:
            SSE_CLIENTS.discard(q)

    return EventSourceResponse(event_generator())


# --- WebSocket endpoint /ws ---
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        raw = list(DEVICES)
        devices_sorted = sorted(
            raw,
            key=lambda d: (0 if (str(d.get("localName") or "").strip()) else 1, str(d.get("localName") or "").lower()),
        )
        try:
            await websocket.send_json({
                "type": "snapshot",
                "data": {"ts": int(asyncio.get_event_loop().time() * 1000), "devices": devices_sorted, "scanningActive": SCANNING_ACTIVE}
            })
        except Exception:
            pass
        while True:
            # Keep connection open; we don't expect client messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(websocket)


# --- Router: mirror existing endpoints ---
from .routes.ble_router import router as ble_router
app.include_router(ble_router)


# Entrypoint for uvicorn
# uvicorn app.server:app --host 0.0.0.0 --port 3000
