// Isolated adversarial observations; exit 0 means observations completed, not defects fixed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server/app.js';
import { registerFavoriteBundle } from '../server/favorite-bundles.js';
import { resourceRoot } from '../server/assets.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'ktv-review-20260927-'));
const password = 'review-only-original';
const svc = createApp({dataDir:path.join(root,'db'), roots:[path.join(root,'media')], downloads:path.join(root,'downloads'), adminToken:password, worker:false, discovery:false});
const server = svc.app.listen(0, '127.0.0.1');
await new Promise(r=>server.once('listening',r));
const base = `http://127.0.0.1:${server.address().port}`;
const result = {};
async function call(url, {token, cookie, body, method = body === undefined ? 'GET' : 'POST'} = {}) {
  const response=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status, data:await response.json(), cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
try {
  const login=await call('/login',{token:password,body:{}});
  assert.equal(login.status,200);
  const member=login.data.token;
  const independent=await call('/rooms',{token:member,body:{}});
  const changed=await call('/admin/password',{cookie:login.cookie,body:{currentPassword:password,newPassword:'review-only-next'}});
  assert.equal(changed.status,200);
  result.passwordRevocation={oldAdminCookie:(await call('/admin',{cookie:login.cookie})).status,oldAdminPassword:(await call('/admin',{token:password})).status,oldRoomToken:(await call('/state',{token:member})).status,oldIndependentToken:(await call('/state',{token:independent.data.token})).status,newRoomUsingOldToken:(await call('/rooms',{token:member,body:{}})).status};
  assert.deepEqual(result.passwordRevocation,{oldAdminCookie:401,oldAdminPassword:401,oldRoomToken:200,oldIndependentToken:200,newRoomUsingOldToken:200});

  svc.store.set('favorites',{favoriteId:'123',enabled:true});
  const parts=[{bvid:'BV1reviewABC',cid:'111',page:1,title:'Review song',collectionTitle:'Review collection',url:'https://www.bilibili.com/video/BV1reviewABC?p=1'}];
  const context={store:svc.store,addJob:svc.addJob};
  const group=await registerFavoriteBundle(parts,context);
  const id=group.parts[0].downloadJob;
  assert.ok(id);
  const cancelled=await call('/admin/jobs/'+id,{token:'review-only-next',method:'DELETE'});
  assert.equal(cancelled.status,200);
  const resynced=await registerFavoriteBundle(parts,context);
  result.cancelledFavorite={deleteStatus:cancelled.status,preservedMissingJobId:resynced.parts[0].downloadJob===id,remainingJobs:svc.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='favorite-download'").get().n,bundleStatus:resynced.status};
  assert.equal(result.cancelledFavorite.remainingJobs,0);
  assert.equal(result.cancelledFavorite.preservedMissingJobId,true);
  const explicitRetry=await call('/admin/favorite-bundles/'+group.id+'/retry',{token:'review-only-next',body:{}});
  result.cancelledFavorite.explicitRetryStatus=explicitRetry.status;
  result.cancelledFavorite.jobsAfterExplicitRetry=svc.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='favorite-download'").get().n;
  assert.equal(result.cancelledFavorite.jobsAfterExplicitRetry,1);

  // Metadata traversal makes the genuine await window observable without changing production code.
  const songId='a'.repeat(24), media=path.join(root,'media'), cache=resourceRoot(media);
  const source=path.join(media,'review-source.mp4'), vocal=path.join(cache,songId+'-vocal.mp4');
  const packageBase=path.join(cache,'歌曲',songId);
  await mkdir(packageBase,{recursive:true});
  await writeFile(source,'isolated deletion fixture');
  await writeFile(vocal,'isolated legacy playback fixture');
  for(let i=0;i<250;i++) await writeFile(path.join(packageBase,`fixture-${i}.txt`),'review');
  svc.store.db.prepare("INSERT INTO songs(id,path,title,artist,status,created) VALUES(?,?,?,?,?,?)").run(songId,source,'Review race','Test','ready',Date.now());
  svc.store.set('package-base:'+songId,packageBase);
  const plan=await call('/admin/library/'+songId+'/delete-preview',{token:'review-only-next'});
  assert.equal(plan.status,200);
  const deletion=call('/admin/library/'+songId+'/delete-files',{token:'review-only-next',body:{token:plan.data.token}});
  await new Promise(r=>setTimeout(r,10));
  const enqueued=await call('/queue',{token:member,body:{songId}});
  const deleted=await deletion;
  const exists=async file=>access(file).then(()=>true,()=>false);
  result.deleteEnqueueRace={enqueueStatus:enqueued.status,deleteStatus:deleted.status,deleteError:deleted.data.error,sourceRemains:await exists(source),playbackRemains:await exists(vocal),queued:!!svc.store.db.prepare('SELECT 1 FROM queue WHERE song_id=?').get(songId),songRemains:!!svc.store.db.prepare('SELECT 1 FROM songs WHERE id=?').get(songId)};
  assert.equal(result.deleteEnqueueRace.enqueueStatus,200);
  assert.equal(result.deleteEnqueueRace.playbackRemains,false);
  assert.equal(result.deleteEnqueueRace.songRemains,true);
  svc.store.set('ai',{enabled:true});

  const online=await call('/online',{token:member,body:{url:'https://www.bilibili.com/video/BV1gF4m1K7Aa',title:'Review request',artist:'Review artist',client:'mobile',onlineSelection:true}});
  assert.equal(online.status,200);
  result.failedRequest={queuedRows:(await call('/requests/status',{token:member})).data.length};
  svc.store.db.prepare("UPDATE jobs SET status='failed',error='isolated failure' WHERE id=?").run(online.data.id);
  result.failedRequest.failedRows=(await call('/requests/status',{token:member})).data.length;
  assert.equal(result.failedRequest.queuedRows,1);
  assert.equal(result.failedRequest.failedRows,0);

  // Exhaust only the isolated server's auth budget, with cheap unauthenticated calls.
  for(let n=0;n<125;n++) await call('/health');
  const measure=async token=>{
    const start=performance.now(); const cpu=process.cpuUsage();
    let rejected=0;
    for(let n=0;n<15;n++) if((await call('/health',{token})).status===429) rejected++;
    const used=process.cpuUsage(cpu);
    return {requests:15,rejected,elapsedMs:Math.round(performance.now()-start),cpuMs:Math.round((used.user+used.system)/1000)};
  };
  result.throttledHashing={withoutPassword:await measure(),withWrongPassword:await measure('wrong-review-password')};
  assert.equal(result.throttledHashing.withWrongPassword.rejected,15);
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/review-20260927-node.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {
  server.closeAllConnections();
  await new Promise(r=>server.close(r));
  await svc.close();
  const resolved=path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));
  assert.ok(path.basename(resolved).startsWith('ktv-review-20260927-'));
  await rm(resolved,{recursive:true,force:true});
}
