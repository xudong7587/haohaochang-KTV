"""Durable job state and atomic upload reservations for the single worker process."""
import os
import re
import shutil
import json
import threading
import time
import uuid


class JobStore:
    def __init__(self, root):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.accepting = True
        self.readers = {}
        self.last_cleanup = 0
        self.requests = {}
        for info in self.root.glob('*/info.json'):
            if info.parent.is_symlink(): continue
            try:
                record = json.loads(info.read_text(encoding='utf-8'))
                if record.get('request_key'): self.requests[record['request_key']] = (info.parent.name, record['model'])
            except (OSError, ValueError, KeyError): pass

    def pause(self):
        with self.lock:
            self.accepting = False

    def resume(self):
        with self.lock:
            self.accepting = True

    def state(self, job):
        # Windows cannot replace a file while another thread has it open.
        # Dashboard polling must share the writers' lock, including closing the file.
        with self.lock:
            try:
                return json.loads((self.root / job / 'state.json').read_text(encoding='utf-8'))
            except (OSError, ValueError):
                return dict(id=job, status='failed', error='Job state is missing or corrupt; retry from NAS')

    def write(self, job, value):
        with self.lock:
            target = self.root / job / 'state.json'
            temp = target.with_name('state-' + uuid.uuid4().hex + '.tmp')
            temp.write_text(json.dumps({'id': job, 'updated': time.time(), **value}), encoding='utf-8')
            temp.replace(target)

    def recover(self):
        for folder in self.root.iterdir():
            if folder.is_dir() and self.state(folder.name).get('status') in ('uploading', 'queued', 'running'):
                self.write(folder.name, dict(status='failed', stage='interrupted', retryable=True,
                                             error='Service restarted; retry from NAS'))
                (folder / 'input.part').unlink(missing_ok=True)

    def pending(self):
        with self.lock:
            return sum(self.state(f.name).get('status') in ('uploading', 'queued', 'running')
                       for f in self.root.iterdir() if f.is_dir())

    def reserve(self, model, title, request_key='', capacity=10):
        with self.lock:
            self.cleanup()
            if request_key and request_key in self.requests:
                existing, previous_model = self.requests[request_key]
                if previous_model != model: raise ValueError('Idempotency key already belongs to another model')
                return existing, False
            minimum = int(os.getenv('SEPARATION_MIN_FREE_BYTES', str(2 * 1024**3)))
            maximum = int(os.getenv('SEPARATION_MAX_WORK_BYTES', str(20 * 1024**3)))
            if shutil.disk_usage(self.root).free < minimum or self.work_bytes() >= maximum:
                raise OverflowError('工作目录空间不足，请等待结果回收或释放磁盘空间')
            if not self.accepting or self.pending() >= capacity:
                raise OverflowError('Queue full')
            job = uuid.uuid4().hex
            folder = self.root / job
            folder.mkdir()
            (folder / 'info.json').write_text(json.dumps(dict(title=title[:240], model=model,
                created=time.time(), request_key=request_key)), encoding='utf-8')
            if request_key: self.requests[request_key] = (job, model)
            self.write(job, dict(status='uploading', stage='uploading'))
            return job, True

    def work_bytes(self):
        return sum(f.stat().st_size for d in self.root.iterdir() if d.is_dir() and not d.is_symlink()
                   for f in d.rglob('*') if f.is_file() and not f.is_symlink())

    def acknowledge(self, job):
        with self.lock:
            state = self.state(job)
            if state.get('status') != 'done': raise ValueError('Result is not complete')
            if not state.get('acknowledged'):
                self.write(job, {**state, 'acknowledged': time.time()})

    def acquire_result(self, job):
        with self.lock:
            if self.state(job).get('status') != 'done': return False
            self.readers[job] = self.readers.get(job, 0) + 1
            return True

    def release_result(self, job):
        with self.lock:
            self.readers[job] = max(0, self.readers.get(job, 0) - 1)

    def file_response(self, job, file, media_type):
        from fastapi import HTTPException
        from fastapi.responses import FileResponse
        with self.lock:
            if not file.is_file() or not self.acquire_result(job):
                raise HTTPException(404, 'Not ready')
        store = self
        class ResultResponse(FileResponse):
            async def __call__(self, scope, receive, send):
                try:
                    await super().__call__(scope, receive, send)
                finally:
                    store.release_result(job)
        return ResultResponse(file, media_type=media_type)

    def cleanup(self, now=None, force=False):
        now = time.time() if now is None else now
        with self.lock:
            if not force and now - self.last_cleanup < 60: return
            self.last_cleanup = now
            retention = max(3600, int(os.getenv('SEPARATION_RETENTION_SECONDS', '604800')))
            grace = max(3600, int(os.getenv('SEPARATION_ACK_GRACE_SECONDS', '3600')))
            for folder in list(self.root.iterdir()):
                if not re.fullmatch('[0-9a-f]{32}', folder.name) or not folder.is_dir() or folder.is_symlink(): continue
                state = self.state(folder.name)
                if state.get('status') not in ('done', 'failed') or self.readers.get(folder.name, 0): continue
                try: updated = state.get('updated') or (folder / 'state.json').stat().st_mtime
                except OSError: updated = folder.stat().st_mtime
                expired = now - updated >= retention
                if state.get('acknowledged'): expired |= now - state['acknowledged'] >= grace
                if not expired: continue
                # Refuse to traverse unexpected links; all targets remain below the jobs root.
                if any(p.is_symlink() for p in folder.rglob('*')): continue
                if folder.resolve().parent != self.root.resolve(): continue
                shutil.rmtree(folder)
                self.readers.pop(folder.name, None)
                for key, value in list(self.requests.items()):
                    if value[0] == folder.name: del self.requests[key]
