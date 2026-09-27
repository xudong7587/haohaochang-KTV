"""Local discovery: no secrets in broadcasts; one-use pairing bound to sender IP."""
import hashlib
import hmac
import os
import ipaddress
import json
import secrets
import socket
import threading
import time
from fastapi import Request, HTTPException


def private_ip(value):
    try:
        ip = ipaddress.IPv4Address(value)
        return any(ip in ipaddress.ip_network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
    except ValueError:
        return False


def addresses():
    import psutil
    return list(dict.fromkeys(a.address for rows in psutil.net_if_addrs().values() for a in rows
                             if a.family == socket.AF_INET and private_ip(a.address)))


def register(app, config, socket_factory=socket.socket, persist=lambda: None):
    challenges = {}
    pending = {}
    lock = threading.Lock()
    stop = threading.Event()
    state = {'enabled': config.get('lan', True), 'status': 'starting', 'last_paired': None}
    app.state.lan = state

    def clean_pending():
        for request_id, item in list(pending.items()):
            if item['expires'] <= time.monotonic():
                del pending[request_id]
        state['pending'] = [dict(id=k, address=v['address'], code=v['code']) for k,v in pending.items() if not v.get('approved')]

    async def body(request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 1024: raise HTTPException(413, 'Pair request too large')
        try:
            value = json.loads(raw)
            if not isinstance(value, dict): raise ValueError()
            return value
        except (ValueError, AttributeError):
            raise HTTPException(400, 'Invalid pairing request')

    def local_admin(request):
        if request.client.host not in ('127.0.0.1', '::1') or not hmac.compare_digest(
            request.headers.get('authorization', ''), 'Bearer ' + config['key']):
            raise HTTPException(403, 'Please approve pairing on the PC itself')

    @app.post('/lan/approve')
    async def approve(request: Request):
        local_admin(request)
        value = await body(request)
        with lock:
            clean_pending()
            item = pending.get(str(value.get('id', '')))
            if not item: raise HTTPException(410, 'Pairing request expired')
            item['approved'] = True
            clean_pending()
        return {'ok': True}

    @app.post('/lan/revoke')
    async def revoke(request: Request):
        local_admin(request)
        with lock:
            old = config['key']
            config['key'] = secrets.token_urlsafe(32)
            try: persist()
            except Exception:
                config['key'] = old
                raise
            os.environ['SEPARATION_API_KEY'] = config['key']
            pending.clear(); challenges.clear(); clean_pending()
            state['last_paired'] = None
        return {'ok': True, 'key': config['key']}

    @app.post('/lan/pair')
    async def pair(request: Request):
        if not state['enabled'] or not private_ip(request.client.host):
            raise HTTPException(403, 'LAN pairing only')
        value = await body(request)
        challenge = value.get('challenge', '')
        client = value.get('clientId', '')
        if not isinstance(challenge, str) or not isinstance(client, str) or not 16 <= len(client) <= 80:
            raise HTTPException(400, 'Invalid pairing identity')
        with lock:
            proof = challenges.pop(challenge, None)
            if not proof or proof[0] != request.client.host or proof[1] < time.monotonic():
                raise HTTPException(403, 'Discovery challenge expired')
            expected = hmac.new(config['key'].encode(), (challenge + '\n' + client).encode(), hashlib.sha256).hexdigest()
            authenticated = isinstance(value.get('proof'), str) and hmac.compare_digest(value['proof'], expected)
            clean_pending()
            item_id = next((k for k,v in pending.items() if v['client'] == client and v['address'] == request.client.host), None)
            if not authenticated and (not item_id or not pending[item_id].get('approved')):
                if not item_id:
                    if len(pending) >= 16: raise HTTPException(429, 'Too many pairing requests')
                    item_id = secrets.token_hex(16)
                    pending[item_id] = dict(client=client, address=request.client.host, code=str(secrets.randbelow(900000)+100000), expires=time.monotonic()+120)
                clean_pending()
                raise HTTPException(403, '请在 PC 整理器本机确认配对码 ' + pending[item_id]['code'])
            if item_id: del pending[item_id]
            clean_pending()
            state['last_paired'] = request.client.host
            return dict(id=config['id'], key=config['key'])

    def listen():
        with socket_factory(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            try:
                sock.bind(('0.0.0.0', 43211))
                sock.settimeout(1)
                state['status'] = 'listening'
                while not stop.is_set():
                    try:
                        raw, sender = sock.recvfrom(2048)
                    except socket.timeout:
                        continue
                    if not private_ip(sender[0]):
                        continue
                    try:
                        value = json.loads(raw)
                        nonce = value.get('nonce', '')
                        if value.get('protocol') != 'haohaochang-lan-v1' or not isinstance(nonce, str) or not 16 <= len(nonce) <= 100:
                            continue
                    except (ValueError, AttributeError):
                        continue
                    now = time.monotonic()
                    with lock:
                        for key in list(challenges):
                            if challenges[key][1] < now:
                                del challenges[key]
                        if len(challenges) >= 128:
                            continue
                        challenge = secrets.token_urlsafe(32)
                        challenges[challenge] = (sender[0], now + 30)
                    sock.sendto(json.dumps(dict(protocol='haohaochang-lan-v1', nonce=nonce,
                        id=config['id'], name=socket.gethostname(), port=int(config['port']), challenge=challenge, securePairing=2, proof=hmac.new(config['key'].encode(), (nonce + '\n' + challenge + '\n' + config['id']).encode(), hashlib.sha256).hexdigest())).encode(), sender)
            except OSError as error:
                state.update(status='error', error=str(error))

    @app.on_event('startup')
    def startup():
        if state['enabled']:
            threading.Thread(target=listen, daemon=True, name='lan-discovery').start()

    @app.on_event('shutdown')
    def shutdown():
        stop.set()
