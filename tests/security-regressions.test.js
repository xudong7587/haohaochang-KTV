import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { createAdminAuth } from "../server/admin-auth.js";
import {
  quarantineDeletion,
  recoverDeletions,
} from "../server/song-deletion.js";
import { resourceRoot } from "../server/assets.js";

test("password work is asynchronous, bounded and throttled before KDF", async () => {
  const values = new Map([["adminPasswordHash", { salt: "salt", hash: "ff" }]]);
  let calls = 0,
    releases = [];
  const auth = createAdminAuth(
    { get: (k, d) => values.get(k) ?? d, set: (k, v) => values.set(k, v) },
    "",
    {
      kdf: () => {
        calls++;
        return new Promise((r) =>
          releases.push(() => r(Buffer.from("00", "hex"))),
        );
      },
    },
  );
  const req = { ip: "local", get: () => "" };
  const first = auth.authenticate(req, "wrong1"),
    second = auth.authenticate(req, "wrong2");
  await assert.rejects(auth.authenticate(req, "wrong3"), { status: 429 });
  assert.equal(calls, 2);
  releases.splice(0).forEach((r) => r());
  await Promise.all([first, second]);
  for (let n = 0; n < 27; n++) {
    const work = auth.authenticate(req, "wrong");
    releases.pop()();
    await work;
  }
  await assert.rejects(auth.authenticate(req, "wrong"), { status: 429 });
  assert.equal(calls, 29);
});

test("deletion rolls back files on DB failure and recovers interrupted moves", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-delete-recovery-"));
  const svc = createApp({
    dataDir: path.join(dir, "data"),
    roots: [dir],
    adminToken: "test-password",
    worker: false,
    discovery: false,
  });
  t.after(async () => {
    await svc.close();
    await rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "song.mp4");
  await writeFile(file, "original");
  svc.store.db
    .prepare(
      "INSERT INTO songs(id,path,title,artist,created) VALUES(?,?,?,'test',?)",
    )
    .run("song", file, "song", Date.now());
  assert.throws(
    () =>
      quarantineDeletion(
        svc.store,
        "song",
        [{ path: file, directory: false }],
        [dir],
        () => {
          svc.store.db.prepare("DELETE FROM songs WHERE id='song'").run();
          throw new Error("simulated DB failure");
        },
      ),
    /simulated/,
  );
  assert.equal(await readFile(file, "utf8"), "original");
  assert.ok(svc.store.db.prepare("SELECT id FROM songs WHERE id='song'").get());
  const staged = path.join(dir, ".ktv-delete-test");
  renameSync(file, staged);
  svc.store.set("deletion:song", {
    committed: false,
    targets: [{ path: file, staged, directory: false }],
  });
  recoverDeletions(svc.store, [dir]);
  assert.equal(await readFile(file, "utf8"), "original");
  renameSync(file, staged);
  svc.store.set("deletion:song", {
    committed: true,
    targets: [{ path: file, staged, directory: false }],
  });
  recoverDeletions(svc.store, [dir]);
  await assert.rejects(access(staged));
});

test("changing password revokes room access; deletion blocks concurrent enqueue; failed requests stay visible", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-security-")),
    media = path.join(dir, "media");
  const svc = createApp({
    dataDir: path.join(dir, "data"),
    roots: [media],
    adminToken: "old-password",
    worker: false,
    discovery: false,
  });
  const server = svc.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await svc.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (route, token, body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = await (await call("/login", "old-password", {})).json(),
    old = login.token;
  const room = await (await call("/rooms", old, {})).json();
  assert.equal(
    (
      await call("/admin/password", "old-password", {
        currentPassword: "old-password",
        newPassword: "new-password",
      })
    ).status,
    200,
  );
  assert.equal((await call("/state", old)).status, 401);
  assert.equal((await call("/state", room.token)).status, 401);
  const member = (await (await call("/login", "new-password", {})).json())
    .token;
  const id = "a".repeat(24),
    source = path.join(media, "source.mp4"),
    cache = resourceRoot(media),
    folder = path.join(cache, "歌曲", id);
  await mkdir(folder, { recursive: true });
  await writeFile(source, "fixture");
  await writeFile(path.join(cache, id + "-vocal.mp4"), "fixture");
  for (let i = 0; i < 100; i++)
    await writeFile(path.join(folder, `file-${i}`), "fixture");
  svc.store.db
    .prepare(
      "INSERT INTO songs(id,path,title,artist,status,created) VALUES(?,?,?,'test',?,?)",
    )
    .run(id, source, "song", "ready", Date.now());
  svc.store.set("package-base:" + id, folder);
  const plan = await (
    await call("/admin/library/" + id + "/delete-preview", "new-password")
  ).json();
  const deletion = call(
    "/admin/library/" + id + "/delete-files",
    "new-password",
    { token: plan.token },
  );
  while (
    !svc.store.get("deletion:" + id) &&
    svc.store.db.prepare("SELECT id FROM songs WHERE id=?").get(id)
  )
    await new Promise((r) => setTimeout(r, 1));
  assert.notEqual((await call("/queue", member, { songId: id })).status, 200);
  assert.equal((await deletion).status, 200);
  assert.equal(
    svc.store.db.prepare("SELECT id FROM queue WHERE song_id=?").get(id),
    undefined,
  );
  svc.store.set("ai", { enabled: true });
  const requested = await call("/online", member, {
    url: "https://www.bilibili.com/video/BV1gF4m1K7Aa",
    title: "Test",
    artist: "Test",
    client: "mobile",
    onlineSelection: true,
  });
  assert.equal(requested.status, 200);
  const job = await requested.json();
  svc.store.db
    .prepare("UPDATE jobs SET status='failed',error='failure' WHERE id=?")
    .run(job.id);
  const requests = await (await call("/requests/status", member)).json();
  assert.ok(requests.some((r) => r.id === job.id && r.status === "failed"));
});
