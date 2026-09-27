"""Protocol checks use temporary job storage and synthetic WAVs; no model download."""
import asyncio
import importlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave
from job_store import JobStore
from inference import validate_waves, vocal_activity, separation_timeout
import math
import struct
from upload_guard import UploadGuard


class StoreTests(unittest.TestCase):
    def test_vocal_onsets_require_sustained_energy_and_ignore_short_noise(self):
        with tempfile.TemporaryDirectory(prefix='ktv-vocal-onset-') as folder:
            file = Path(folder) / 'voice.wav'
            rate = 16000
            with wave.open(str(file), 'wb') as audio:
                audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate)
                for second in range(12):
                    samples = [int(10000 * math.sin(2 * math.pi * 220 * i / rate)) if second in (3, 6, 9) or (second == 1 and i < 800) else 0 for i in range(rate)]
                    audio.writeframes(struct.pack('<' + 'h' * rate, *samples))
            result = vocal_activity(file)
            self.assertEqual(result['onsets'], [3.0, 6.0, 9.0])
            self.assertEqual(result['duration'], 12)
    def test_cpu_timeout_is_bounded_and_can_allow_six_hours(self):
        for value, expected in [('21600', 21600), ('99999', 21600), ('bad', 1800), ('1', 1800)]:
            with patch.dict(os.environ, {'SEPARATION_TIMEOUT_SECONDS': value}):
                self.assertEqual(separation_timeout(), expected)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ktv-worker-')
        self.addCleanup(self.temp.cleanup)
        self.store = JobStore(Path(self.temp.name) / 'jobs')

    def test_restart_marks_all_unfinished_states_retryable_and_preserves_done(self):
        ids = []
        for state in ('uploading', 'queued', 'running', 'done'):
            job, _ = self.store.reserve('htdemucs', 'test')
            self.store.write(job, dict(status=state))
            (self.store.root / job / 'input.part').write_bytes(b'incomplete')
            ids.append(job)
        reopened = JobStore(self.store.root)
        reopened.recover()
        for job in ids[:3]:
            self.assertEqual(reopened.state(job)['stage'], 'interrupted')
            self.assertTrue(reopened.state(job)['retryable'])
            self.assertFalse((reopened.root / job / 'input.part').exists())
        self.assertEqual(reopened.state(ids[3])['status'], 'done')

    def test_reservations_include_uploading_and_deduplicate_across_restart(self):
        job, created = self.store.reserve('htdemucs', 'test', 'request-1', capacity=1)
        self.assertTrue(created)
        self.assertEqual(self.store.pending(), 1)
        self.assertEqual(JobStore(self.store.root).reserve('htdemucs', 'test', 'request-1'), (job, False))
        with self.assertRaises(OverflowError):
            self.store.reserve('htdemucs', 'other', capacity=1)
        with self.assertRaises(ValueError):
            self.store.reserve('htdemucs_ft', 'test', 'request-1')

    def test_parallel_reservations_do_not_exceed_capacity(self):
        import concurrent.futures
        def reserve(i):
            try:
                return self.store.reserve('htdemucs', str(i), capacity=2)
            except OverflowError:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(reserve, range(20)))
        self.assertEqual(sum(result is not None for result in results), 2)
        self.assertEqual(self.store.pending(), 2)

    def test_retention_waits_for_ack_grace_and_active_downloads(self):
        import time
        job, _ = self.store.reserve('htdemucs', 'retention', 'key')
        self.store.write(job, dict(status='done'))
        (self.store.root / job / 'instrumental.wav').write_bytes(b'result')
        self.store.acknowledge(job)
        self.store.acquire_result(job)
        future = time.time() + 3700
        self.store.cleanup(now=future, force=True)
        self.assertTrue((self.store.root / job).exists())
        self.store.release_result(job)
        self.store.cleanup(now=future, force=True)
        self.assertFalse((self.store.root / job).exists())
        new, created = self.store.reserve('htdemucs', 'retry', 'key')
        self.assertTrue(created)
        self.store.cleanup(now=future + 700000, force=True)
        self.assertTrue((self.store.root / new).exists())

    def test_unacknowledged_results_expire_and_quota_rejects_admission(self):
        import time
        job, _ = self.store.reserve('htdemucs', 'old')
        self.store.write(job, dict(status='done', updated=time.time()-604801))
        self.store.cleanup(force=True)
        self.assertFalse((self.store.root / job).exists())
        with patch.dict(os.environ, {'SEPARATION_MAX_WORK_BYTES':'0'}):
            with self.assertRaises(OverflowError): self.store.reserve('htdemucs','quota')

    def test_actual_wav_frames_reject_short_output(self):
        def create(name, duration):
            target = Path(self.temp.name) / name
            with wave.open(str(target), 'wb') as audio:
                audio.setnchannels(2)
                audio.setsampwidth(2)
                audio.setframerate(8000)
                audio.writeframes(bytes(round(duration * 8000) * 4))
            return target
        source = create('source.wav', 2)
        validate_waves(source, create('matching.wav', 2))
        with self.assertRaisesRegex(ValueError, 'duration'):
            validate_waves(source, create('short.wav', 0.2))

    def test_dashboard_polling_during_parallel_state_writes(self):
        import concurrent.futures
        import threading
        job, _ = self.store.reserve('htdemucs', 'polling')
        start = threading.Barrier(4)
        def access(writer):
            start.wait(timeout=5)
            for i in range(300):
                if writer:
                    self.store.write(job, dict(status='running', progress=i))
                else:
                    self.assertIn(self.store.state(job)['status'], ('uploading', 'running'))
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(access, writer) for writer in (True, True, False, False)]
            for future in futures:
                future.result(timeout=20)


class UploadTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_limit_applies_before_downstream_body_parser(self):
        started = asyncio.Event()
        release = asyncio.Event()
        async def downstream(scope, receive, send):
            started.set()
            await release.wait()
        guard = UploadGuard(downstream, concurrency=1)
        scope = dict(type='http', method='POST', path='/separate', headers=[])
        responses = []
        async def receive():
            return dict(type='http.request', body=b'')
        async def send(message):
            responses.append(message)
        first = asyncio.create_task(guard(scope, receive, send))
        await started.wait()
        await guard(scope, receive, send)
        self.assertEqual(responses[0]['status'], 429)
        release.set()
        await first
        # The slot is released after completion.
        await guard(scope, receive, send)

    async def test_unauthorized_upload_never_reads_body_or_calls_parser(self):
        async def forbidden(*args): self.fail('Unauthorized body was read')
        responses = []
        async def send(message): responses.append(message)
        with patch.dict(os.environ, {'SEPARATION_API_KEY':'secret'}):
            await UploadGuard(forbidden)(dict(type='http', method='POST', path='/clip', headers=[]), forbidden, send)
        self.assertEqual(responses[0]['status'],401)

    async def test_declared_large_body_rejected_without_parser(self):
        async def downstream(*args):
            self.fail('Should not parse oversized request')
        messages = []
        async def send(message):
            messages.append(message)
        await UploadGuard(downstream, max_bytes=4)(dict(type='http', method='POST', path='/separate',
            headers=[(b'content-length', b'5')]), None, send)
        self.assertEqual(messages[0]['status'], 413)


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='ktv-worker-routes-')
        cls.previous_data = os.environ.get('SEPARATION_DATA_DIR')
        cls.previous_key = os.environ.get('SEPARATION_API_KEY')
        os.environ['SEPARATION_DATA_DIR'] = cls.temp.name
        os.environ['SEPARATION_API_KEY'] = 'test-only'
        cls.module = importlib.import_module('app')
        from fastapi.testclient import TestClient
        cls.client = TestClient(cls.module.app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.module.pool.shutdown(wait=True)
        for key, value in [('SEPARATION_DATA_DIR', cls.previous_data), ('SEPARATION_API_KEY', cls.previous_key)]:
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.temp.cleanup()

    def test_legacy_submission_and_idempotent_retry_share_one_job(self):
        with patch.object(self.module.pool, 'submit') as submit:
            headers = {'Authorization':'Bearer test-only', 'Idempotency-Key':'nas-retry'}
            def post():
                return self.client.post('/separate', data={'model':'htdemucs', 'title':'测试'},
                    files={'file':('input.m4a', b'fake-input')}, headers=headers)
            first, second = post(), post()
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()['id'], second.json()['id'])
            self.assertEqual(submit.call_count, 1)
            health = self.client.get('/health', headers=headers).json()
            self.assertEqual(health['protocol'], 'ktv-separation-v1')
            self.assertTrue(health['busy'])
            self.assertEqual(self.client.get('/health').status_code, 401)
            # Existing clients without the new header are still supported.
            headers.pop('Idempotency-Key')
            legacy = post()
            self.assertEqual(legacy.status_code, 200)
            self.assertNotEqual(legacy.json()['id'], first.json()['id'])

    def test_empty_upload_fails_and_releases_pending_reservation(self):
        pending = self.module.jobs.pending()
        response = self.client.post('/separate', data={'model':'htdemucs'}, files={'file':('input.m4a', b'')},
                                    headers={'Authorization':'Bearer test-only'})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.module.jobs.pending(), pending)

    def test_clip_range_authentication_and_idempotent_retry(self):
        headers = {'Authorization':'Bearer test-only', 'Idempotency-Key':'clip-retry'}
        def post(start='1.25', end='2.75', auth=headers):
            return self.client.post('/clip', data={'start':start,'end':end,'title':'裁剪测试'}, files={'file':('input.mp4',b'fake-video')}, headers=auth)
        self.assertEqual(post(auth={}).status_code, 401)
        for start, end in [('2','1'),('-1','3'),('nan','3'),('0','inf')]:
            self.assertIn(post(start,end).status_code, (400,422))
        with patch.object(self.module.pool, 'submit') as submit:
            first, second = post(), post()
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()['id'], second.json()['id'])
            self.assertEqual(submit.call_count, 1)
            self.assertEqual(post('1','2').status_code,409)
        self.assertEqual(self.client.get('/clip-artifacts/' + first.json()['id'],headers=headers).status_code,404)

    def test_real_ffmpeg_clip_preserves_audio_video_and_requested_duration(self):
        import json
        import shutil
        import subprocess
        from clipping import execute_clip
        ffmpeg = os.getenv('FFMPEG') or shutil.which('ffmpeg')
        ffprobe = os.getenv('FFPROBE') or shutil.which('ffprobe')
        if not ffmpeg or not ffprobe:
            self.skipTest('FFmpeg and ffprobe required for real clip validation')
        job, _ = self.module.jobs.reserve('clip:1.25:2.75','real clip')
        folder = self.module.ROOT / job
        subprocess.run([ffmpeg,'-y','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=24:d=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-c:a','aac',str(folder/'input.mp4')],check=True)
        execute_clip(self.module.jobs,job,1.25,2.75)
        state=self.module.jobs.state(job)
        self.assertEqual(state['status'],'done',state)
        info=json.loads(subprocess.check_output([ffprobe,'-v','error','-show_streams','-show_format','-of','json',str(folder/'clip.mp4')]))
        self.assertLess(abs(float(info['format']['duration'])-1.5),0.15)
        self.assertEqual({s['codec_type'] for s in info['streams']},{'video','audio'})
        self.assertTrue((folder/'input.mp4').is_file())

    def test_clipping_preserves_both_audio_tracks(self):
        import json
        import shutil
        import subprocess
        from clipping import execute_clip
        ffmpeg = os.getenv('FFMPEG') or shutil.which('ffmpeg')
        ffprobe = os.getenv('FFPROBE') or shutil.which('ffprobe')
        if not ffmpeg or not ffprobe: self.skipTest('FFmpeg and ffprobe required')
        job, _ = self.module.jobs.reserve('clip:0:1', 'dual audio')
        folder = self.module.ROOT / job
        subprocess.run([ffmpeg,'-y','-v','error','-f','lavfi','-i','color=s=320x240:r=25:d=2',
            '-f','lavfi','-i','sine=frequency=440:duration=2','-f','lavfi','-i','sine=frequency=880:duration=2',
            '-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-c:a','aac',str(folder/'input.mp4')],check=True)
        execute_clip(self.module.jobs,job,0,1,False)
        self.assertEqual(self.module.jobs.state(job)['status'],'done')
        info=json.loads(subprocess.check_output([ffprobe,'-v','error','-show_streams','-of','json',str(folder/'clip.mp4')]))
        self.assertEqual(sum(s['codec_type']=='audio' for s in info['streams']),2)
        headers={'Authorization':'Bearer test-only'}
        self.assertEqual(self.client.get('/clip-artifacts/'+job,headers=headers).status_code,200)
        self.assertEqual(self.module.jobs.readers.get(job,0),0)
        self.assertEqual(self.client.post('/jobs/'+job+'/ack',headers=headers).status_code,200)

    def test_chunked_oversized_multipart_is_rejected_with_413(self):
        from fastapi import FastAPI, File, UploadFile
        from fastapi.testclient import TestClient
        limited = FastAPI()
        limited.add_middleware(UploadGuard, max_bytes=100)
        @limited.post('/separate')
        async def upload(file: UploadFile = File(...)):
            self.fail('Oversized multipart must not reach the handler')
        body = (b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="input.m4a"\r\n'
                b'Content-Type: audio/mp4\r\n\r\n' + b'a' * 200 + b'\r\n--boundary--\r\n')
        with TestClient(limited) as client:
            response = client.post('/separate', content=iter([body[:60], body[60:]]),
                headers={'Authorization':'Bearer test-only', 'Content-Type':'multipart/form-data; boundary=boundary'})
        self.assertEqual(response.status_code, 413)

    def test_video_preparation_removes_audio_and_keeps_original_input(self):
        import json
        import shutil
        import subprocess
        from clipping import execute_clip
        ffmpeg = os.getenv('FFMPEG') or shutil.which('ffmpeg')
        ffprobe = os.getenv('FFPROBE') or shutil.which('ffprobe')
        if not ffmpeg or not ffprobe: self.skipTest('FFmpeg and ffprobe required')
        job, _ = self.module.jobs.reserve('video:0:1', 'video preparation')
        folder = self.module.ROOT / job
        subprocess.run([ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=3840x2160:r=60:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(folder/'input.mp4')], check=True)
        original = (folder/'input.mp4').read_bytes()
        with patch.dict(os.environ, {'SEPARATION_DEVICE': 'cpu', 'KTV_VIDEO_ENCODER': 'cpu'}):
            execute_clip(self.module.jobs, job, 0, 1, True, 2160, 60)
        self.assertEqual(self.module.jobs.state(job)['status'], 'done')
        info = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-show_streams', '-of', 'json', str(folder/'clip.mp4')]))
        self.assertEqual([s['codec_type'] for s in info['streams']], ['video'])
        self.assertEqual(info['streams'][0]['codec_name'], 'h264')
        self.assertEqual(info['streams'][0]['width'], 3840)
        self.assertEqual(info['streams'][0]['height'], 2160)
        self.assertEqual(info['streams'][0]['avg_frame_rate'], '60/1')
        self.assertEqual((folder/'input.mp4').read_bytes(), original)

    def test_nvenc_failure_falls_back_to_cpu_for_video_only(self):
        import subprocess
        from clipping import execute_clip
        job, _ = self.module.jobs.reserve('video:0:1', 'fallback')
        (self.module.ROOT / job / 'clip.mp4').write_bytes(b'validated test output')
        with patch.dict(os.environ, {'SEPARATION_DEVICE': 'cpu', 'KTV_VIDEO_ENCODER': 'nvenc'}), patch('clipping.run_ffmpeg', side_effect=[subprocess.CalledProcessError(1, 'cuda decode'), subprocess.CalledProcessError(1, 'nvenc'), None, None]) as run:
            execute_clip(self.module.jobs, job, 0, 1, True)
        self.assertEqual(self.module.jobs.state(job)['status'], 'done')
        self.assertIn('h264_nvenc', run.call_args_list[0].args[0])
        self.assertIn('h264_nvenc', run.call_args_list[1].args[0])
        self.assertNotIn('-hwaccel', run.call_args_list[1].args[0])
        self.assertIn('libx264', run.call_args_list[2].args[0])
        self.assertIn('-an', run.call_args_list[2].args[0])
        self.assertEqual(self.module.jobs.state(job)['encoder'], 'CPU libx264')


if __name__ == '__main__':
    unittest.main()
