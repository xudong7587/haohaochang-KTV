"""Local Windows launcher. No cloud key is needed for PC inference."""
import json
import os
from pathlib import Path
import secrets
import sys

root = Path(__file__).resolve().parent
config_file = root / 'worker.json'
if not config_file.exists():
    config_file.write_text(json.dumps({'port': 8000, 'key': secrets.token_urlsafe(32), 'device': 'auto', 'host': '0.0.0.0', 'lan': True}, indent=2), encoding='utf-8')
config = json.loads(config_file.read_text(encoding='utf-8'))
config.setdefault('id', secrets.token_hex(16))
config.setdefault('lan', True)
if config['lan'] and config.get('host') in (None, '127.0.0.1', 'localhost'):
    config['host'] = '0.0.0.0'
config_file.write_text(json.dumps(config, indent=2), encoding='utf-8')
if os.getenv('KTV_LOCAL_ONLY') == '1':
    config.update(host='127.0.0.1', lan=False)
# Reopening the shortcut reuses the running local service.
import urllib.request
try:
    request = urllib.request.Request(f'http://127.0.0.1:{config["port"]}/health', headers={'Authorization': 'Bearer ' + config['key']})
    with urllib.request.urlopen(request, timeout=1) as response:
        existing = json.load(response)
    if existing.get('protocol') == 'ktv-separation-v1':
        if 'video-clip-v1' not in existing.get('capabilities', []):
            print('An older organizer is still running. Stop it before starting this update; keep worker.json, runtime and data.')
            sys.exit(1)
        desired = max(1, min(3, int(config.get('concurrency', 3 if existing.get('device') == 'cuda' else 1))))
        if existing.get('concurrency', 1) != desired:
            print('Updated concurrency requires a restart. Finish current jobs, stop the old organizer, then run start.cmd again.')
            sys.exit(1)
        if existing.get('lanEnabled', False) != config['lan']:
            print('The organizer is running in a different network mode. Stop it before changing LAN/local-only mode.')
            sys.exit(1)
        if os.environ.get('RESOURCE_AI_OPEN_UI', '0') == '1':
            import webbrowser
            webbrowser.open(f'http://127.0.0.1:{config["port"]}/ui#{config["key"]}')
        print('Resource AI organizer is already running.')
        sys.exit(0)
except (OSError, ValueError):
    pass
from hardware import detect
plan = detect()
if plan.get('gpu_index') is not None:
    os.environ['CUDA_VISIBLE_DEVICES'] = str(plan['gpu_index'])
import torch
import imageio_ffmpeg
import uvicorn

os.environ['SEPARATION_API_KEY'] = config['key']
os.environ['SEPARATION_DATA_DIR'] = str(root / 'data')
os.environ['TORCH_HOME'] = str(root / 'data' / 'models')
device = 'cpu'
reason = plan['reason']
if config.get('device', 'auto') != 'cpu' and plan['device'] == 'cuda':
    try:
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA is unavailable')
        probe = torch.ones(16, device='cuda')
        (probe * 2).sum().item()
        torch.cuda.synchronize()
        device = 'cuda'
    except Exception as error:
        reason = 'CUDA check failed; using CPU: ' + str(error)
os.environ['SEPARATION_SEGMENT'] = str(plan['segment'] if device == 'cuda' else 4)
os.environ['SEPARATION_DEVICE'] = device
os.environ['SEPARATION_CONCURRENCY'] = str(max(1, min(3, int(config.get('concurrency', 3 if device == 'cuda' else 1)))))
os.environ['FFMPEG'] = imageio_ffmpeg.get_ffmpeg_exe()
os.environ['KTV_VIDEO_ENCODER'] = str(config.get('video_encoder', 'auto')).lower()
sys.path.insert(0, str(root))
print('\n=== 好好唱资源 AI 整理器 ===')
print('Device:', torch.cuda.get_device_name(0) if device == 'cuda' else 'CPU (check NVIDIA driver if GPU was expected)')
host = config.get('host', '127.0.0.1')
print('Reason:', reason)
print(f'Listen: http://{host}:{config["port"]}')
from lan import addresses
print('Local test mode.' if not config['lan'] else 'LAN automatic connection: ' + ', '.join(f'http://{ip}:{config["port"]}' for ip in addresses()))
print('Model: htdemucs')
print('Connection key is available in the local dashboard.')
print('Keep this window open. Configuration: worker.json')
print('First separation downloads the model. Close this window to stop.\n')
import app as worker_app
from lan import register as register_lan
def persist_worker_config():
    temporary = config_file.with_suffix('.tmp')
    temporary.write_text(json.dumps(config, indent=2), encoding='utf-8')
    temporary.replace(config_file)
register_lan(worker_app.app, config, persist=persist_worker_config)
from desktop import register
server = uvicorn.Server(uvicorn.Config(worker_app.app, host=host, port=int(config['port'])))
register(worker_app.app, root, config, plan, device, lambda: setattr(server, 'should_exit', True))
ui_url = f'http://127.0.0.1:{config["port"]}/ui#{config["key"]}'
if os.environ.get('RESOURCE_AI_OPEN_UI', '0') == '1':
    import threading
    import webbrowser
    threading.Timer(2, lambda: webbrowser.open(ui_url)).start()
if os.name == 'nt' and (root / 'tray.ps1').exists():
    import subprocess
    subprocess.Popen(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                      '-File', str(root / 'tray.ps1')], cwd=root,
                     creationflags=subprocess.CREATE_NO_WINDOW)
server.run()
