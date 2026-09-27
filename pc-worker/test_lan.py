"""Discovery tests simulate UDP in memory; never probe the local network."""
import json
import threading
import unittest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from lan import private_ip, register


class LanTests(unittest.TestCase):
    def test_private_ranges_exclude_loopback_public_and_invalid(self):
        for ip in ('10.0.0.1','172.16.0.2','192.168.1.8'):
            self.assertTrue(private_ip(ip))
        for ip in ('127.0.0.1','8.8.8.8','172.32.0.1','192.168.1.999','::1'):
            self.assertFalse(private_ip(ip))

    def test_pair_requires_local_approval_then_proof_and_revocation(self):
        import queue
        import socket
        import hmac
        import hashlib
        from unittest.mock import patch
        incoming, outgoing = queue.Queue(), queue.Queue()
        class Socket:
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def bind(self,address): pass
            def settimeout(self,timeout): pass
            def recvfrom(self,size):
                try: return incoming.get(timeout=.05)
                except queue.Empty: raise socket.timeout()
            def sendto(self,data,target): outgoing.put(json.loads(data))
        app=FastAPI()
        config=dict(id='test-worker-123',key='test-private-key-1234',port=8000,lan=True)
        register(app,config,socket_factory=lambda *args:Socket())
        def challenge():
            incoming.put((json.dumps(dict(protocol='haohaochang-lan-v1',nonce='valid-nonce-123456')).encode(), ('192.168.1.10',43212)))
            reply=outgoing.get(timeout=2)
            self.assertNotIn('key',reply)
            self.assertEqual(reply['securePairing'],2)
            return reply['challenge']
        client_id='nas-client-123456789'
        with patch.dict('os.environ',{}), TestClient(app,client=('192.168.1.10',43212)) as remote:
            first=challenge()
            result=remote.post('/lan/pair',json={'challenge':first,'clientId':client_id})
            self.assertEqual(result.status_code,403)
            self.assertNotIn(config['key'],result.text)
            request_id=app.state.lan['pending'][0]['id']
            headers={'Authorization':'Bearer '+config['key']}
            self.assertEqual(remote.post('/lan/approve',json={'id':request_id},headers=headers).status_code,403)
            # Only loopback plus the local UI credential can approve.
            local=TestClient(app,client=('127.0.0.1',5000))
            self.assertEqual(local.post('/lan/approve',json={'id':request_id}).status_code,403)
            self.assertEqual(local.post('/lan/approve',json={'id':request_id},headers=headers).status_code,200)
            fresh=challenge()
            approved=remote.post('/lan/pair',json={'challenge':fresh,'clientId':client_id})
            self.assertEqual(approved.json()['key'],config['key'])
            self.assertEqual(remote.post('/lan/pair',json={'challenge':fresh,'clientId':client_id}).status_code,403)
            fresh=challenge()
            proof=hmac.new(config['key'].encode(),(fresh+'\n'+client_id).encode(),hashlib.sha256).hexdigest()
            self.assertEqual(remote.post('/lan/pair',json={'challenge':fresh,'clientId':client_id,'proof':proof}).status_code,200)
            old=config['key']
            self.assertEqual(local.post('/lan/revoke',headers=headers).status_code,200)
            self.assertNotEqual(old,config['key'])
            fresh=challenge()
            proof=hmac.new(old.encode(),(fresh+'\n'+client_id).encode(),hashlib.sha256).hexdigest()
            self.assertEqual(remote.post('/lan/pair',json={'challenge':fresh,'clientId':client_id,'proof':proof}).status_code,403)
            local.close()
