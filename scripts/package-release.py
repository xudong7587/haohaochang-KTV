"""Build public bundles from explicit files; never include local credentials or models."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import hashlib
import argparse
import re

options = argparse.ArgumentParser()
selection = options.add_mutually_exclusive_group()
selection.add_argument('--pc-only', action='store_true', help='Build the PC bundle without requiring a signed TV APK')
selection.add_argument('--nas-only', action='store_true', help='Refresh NAS configuration and guides without changing PC or APK releases')
args = options.parse_args()

root = Path(__file__).resolve().parents[1]
release = root / 'release'
release.mkdir(exist_ok=True)
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
tv_version = re.search(r"versionName '([^']+)'", (root / 'android/app/build.gradle').read_text(encoding='utf-8')).group(1)
guide = (root / 'docs/USER-GUIDE.md').read_text(encoding='utf-8')
for document in ['VALIDATION.md', 'DEVELOPMENT.md', 'PROJECT-STATUS.md', 'NAS安装与升级.md', 'NPU.md']:
    guide = guide.replace('(' + document + ')', '(https://github.com/xudong7587/haohaochang-KTV/blob/main/docs/' + document + ')')
guide = guide.replace('(../pc-worker/README.md)', '(https://github.com/xudong7587/haohaochang-KTV/blob/main/pc-worker/README.md)')

bundles = {
    f'haohaochang-nas-v{version}.zip': ['docker-compose.yaml', 'docker-compose.arm64.yaml', 'deploy/separation-images.json', 'docs/NAS安装与升级.md', 'docs/NPU.md', f'release/haohaochang-tv-v{tv_version}.apk', 'release/实机测试说明.md'],
    f'haohaochang-resource-ai-v{version}.zip': ['pc-worker/open.vbs', 'pc-worker/open.ps1', 'pc-worker/start.cmd', 'pc-worker/start.ps1', 'pc-worker/run.py', 'pc-worker/hardware.py',
        'pc-worker/download_runtime.py', 'pc-worker/desktop.py', 'pc-worker/lan.py', 'pc-worker/version.py', 'pc-worker/updater.py', 'pc-worker/update_source.py', 'pc-worker/update_runner.py', 'pc-worker/tray.ps1', 'pc-worker/README.md', 'separator/app.py', 'separator/clipping.py', 'separator/job_store.py', 'separator/inference.py', 'separator/upload_guard.py', 'separator/requirements.txt',
        'separator/video_encoding.py', 'pc-worker/ui/index.html', 'pc-worker/ui/update.js', 'pc-worker/ui/icon.svg', 'pc-worker/ui/icon.png', 'pc-worker/ui/icon.ico'],
}
for name, files in bundles.items():
    if args.pc_only and name != f'haohaochang-resource-ai-v{version}.zip':
        continue
    if args.nas_only and name != f'haohaochang-nas-v{version}.zip':
        continue
    with ZipFile(release / name, 'w', ZIP_DEFLATED) as archive:
        hashes = {}
        for source in files:
            relative = source.removeprefix('pc-worker/') if source.startswith('pc-worker/ui/') else Path(source).name
            archive.write(root / source, relative)
            hashes[relative] = hashlib.sha256((root / source).read_bytes()).hexdigest()
        archive.writestr('四端使用说明.md', guide)
        hashes['四端使用说明.md'] = hashlib.sha256(guide.encode('utf-8')).hexdigest()
        if name == f'haohaochang-resource-ai-v{version}.zip':
            archive.writestr('update-manifest.json', json.dumps(dict(version=version, files=hashes)))
    with ZipFile(release / name) as archive:
        assert archive.testzip() is None
        assert not any('worker.json' in item or 'settings.json' in item or '.venv' in item for item in archive.namelist())
    print(name, (release / name).stat().st_size)

if args.nas_only:
    raise SystemExit(0)

# A fixed-name Release attachment lets clients discover a version without the
# unauthenticated REST API. Its package URL is pinned to this exact release.
pc_archive = release / f'haohaochang-resource-ai-v{version}.zip'
notes_file = release / f'RELEASE-NOTES-v{version}.md'
index = dict(schema=1, version=version,
             notes=notes_file.read_text(encoding='utf-8')[:3000] if notes_file.exists() else '',
             pc=dict(url=f'https://github.com/xudong7587/haohaochang-KTV/releases/download/v{version}/{pc_archive.name}',
                     size=pc_archive.stat().st_size, sha256=hashlib.sha256(pc_archive.read_bytes()).hexdigest()))
(release / 'haohaochang-pc-update.json').write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

# Standalone Windows rename tool uses the same layout as the installed NAS share.
if args.pc_only:
    raise SystemExit(0)
with ZipFile(release / f'haohaochang-preprocess-v{version}.zip', 'w', ZIP_DEFLATED) as archive:
    for source, target in [
        ('启动重命名.cmd', '好好唱重命名.cmd'),
        ('重命名.ps1', 'RenameTool/app.ps1'),
        ('core.ps1', 'RenameTool/core.ps1'),
        ('使用说明.txt', 'RenameTool/使用说明.txt'),
    ]:
        archive.write(root / 'tools/bili-preprocess' / source, target)
with ZipFile(release / f'haohaochang-preprocess-v{version}.zip') as archive:
    assert archive.testzip() is None
print(f'haohaochang-preprocess-v{version}.zip', (release / f'haohaochang-preprocess-v{version}.zip').stat().st_size)
