"""Accurate video trimming shares the worker queue with separation."""
import math
import os
import subprocess
import hashlib
import threading
import time
from fastapi import Depends, File, Form, Header, HTTPException, UploadFile
from video_encoding import encoder_plans, video_filter


def run_ffmpeg(command, jobs, job, stage, duration, log, timeout=1800):
    command = command[:1] + ['-progress', 'pipe:1', '-nostats', '-stats_period', '0.5'] + command[1:]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log, text=True,
        encoding='utf-8', errors='replace', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    expired = threading.Event()
    def stop():
        expired.set()
        process.kill()
    timer = threading.Timer(timeout, stop)
    timer.daemon = True
    timer.start()
    latest = 0
    try:
        for line in process.stdout:
            key, _, value = line.strip().partition('=')
            if key == 'out_time_us' and time.monotonic() - latest >= 0.5:
                try:
                    percent = min(99, max(0, round(float(value) / 1000000 / max(duration, 0.1) * 100)))
                    jobs.write(job, dict(status='running', stage=stage,
                        media_progress=dict(label='PC画面校验' if stage == 'validating-video-pc' else 'PC画面转换', percent=percent)))
                    latest = time.monotonic()
                except ValueError:
                    pass
        code = process.wait()
        if expired.is_set(): raise subprocess.TimeoutExpired(command, timeout)
        if code: raise subprocess.CalledProcessError(code, command)
    finally:
        timer.cancel()
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()


def execute_clip(jobs, job, start, end, video_only=False, video_height=1080, video_fps=30, video_transfer=''):
    folder = jobs.root / job
    jobs.write(job, dict(status='running', stage='preparing-video-pc' if video_only else 'clipping'))
    try:
        with (folder / 'worker.log').open('wb') as log:
            command = [os.getenv('FFMPEG', 'ffmpeg'), '-nostdin', '-y', '-v', 'error',
                '-ss', str(start), '-i', str(folder / 'input.mp4'), '-t', str(end-start),
                '-map', '0:v:0']
            if video_only:
                command += ['-an', '-vf', video_filter(video_transfer), '-pix_fmt', 'yuv420p']
            else:
                command += ['-map', '0:a', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']
                if video_transfer: command += ['-vf', video_filter(video_transfer)]
            if video_transfer: command += ['-color_trc', 'bt709', '-color_primaries', 'bt709', '-colorspace', 'bt709']
            encoders = encoder_plans(command[0], video_height, video_fps, video_only)
            gpu = False
            for index, (encoder, name, gpu_decode) in enumerate(encoders):
                if gpu_decode and (not video_only or video_transfer in ('smpte2084', 'arib-std-b67')):
                    continue
                log.write(('Video encoder: ' + name + '\n').encode('utf-8')); log.flush()
                try:
                    selected = list(command)
                    if gpu_decode:
                        selected[1:1] = ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']
                        selected[selected.index('-vf') + 1] = "scale_cuda=w=iw:h=ih:format=yuv420p"
                        pixel = selected.index('-pix_fmt')
                        del selected[pixel:pixel + 2]
                    run_ffmpeg(selected + encoder + ['-fps_mode', 'passthrough', '-movflags', '+faststart', str(folder / 'clip.mp4')],
                        jobs, job, 'preparing-video-pc' if video_only else 'clipping', end-start, log)
                    gpu = gpu_decode
                    break
                except subprocess.CalledProcessError:
                    if index == len(encoders) - 1: raise
                    log.write(b'Encoder attempt failed; trying the next PC encoder.\n'); log.flush()
            jobs.write(job, dict(status='running', stage='validating-video-pc'))
            validate = [os.getenv('FFMPEG', 'ffmpeg'), '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode']
            tail = ['-i', str(folder / 'clip.mp4'), '-map', '0', '-f', 'null', '-']
            try:
                run_ffmpeg(validate + (['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] if gpu else []) + tail,
                    jobs, job, 'validating-video-pc', end-start, log)
            except subprocess.CalledProcessError:
                if not gpu: raise
                run_ffmpeg(validate + ['-threads', '2'] + tail, jobs, job, 'validating-video-pc', end-start, log)
        digest = hashlib.sha256()
        with (folder / 'clip.mp4').open('rb') as result:
            while chunk := result.read(1024 * 1024): digest.update(chunk)
        jobs.write(job, dict(status='done', stage='done', encoder=name, video_url=f'/clip-artifacts/{job}',
            validation=dict(decoded=True, sha256=digest.hexdigest())))
    except (OSError, subprocess.SubprocessError) as error:
        jobs.write(job, dict(status='failed', stage='preparing-video-pc' if video_only else 'clipping', error=str(error)[-600:]))


def register(app, auth, jobs, pool, job_path):
    @app.post('/clip', dependencies=[Depends(auth)])
    async def submit(file: UploadFile = File(...), start: float = Form(...), end: float = Form(...),
                     title: str = Form(default=''), video_only: bool = Form(default=False), video_height: int = Form(default=1080),
                     video_fps: float = Form(default=30), video_transfer: str = Form(default=''), idempotency_key: str = Header(default='')):
        created = False
        job = None
        try:
            if not all(math.isfinite(n) for n in (start, end)) or start < 0 or end <= start or end > 21600:
                raise HTTPException(400, 'Invalid clip range')
            if not 1 <= video_height <= 16384 or not math.isfinite(video_fps) or not 0 < video_fps <= 1000:
                raise HTTPException(400, 'Invalid video dimensions or frame rate')
            if video_transfer not in ('', 'smpte2084', 'arib-std-b67'):
                raise HTTPException(400, 'Unsupported HDR transfer')
            if len(idempotency_key) > 120 or any(not (c.isascii() and (c.isalnum() or c in '_-')) for c in idempotency_key):
                raise HTTPException(400, 'Invalid idempotency key')
            try:
                job, created = jobs.reserve(f'{"video" if video_only else "clip"}:{start}:{end}', title, idempotency_key)
            except OverflowError:
                raise HTTPException(429, '队列已满或工作目录空间不足，请等待回收后重试')
            except ValueError as error:
                raise HTTPException(409, str(error))
            if not created:
                result = jobs.state(job)
                if result.get('status') == 'uploading':
                    raise HTTPException(409, 'Upload in progress')
                return result
            folder = jobs.root / job
            size = 0
            with (folder / 'input.part').open('wb') as target:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > 4 * 1024**3:
                        raise HTTPException(413, 'Video exceeds 4 GB')
                    target.write(chunk)
            if not size:
                raise HTTPException(400, 'Empty video')
            (folder / 'input.part').replace(folder / 'input.mp4')
            jobs.write(job, dict(status='queued', stage='clipping'))
            pool.submit(execute_clip, jobs, job, start, end, video_only, video_height, video_fps, video_transfer)
            return dict(id=job, status='queued')
        except BaseException:
            if created:
                (jobs.root / job / 'input.part').unlink(missing_ok=True)
                jobs.write(job, dict(status='failed', stage='upload', error='Upload interrupted; retry from NAS'))
            raise
        finally:
            await file.close()

    @app.get('/clip-artifacts/{job}', dependencies=[Depends(auth)])
    def artifact(job: str):
        file = job_path(job) / 'clip.mp4'
        return jobs.file_response(job, file, media_type='video/mp4')
