import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { resourceRoot } from "../server/assets.js";
import { createApp } from "../server/app.js";
import {
  canonicalVideo,
  scanLibrary,
  searchText,
  inside,
} from "../server/media.js";
import { providerConfig, testProvider } from "../server/separation.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-test-")),
    root = path.join(dir, "media");
  await mkdir(root);
  const service = createApp({
    dataDir: path.join(dir, "data"),
    roots: [root],
    adminToken: "test-password-12345",
    worker: false,
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (
    url,
    body,
    method = "GET",
    token = service.store.get("roomToken"),
  ) => {
    const r = await fetch(base + "/api" + url, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  const seed = (id, title, status = "ready") => {
    service.store.db
      .prepare(
        "INSERT INTO songs (id,path,title,artist,search,created,status) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        path.join(root, id + ".mp4"),
        title,
        "测试歌手",
        searchText(title, "测试歌手"),
        Date.now(),
        status,
      );
    if (status === "ready")
      writeFileSync(
        path.join(resourceRoot(root), id + "-vocal.mp4"),
        "fixture for HTTP state tests",
      );
  };
  return { ...service, base, root, dir, call, seed };
}
test("browser cookie lasts a week and changing password revokes old credentials", async (t) => {
  const f = await fixture(t);
  const request = (
    url,
    { cookie = "", password = "", method = "GET", body } = {},
  ) =>
    fetch(f.base + "/api" + url, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(password ? { Authorization: `Bearer ${password}` } : {}),
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const login = await request("/login", {
    method: "POST",
    password: "test-password-12345",
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /Max-Age=604800/);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/admin", { cookie })).status, 200);
  assert.equal(
    (
      await request("/admin/password", {
        cookie,
        method: "POST",
        body: { currentPassword: "bad", newPassword: "123456" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/admin/password", {
        cookie,
        method: "POST",
        body: { currentPassword: "test-password-12345", newPassword: "12345" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/admin/password", {
        cookie,
        method: "POST",
        body: { currentPassword: "test-password-12345", newPassword: "123456" },
      })
    ).status,
    200,
  );
  assert.equal((await request("/admin", { cookie })).status, 401);
  assert.equal(
    (await request("/admin", { password: "test-password-12345" })).status,
    401,
  );
  assert.equal((await request("/admin", { password: "123456" })).status, 200);
  assert.equal(
    (await request("/login", { method: "POST", password: "123456" })).status,
    200,
  );
});
test("authentication, admin isolation, proxy origin independence and UTF-8 token safety", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/state", undefined, "GET", "")).status, 401);
  assert.equal(
    (
      await fetch(
        f.base + "/api/state?token=" + encodeURIComponent("你".repeat(48)),
      )
    ).status,
    401,
  );
  assert.equal((await f.call("/admin")).status, 401);
  assert.equal(
    (await f.call("/admin", undefined, "GET", "test-password-12345")).status,
    200,
  );
  assert.equal(
    (
      await fetch(f.base + "/api/reactions", {
        method: "POST",
        headers: {
          Origin: "https://evil.test",
          "Content-Type": "application/json",
          Authorization: "Bearer " + f.store.get("roomToken"),
        },
        body: '{"emoji":"👏"}',
      })
    ).status,
    200,
  );
});
test("queue deduplicates simultaneous requests and guards stale next", async (t) => {
  const f = await fixture(t);
  f.seed("a", "第一首");
  f.seed("b", "第二首");
  f.seed("c", "第三首");
  await Promise.all(
    Array.from({ length: 8 }, () => f.call("/queue", { songId: "a" }, "POST")),
  );
  await f.call("/queue", { songId: "b" }, "POST");
  await f.call("/queue", { songId: "c" }, "POST");
  let state = (await f.call("/state")).data;
  assert.equal(state.queue.length, 3);
  await f.call(`/queue/${state.queue[2].id}/top`, {}, "POST");
  assert.deepEqual(
    (await f.call("/state")).data.queue.map((q) => q.song_id),
    ["a", "c", "b"],
  );
  assert.equal(
    (await f.call(`/queue/${state.queue[0].id}`, undefined, "DELETE")).status,
    409,
  );
  const results = await Promise.all([
    f.call("/control", { action: "next", entryId: state.queue[0].id }, "POST"),
    f.call("/control", { action: "next", entryId: state.queue[0].id }, "POST"),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await f.call("/state")).data.queue.length, 2);
});
test("first request prepares once, artist and pinyin search, audio fallback tagging", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "周杰伦 - 晴天.mp3"), "fixture");
  await writeFile(path.join(f.root, "周杰伦 - 晴天.lrc"), "[00:01.00]测试歌词");
  assert.equal(await scanLibrary(f.store, [f.root]), 1);
  assert.equal(await scanLibrary(f.store, [f.root]), 0);
  const songs = (await f.call("/songs?q=qt")).data;
  assert.equal(songs.length, 1);
  assert.equal(songs[0].needs_video, 1);
  assert.match(songs[0].lyrics, /测试歌词/);
  await f.call("/queue", { songId: songs[0].id }, "POST");
  await f.call("/queue", { songId: songs[0].id, name: "另一人" }, "POST");
  const state = (await f.call("/state")).data;
  assert.equal(state.pending.length, 1);
  assert.equal(state.queue.length, 0);
  assert.equal((await f.call("/songs?q=%25")).data.length, 0);
});
test("one active TV, ended event is idempotent, original-only cannot toggle", async (t) => {
  const f = await fixture(t);
  f.seed("a", "测试");
  await f.call("/queue", { songId: "a" }, "POST");
  const entry = (await f.call("/state")).data.queue[0];
  assert.equal(
    (await f.call("/player/heartbeat", { id: "tv1" }, "POST")).status,
    200,
  );
  assert.equal(
    (await f.call("/player/heartbeat", { id: "tv2" }, "POST")).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        "/player/ended",
        { playerId: "tv2", entryId: entry.id },
        "POST",
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.call("/control", { action: "vocal", entryId: entry.id }, "POST"))
      .status,
    409,
  );
  await f.call("/player/ended", { playerId: "tv1", entryId: entry.id }, "POST");
  await f.call("/player/ended", { playerId: "tv1", entryId: entry.id }, "POST");
  assert.equal((await f.call("/state")).data.queue.length, 0);
});
test("provider secrets stay server-side and validation rejects malformed modes", async (t) => {
  const f = await fixture(t),
    admin = "test-password-12345";
  assert.equal(
    (
      await f.call(
        "/admin/ai",
        {
          enabled: true,
          endpoint: "http://separator:8000",
          model: "htdemucs",
          apiKey: "secret",
        },
        "POST",
        admin,
      )
    ).status,
    200,
  );
  const data = (await f.call("/admin/ai", undefined, "GET", admin)).data;
  assert.equal(data.hasKey, true);
  assert.equal(data.apiKey, undefined);
  await f.call(
    "/admin/ai",
    {
      enabled: true,
      endpoint: "http://separator:8000",
      model: "htdemucs",
      apiKey: "",
    },
    "POST",
    admin,
  );
  assert.equal(f.store.get("ai").apiKey, "secret");
  f.seed("a", "测试");
  assert.equal(
    (
      await f.call(
        "/admin/songs/a",
        { title: "测试", artist: "我", mode: "channels", backing: 0, vocal: 0 },
        "PATCH",
        admin,
      )
    ).status,
    400,
  );
});
test("media Range streaming, room credential persists across restart", async (t) => {
  const f = await fixture(t);
  const id = "a".repeat(24);
  f.seed(id, "测试");
  await rm(path.join(resourceRoot(f.root), id + "-vocal.mp4"));
  await mkdir(path.join(f.dir, "data", "cache"), { recursive: true });
  await writeFile(
    path.join(f.dir, "data", "cache", id + "-vocal.mp4"),
    "0123456789",
  );
  const response = await fetch(
    `${f.base}/api/media/${id}/backing?token=${f.store.get("roomToken")}`,
    { headers: { Range: "bytes=2-5" } },
  );
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "2345");
  assert.equal((await fetch(`${f.base}/api/media/${id}/vocal`)).status, 401);
});
test("URL allowlist and filesystem containment", () => {
  assert.equal(
    canonicalVideo("https://youtu.be/abcdefghijk?x=1"),
    "https://www.youtube.com/watch?v=abcdefghijk",
  );
  assert.equal(
    canonicalVideo("https://www.bilibili.com/video/BV123abc/"),
    "https://www.bilibili.com/video/BV123abc",
  );
  for (const url of [
    "http://youtube.com/watch?v=abcdefghijk",
    "https://youtube.com.evil.test/watch?v=abcdefghijk",
    "file:///etc/passwd",
    "https://127.0.0.1/a",
    "https://user:pass@youtube.com/watch?v=abcdefghijk",
    "https://youtube.com:443/watch?v=oops",
  ])
    assert.throws(() => canonicalVideo(url));
  assert.equal(
    inside(path.resolve("/media"), path.resolve("/media2/a")),
    false,
  );
  assert.throws(() =>
    providerConfig({
      enabled: true,
      endpoint: "https://example.com",
      model: "",
    }),
  );
});

test("admin landing and HTTPS proxy login, QR and events", async (t) => {
  // Node fetch rewrites Host; use HTTP directly to simulate a proxy preserving it.
  const fetch = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        url,
        {
          method: options.method || "GET",
          headers: options.headers,
          signal: options.signal,
        },
        (res) =>
          resolve(
            new Response(Readable.toWeb(res), {
              status: res.statusCode,
              headers: res.headers,
            }),
          ),
      );
      req.on("error", reject);
      req.end(options.body);
    });
  const f = await fixture(t);
  const origin = "https://ktv.example.test:666";
  const headers = {
    Host: "ktv.example.test:666",
    Origin: origin,
    Authorization: "Bearer test-password-12345",
    "Content-Type": "application/json",
  };
  const landing = await fetch(f.base + "/", { redirect: "manual" });
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get("location"), "/admin");
  assert.equal(
    (
      await fetch(f.base + "/api/login", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    200,
  );
  const join = await fetch(
    f.base + "/api/join?origin=" + encodeURIComponent(origin),
    { headers },
  );
  assert.equal(
    (await join.json()).url,
    origin + "/control#" + f.store.get("roomToken"),
  );
  assert.equal(
    (
      await fetch(f.base + "/api/login", {
        method: "POST",
        headers: {
          ...headers,
          Origin: "https://evil.test",
          "X-Forwarded-Host": "evil.test",
          "X-Forwarded-Proto": "https",
        },
        body: "{}",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(f.base + "/api/login", {
        method: "POST",
        headers: {
          ...headers,
          Origin: "https://other.test",
          Authorization: "Bearer wrong-password",
        },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(f.base + "/api/reactions", {
        method: "POST",
        headers: {
          Origin: "https://other.test",
          "Content-Type": "application/json",
        },
        body: '{"emoji":"👏"}',
      })
    ).status,
    401,
  );
  const rejected = await fetch(
    f.base + "/api/join?origin=" + encodeURIComponent("https://evil.test"),
    { headers },
  );
  assert.equal(
    (await rejected.json()).url.startsWith("https://evil.test"),
    false,
  );
  f.store.set("publicUrl", origin + "/");
  assert.equal(
    (
      await fetch(f.base + "/api/login", {
        method: "POST",
        headers: { ...headers, Host: "nas.internal:3210" },
        body: "{}",
      })
    ).status,
    200,
  );
  const configured = await fetch(f.base + "/api/join", {
    headers: { ...headers, Host: "nas.internal:3210" },
  });
  assert.equal(
    (await configured.json()).url,
    origin + "/control#" + f.store.get("roomToken"),
  );
  const controller = new AbortController();
  const events = await fetch(f.base + "/api/events", {
    headers,
    signal: controller.signal,
  });
  assert.equal(events.headers.get("x-accel-buffering"), "no");
  const reader = events.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: state/);
  await reader.cancel();
  controller.abort();
});

test("random original opening stays outside queue and yields to requested songs", async (t) => {
  const f = await fixture(t);
  f.seed("one", "第一首");
  f.seed("two", "第二首");
  f.seed("backing", "纯伴奏");
  f.store.db
    .prepare("UPDATE songs SET mode='instrumental' WHERE id='backing'")
    .run();
  await f.call("/player/heartbeat", { id: "tv" }, "POST");
  let state = (await f.call("/state")).data;
  assert.equal(state.queue.length, 0);
  assert.ok(state.ambient);
  assert.notEqual(state.ambient.mode, "instrumental");
  const first = state.ambient;
  await f.call("/player/ended", { entryId: first.id, playerId: "tv" }, "POST");
  state = (await f.call("/state")).data;
  assert.notEqual(state.ambient.song_id, first.song_id);
  await f.call("/queue", { songId: "one" }, "POST");
  state = (await f.call("/state")).data;
  assert.equal(state.ambient, null);
  assert.equal(state.queue[0].song_id, "one");
  assert.equal(state.playback.vocal, false);
  await f.call("/player/ended", { entryId: first.id, playerId: "tv" }, "POST");
  assert.equal((await f.call("/state")).data.queue.length, 1);
});

test("organizer saves reviewed names and tags; filtering and rescans preserve manual labels", async (t) => {
  const f = await fixture(t);
  f.seed("tagged", "旧歌名");
  await writeFile(path.join(f.root, "tagged.mp4"), "source");
  const admin = "test-password-12345";
  let result = await f.call(
    "/admin/organize",
    {
      songs: [
        {
          id: "tagged",
          expectedRevision: 0,
          title: "新歌名",
          artist: "新歌手",
          tags: ["女声", "港台", "无效标签"],
        },
      ],
      prepare: false,
    },
    "POST",
    admin,
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.results[0].ok, true);
  const song = f.store.db
    .prepare("SELECT * FROM songs WHERE id=?")
    .get("tagged");
  assert.deepEqual(JSON.parse(song.tags), ["女声", "港台"]);
  assert.equal(song.title, "新歌名");
  assert.equal(
    (await f.call("/songs?tag=" + encodeURIComponent("女声"))).data.length,
    1,
  );
  assert.equal(
    (await f.call("/songs?tag=" + encodeURIComponent("男声"))).data.length,
    0,
  );
  const preview = (await f.call("/admin/organize", undefined, "GET", admin))
    .data;
  assert.deepEqual(preview[0].tags, ["女声", "港台"]);
  assert.equal(
    (
      await f.call(
        "/admin/organize",
        {
          songs: [
            {
              id: "tagged",
              expectedRevision: song.metadataRevision,
              title: "",
              artist: "x",
            },
          ],
        },
        "POST",
        admin,
      )
    ).data.results[0].ok,
    false,
  );
});

test("scoped integration review API cannot access admin and resolves only pending metadata", async (t) => {
  const f = await fixture(t);
  const id = f.addJob("import", {
    file: "ignored",
    metadata: { title: "待确认", artist: "未知歌手", tags: [] },
  });
  f.store.db.prepare("UPDATE jobs SET status='review' WHERE id=?").run(id);
  const admin = "test-password-12345";
  const key = (await f.call("/admin/integration", undefined, "GET", admin)).data
    .token;
  assert.equal((await f.call("/admin", undefined, "GET", key)).status, 401);
  assert.equal(
    (await f.call("/integrations/reviews", undefined, "GET", key)).data.length,
    1,
  );
  assert.equal(
    (
      await f.call(
        "/integrations/reviews/" + id,
        { artist: "歌手", title: "歌名", tags: ["男声"] },
        "POST",
        key,
      )
    ).status,
    200,
  );
  const job = f.store.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  assert.equal(job.status, "queued");
  assert.equal(JSON.parse(job.payload).approved, true);
  assert.equal(
    (
      await f.call(
        "/integrations/reviews/" + id,
        { artist: "歌手", title: "歌名" },
        "POST",
        key,
      )
    ).status,
    409,
  );
});
