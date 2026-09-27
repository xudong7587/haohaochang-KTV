"""Limit simultaneous multipart parsers before FastAPI spools uploaded files."""
import threading
import asyncio
import os
import hmac
import shutil
import tempfile
from starlette.responses import JSONResponse
from starlette.exceptions import HTTPException


class UploadGuard:
    def __init__(self, app, concurrency=2, max_bytes=101 * 1024 * 1024):
        self.app = app
        self.slots = threading.BoundedSemaphore(concurrency)
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('method') != 'POST' or scope.get('path') not in ('/separate', '/clip'):
            return await self.app(scope, receive, send)
        key = os.getenv('SEPARATION_API_KEY', '')
        credential = dict(scope.get('headers', [])).get(b'authorization', b'')
        if key and not hmac.compare_digest(credential, ('Bearer ' + key).encode()):
            return await JSONResponse({'detail':'Invalid key'}, status_code=401)(scope, receive, send)
        if not self.slots.acquire(blocking=False):
            return await JSONResponse({'detail':'Too many uploads'}, status_code=429,
                headers={'Retry-After':'3'})(scope, receive, send)
        total = 0
        checked_bytes = -16 * 1024 * 1024
        deadline = asyncio.get_running_loop().time() + (1800 if scope['path'] == '/clip' else 300)
        max_bytes = 4097 * 1024 * 1024 if scope['path'] == '/clip' else self.max_bytes
        async def limited_receive():
            nonlocal total, checked_bytes
            if total - checked_bytes >= 16 * 1024 * 1024:
                checked_bytes = total
                if shutil.disk_usage(tempfile.gettempdir()).free < 2 * 1024**3:
                    raise HTTPException(507, 'Insufficient temporary disk space')
            timeout = min(20, deadline - asyncio.get_running_loop().time())
            if timeout <= 0:
                raise HTTPException(408, 'Upload timed out')
            try:
                message = await asyncio.wait_for(receive(), timeout)
            except asyncio.TimeoutError:
                raise HTTPException(408, 'Upload stalled')
            total += len(message.get('body', b''))
            if total > max_bytes:
                raise HTTPException(413, 'Audio exceeds upload limit')
            return message
        try:
            length = dict(scope.get('headers', [])).get(b'content-length', b'0')
            try:
                too_large = int(length) > max_bytes
            except ValueError:
                too_large = True
            if too_large:
                return await JSONResponse({'detail':'Audio exceeds upload limit'}, status_code=413)(scope, receive, send)
            await self.app(scope, limited_receive, send)
        finally:
            self.slots.release()
