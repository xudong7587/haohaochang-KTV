"""Local dashboard for the resource AI worker; all operational data require its key."""
import json
import os
import subprocess
import time
import re
from pathlib import Path
from fastapi import Depends, HTTPException
from pydantic import BaseModel
from fastapi.responses import FileResponse
import psutil


def register(app, root, config, plan, device, stop=lambda: None):
    from app import auth, ROOT, CONCURRENCY, jobs as job_store
    from lan import addresses
    started = time.time()
    from updater import UpdateManager
    from version import VERSION
    updater = UpdateManager(root, job_store, config, stop)
    app.state.updater = updater

    class InstallRequest(BaseModel):
        version: str

    @app.post('/desktop/update/check', dependencies=[Depends(auth)])
    def check_update():
        return updater.check()

    @app.post('/desktop/update/install', dependencies=[Depends(auth)])
    def install_update(body: InstallRequest):
        try:
            return updater.install(body.version)
        except ValueError as error:
            raise HTTPException(409, str(error))

    @app.post('/desktop/update/cancel', dependencies=[Depends(auth)])
    def cancel_update():
        try:
            return updater.cancel()
        except ValueError as error:
            raise HTTPException(409, str(error))

    @app.post('/desktop/shutdown', dependencies=[Depends(auth)])
    def shutdown():
        if updater.snapshot()['phase'] in ('checking', 'downloading', 'waiting', 'installing', 'restarting'):
            raise HTTPException(409, '请先取消更新或等待更新完成')
        job_store.pause()
        if job_store.pending():
            job_store.resume()
            raise HTTPException(409, '当前任务尚未完成，请完成后再退出')
        stop()
        return {'stopping': True}

    @app.get('/ui', include_in_schema=False)
    def ui():
        return FileResponse(root / 'ui' / 'index.html')

    @app.get('/icon.svg', include_in_schema=False)
    def icon():
        return FileResponse(root / 'ui' / 'icon.svg', media_type='image/svg+xml')

    @app.get('/update.js', include_in_schema=False)
    def update_script():
        return FileResponse(root / 'ui' / 'update.js', media_type='text/javascript')

    @app.get('/desktop/status', dependencies=[Depends(auth)])
    def dashboard():
        jobs = []
        with job_store.lock:
            files = sorted(ROOT.glob('*/state.json'), key=lambda p: p.stat().st_mtime, reverse=True)
        finished_count = 0
        for file in files:
            try:
                state = job_store.state(file.parent.name)
                if state.get('status') not in ('uploading', 'queued', 'running'):
                    if finished_count >= 40:
                        continue
                    finished_count += 1
                info = file.parent / 'info.json'
                state.update(json.loads(info.read_text(encoding='utf-8')) if info.exists() else {})
                state['updated'] = file.stat().st_mtime
                log = file.parent / 'worker.log'
                if log.exists():
                    with log.open('rb') as stream:
                        stream.seek(max(0, log.stat().st_size - 5000))
                        state['log'] = stream.read().decode('utf-8', errors='replace')
                    matches = re.findall(r'(\d{1,3})%\|', state['log'])
                    if matches and state.get('status') == 'running' and state.get('stage') == 'separating':
                        state['model_progress'] = min(100, int(matches[-1]))
                state['elapsed_seconds'] = max(0, int((state.get('updated', time.time()) if state.get('status') in ('done', 'failed') else time.time()) - state.get('created', time.time())))
                if str(state.get('model', '')).startswith('clip:'):
                    state['model'] = '视频裁剪'
                elif str(state.get('model', '')).startswith('video:'):
                    state['model'] = '画面转码'
                jobs.append(state)
            except (OSError, ValueError):
                continue
        active = [j for j in jobs if j.get('status') in ('uploading', 'queued', 'running')]
        recent = [j for j in jobs if j not in active][:40]
        jobs = sorted(active, key=lambda j: j.get('status') != 'running') + recent
        memory = psutil.virtual_memory()
        gpu = None
        if device == 'cuda':
            try:
                result = subprocess.run(['nvidia-smi', '-i', str(plan.get('gpu_index', 0)),
                    '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,utilization.encoder,utilization.decoder',
                    '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True)
                values = []
                for value in result.stdout.strip().split(','):
                    try: values.append(float(value.strip()))
                    except ValueError: values.append(None)
                compute, used, total, temperature, encoder, decoder = values
                gpu = dict(utilization=compute, used_mb=used, total_mb=total, temperature=temperature,
                    encoder=encoder, decoder=decoder, busiest=max((v for v in (compute, encoder, decoder) if v is not None), default=None))
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        return dict(version=VERSION, update=updater.snapshot(), lan=getattr(app.state, 'lan', {}), addresses=[f'http://{ip}:{config["port"]}' for ip in addresses()], name='好好唱资源 AI 整理器', device=device, gpu_name=plan.get('gpu_name'),
                    model='htdemucs', segment=float(os.environ.get('SEPARATION_SEGMENT', 4)),
                    runtime=plan['runtime'], host=config.get('host', '127.0.0.1'), port=config['port'],
                    uptime=round(time.time()-started), cpu=psutil.cpu_percent(),
                    memory=dict(used_gb=round(memory.used/1024**3, 1), total_gb=round(memory.total/1024**3, 1), percent=memory.percent),
                    gpu=gpu, concurrency=CONCURRENCY, jobs=jobs)
