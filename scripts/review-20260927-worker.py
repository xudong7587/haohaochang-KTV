"""Isolated observations using synthetic files and in-process ASGI/UDP fixtures.
No model inference, LAN probes, production credentials or production directories.
"""
import asyncio
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'separator'), str(ROOT / 'pc-worker')]
from job_store import JobStore
from clipping import execute_clip

result = {}
with tempfile.TemporaryDirectory(prefix='ktv-review-worker-') as temp:
    folder = Path(temp)
    os.environ['SEPARATION_DATA_DIR'] = str(folder)
    os.environ['SEPARATION_API_KEY'] = 'review-only-private-key'
    os.environ['SEPARATION_DEVICE'] = 'cpu'
    os.environ['KTV_VIDEO_ENCODER'] = 'cpu'
    ffmpeg = str(ROOT / 'node_modules' / 'ffmpeg-static' / 'ffmpeg.exe')
    ffprobe = str(ROOT / 'node_modules' / 'ffprobe-static' / 'bin' / 'win32' / 'x64' / 'ffprobe.exe')
    os.environ['FFMPEG'] = ffmpeg
    from fastapi.testclient import TestClient
    worker = importlib.import_module('app')
    import starlette.formparsers as parser
    original = parser.SpooledTemporaryFile
    spools = []
    def track_spool(*args, **kwargs):
        stream = original(*args, **kwargs)
        spools.append(stream)
        return stream
    with patch.object(parser, 'SpooledTemporaryFile', track_spool), TestClient(worker.app) as client:
        response = client.post('/clip', files={'file': ('review.mp4', b'x' * (2 * 1024 * 1024), 'video/mp4')}, data={'start':'0','end':'1'})
    result['unauthenticatedUpload'] = {'status':response.status_code, 'multipartTemporaryFiles':len(spools),'rolledToDisk':any(getattr(s,'_rolled',False) for s in spools)}
    assert response.status_code == 401 and result['unauthenticatedUpload']['rolledToDisk']

    # In-memory transport exercises the actual LAN route with an arbitrary private sender.
    from fastapi import FastAPI
    from lan import register
    ready=threading.Event()
    replies=[]
    class Socket:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def bind(self,address): pass
        def settimeout(self,timeout): pass
        def recvfrom(self,size):
            if replies: raise OSError('fixture complete')
            return json.dumps({'protocol':'haohaochang-lan-v1','nonce':'arbitrary-client-123456'}).encode(),('192.168.90.77',44444)
        def sendto(self,data,target):
            replies.append(json.loads(data)); ready.set()
    paired=FastAPI()
    register(paired,{'id':'review-worker','key':'review-long-lived-secret','port':8000,'lan':True},socket_factory=lambda *args:Socket())
    with TestClient(paired,client=('192.168.90.77',44444)) as client:
        assert ready.wait(2)
        response=client.post('/lan/pair',json={'challenge':replies[0]['challenge']})
        result['automaticPairing']={'status':response.status_code,'arbitraryPrivateSenderReceivesWorkerKey':response.json().get('key')=='review-long-lived-secret'}
        assert result['automaticPairing']['arbitraryPrivateSenderReceivesWorkerKey']

    # Real FFmpeg execution, no fake clip response.
    jobs=JobStore(folder / 'clip-jobs')
    job,_=jobs.reserve('clip:0:1','isolated multi-track input')
    source=jobs.root / job / 'input.mp4'
    subprocess.run([ffmpeg,'-y','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=24:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-f','lavfi','-i','sine=frequency=880:duration=2','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-c:a','aac',str(source)],check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    execute_clip(jobs,job,0,1,False,90,24,'')
    def tracks(file):
        data=json.loads(subprocess.check_output([ffprobe,'-v','error','-show_streams','-of','json',str(file)],creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)))
        return len([s for s in data['streams'] if s['codec_type']=='audio'])
    result['multiTrackClip']={'status':jobs.state(job)['status'],'inputAudioTracks':tracks(source),'outputAudioTracks':tracks(source.with_name('clip.mp4'))}
    assert result['multiTrackClip']=={'status':'done','inputAudioTracks':2,'outputAudioTracks':1}
    # Reopening the worker does not reclaim completed source/output media.
    JobStore(jobs.root).recover()
    result['completedClipRetention']={'inputRemainsAfterRecovery':source.exists(),'outputRemainsAfterRecovery':source.with_name('clip.mp4').exists()}
    for index in range(12):
        completed,_=jobs.reserve('htdemucs',f'completed fixture {index}')
        (jobs.root/completed/'input.m4a').write_bytes(b'isolated retention fixture')
        jobs.write(completed,{'status':'done'})
    JobStore(jobs.root).recover()
    result['completedClipRetention'].update(completedDirectories=len(list(jobs.root.iterdir())),pending=jobs.pending(),activeCapacity=10)
    worker.pool.shutdown(wait=True)

(ROOT/'test-results').mkdir(exist_ok=True)
(ROOT/'test-results/review-20260927-worker.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,indent=2))
