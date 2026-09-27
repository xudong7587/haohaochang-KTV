"""ktv-separation-v1 routes shared by the CPU container and PC launcher."""
import concurrent.futures
import hmac
import threading
import os
import re
from pathlib import Path
from fastapi import FastAPI, Depends, File, Form, Header, HTTPException, UploadFile
from job_store import JobStore
from inference import separate as execute_separation
from upload_guard import UploadGuard

ROOT = Path(os.getenv('SEPARATION_DATA_DIR', '/data')) / 'jobs'
jobs = JobStore(ROOT)
jobs.recover()
NPU = os.getenv('SEPARATION_BACKEND') == 'openvino-npu'
MODELS = ['htdemucs'] if NPU else ['htdemucs', 'htdemucs_ft']
CONCURRENCY = 1 if NPU else max(1, min(3, int(os.getenv('SEPARATION_CONCURRENCY', '1'))))
pool = concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY)
app = FastAPI()
app.add_middleware(UploadGuard)
cleanup_stop = threading.Event()
cleanup_thread = None
@app.on_event('startup')
def start_cleanup():
    global cleanup_thread
    cleanup_stop.clear()
    def clean():
        while not cleanup_stop.wait(60):
            try: jobs.cleanup()
            except OSError: pass
    jobs.cleanup(force=True)
    cleanup_thread = threading.Thread(target=clean, daemon=True, name='result-cleanup')
    cleanup_thread.start()
@app.on_event('shutdown')
def stop_cleanup():
    cleanup_stop.set()
    if cleanup_thread: cleanup_thread.join(timeout=5)


if NPU:
    from npu_detection import NpuDetection
    detection = NpuDetection()
    detection.snapshot()


def auth(authorization: str = Header(default='')):
    key = os.getenv('SEPARATION_API_KEY', '')
    if key and not hmac.compare_digest(authorization, 'Bearer ' + key):
        raise HTTPException(401, 'Invalid key')


@app.post('/jobs/{job}/ack', dependencies=[Depends(auth)])
def acknowledge(job: str):
    if not job_path(job).is_dir(): raise HTTPException(404, 'Unknown job')
    try: jobs.acknowledge(job)
    except ValueError as error: raise HTTPException(409, str(error))
    return {'ok': True}

def status(job, value):
    jobs.write(job, value)


def separate(job, model):
    execute_separation(jobs, job, model)


@app.get('/health', dependencies=[Depends(auth)])
def health():
    if hasattr(app.state, 'updater'):
        app.state.updater.snapshot()
    pending = jobs.pending()
    detected = detection.snapshot() if NPU else {}
    return dict(protocol='ktv-separation-v1', models=MODELS,
        backend='openvino-npu' if NPU else 'demucs', experimental=NPU,
        lanEnabled=getattr(app.state, 'lan', {}).get('enabled', False),
        device=os.getenv('SEPARATION_DEVICE', 'cpu'), pending=pending, concurrency=CONCURRENCY, busy=not jobs.accepting or pending >= CONCURRENCY,
        max_video_upload_bytes=4 * 1024**3,
        capabilities=['idempotency-key', 'upload-limit', 'restart-recovery'] +
            ([] if NPU else ['video-clip-v1', 'video-prepare-v1', 'video-prepare-v2']),
        **({'qualification': detected, 'ready': detected['ready']} if NPU else {}))


@app.post('/separate', dependencies=[Depends(auth)])
async def submit(file: UploadFile = File(...), model: str = Form(...), title: str = Form(default=''),
                 idempotency_key: str = Header(default='')):
    job = None
    created = False
    try:
        if NPU and not detection.snapshot()['ready']:
            raise HTTPException(503, 'NPU model is not ready; retry later or use fallback provider')
        if model not in MODELS:
            raise HTTPException(400, 'Unsupported model')
        if len(idempotency_key) > 120 or any(not (c.isascii() and (c.isalnum() or c in '_-')) for c in idempotency_key):
            raise HTTPException(400, 'Invalid idempotency key')
        try:
            job, created = jobs.reserve(model, title, idempotency_key)
        except OverflowError:
            raise HTTPException(429, '队列已满或工作目录空间不足，请等待回收后重试', headers={'Retry-After':'30'})
        except ValueError as error:
            raise HTTPException(409, str(error))
        if not created:
            result = jobs.state(job)
            if result.get('status') == 'uploading':
                raise HTTPException(409, 'Original upload is still in progress', headers={'Retry-After':'3'})
            return result
        folder = ROOT / job
        size = 0
        with (folder / 'input.part').open('wb') as target:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > 100 * 1024 * 1024:
                    raise HTTPException(413, 'Audio exceeds 100 MB')
                target.write(chunk)
        if not size:
            raise HTTPException(400, 'Empty audio')
        (folder / 'input.part').replace(folder / 'input.m4a')
        status(job, dict(status='queued'))
        pool.submit(separate, job, model)
        return dict(id=job, status='queued')
    except BaseException:
        if created:
            (ROOT / job / 'input.part').unlink(missing_ok=True)
            status(job, dict(status='failed', stage='upload', retryable=True, error='Upload interrupted or rejected; retry from NAS'))
        raise
    finally:
        await file.close()


def job_path(job):
    if len(job) != 32 or any(c not in '0123456789abcdef' for c in job):
        raise HTTPException(404, 'Unknown job')
    return ROOT / job


@app.get('/jobs/{job}', dependencies=[Depends(auth)])
def get_job(job: str):
    if not job_path(job).is_dir():
        raise HTTPException(404, 'Unknown job')
    state = jobs.state(job)
    log = ROOT / job / 'worker.log'
    if state.get('status') == 'running' and state.get('stage') == 'separating' and log.exists():
        with log.open('rb') as stream:
            stream.seek(max(0, log.stat().st_size - 5000))
            matches = re.findall(r'(\d{1,3})%\|', stream.read().decode('utf-8', errors='replace'))
        if matches:
            state['model_progress'] = min(100, int(matches[-1]))
    return state


@app.get('/artifacts/{job}', dependencies=[Depends(auth)])
def artifact(job: str):
    file = job_path(job) / 'instrumental.wav'
    return jobs.file_response(job, file, media_type='audio/wav')


if not NPU:
    from clipping import register as register_clipping
    register_clipping(app, auth, jobs, pool, job_path)
