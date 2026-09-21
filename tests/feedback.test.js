import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStore } from "../server/db.js";
import { createApp } from "../server/app.js";
import { createScheduler } from "../server/scheduler.js";
import { taskStatus } from "../server/task-status.js";
import { organizeBatch } from "../src/library/batch.js";
const until = async (fn) => {
  const end = Date.now() + 4000;
  while (!fn()) {
    assert.ok(Date.now() < end, "timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("online default upgrades old settings once and preserves later explicit opt-out", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-online-default-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({
      onlineEnabled: false,
      favorites: {
        cookie: "SESSDATA=test-saved-cookie",
        enabled: true,
        favoriteId: "123",
        credentials: {
          sessdata: "test-saved-cookie",
          ac_time_value: "test-token",
        },
      },
    }),
  );
  let store = openStore(dir);
  assert.equal(store.get("onlineEnabled"), true);
  assert.equal(store.get("favorites").cookie, "SESSDATA=test-saved-cookie");
  assert.equal(store.get("favorites").credentials.ac_time_value, "test-token");
  store.set("onlineEnabled", false);
  store.db.close();
  store = openStore(dir);
  assert.equal(store.get("onlineEnabled"), false);
  assert.equal(store.get("favorites").cookie, "SESSDATA=test-saved-cookie");
  store.db.close();
});

test("1.1.1 split logins merge back into one record without losing the maintained credential", async (t) => {
  const split = {
    onlineEnabled: true,
    biliLoginSplit: true,
    favorites: {
      cookie: "SESSDATA=favorite-side",
      enabled: true,
      favoriteId: "123",
      credentials: { sessdata: "favorite-side", ac_time_value: "favorite-token" },
    },
    "bili-online": {
      cookie: "SESSDATA=online-side",
      credentials: { sessdata: "online-side", ac_time_value: "" },
    },
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-login-merge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "settings.json"), JSON.stringify(split));
  let store = openStore(dir);
  // 收藏夹一侧带刷新令牌，是唯一能自动维护的凭证，合并时保留它。
  assert.equal(store.get("favorites").cookie, "SESSDATA=favorite-side");
  assert.equal(store.get("favorites").credentials.ac_time_value, "favorite-token");
  assert.equal(store.get("favorites").favoriteId, "123");
  assert.equal(store.get("bili-online"), undefined);
  store.db.close();
  store = openStore(dir);
  assert.equal(store.get("favorites").cookie, "SESSDATA=favorite-side");
  assert.equal(store.get("bili-online"), undefined);
  store.db.close();

  // 反向：1.1.1 里用新扫码登录在线一侧时，刷新令牌在在线记录上，合并保留在线那份。
  const scanned = await mkdtemp(path.join(os.tmpdir(), "ktv-login-merge-"));
  t.after(() => rm(scanned, { recursive: true, force: true }));
  await writeFile(
    path.join(scanned, "settings.json"),
    JSON.stringify({
      ...split,
      favorites: {
        cookie: "SESSDATA=favorite-side",
        enabled: true,
        favoriteId: "123",
        credentials: { sessdata: "favorite-side", ac_time_value: "" },
      },
      "bili-online": {
        cookie: "SESSDATA=online-side",
        credentials: { sessdata: "online-side", ac_time_value: "online-token" },
      },
    }),
  );
  const other = openStore(scanned);
  assert.equal(other.get("favorites").cookie, "SESSDATA=online-side");
  assert.equal(other.get("favorites").favoriteId, "123");
  assert.equal(other.get("bili-online"), undefined);
  other.db.close();
});

test("three background jobs run concurrently; online work uses reserved slot and its children retain priority", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-three-workers-"));
  const store = openStore(dir);
  let release;
  const gate = new Promise((r) => (release = r));
  const started = [];
  const scheduler = createScheduler(
    { ...store, store, emit: () => {}, enqueue: () => {} },
    {
      execute: async (job, p, context) => {
        started.push(job.kind + ":" + p.title);
        await gate;
        if (job.kind === "download")
          context.addJob("import", { title: "online-child" });
      },
    },
  );
  t.after(async () => {
    scheduler.stop();
    release();
    await until(
      () =>
        store.db
          .prepare("SELECT COUNT(*) n FROM jobs WHERE status='running'")
          .get().n === 0,
    );
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 8; i++)
    scheduler.addJob("background", { title: String(i) });
  await until(() => started.length === 3);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='running'").get()
      .n,
    3,
  );
  scheduler.addJob("download", {
    title: "online",
    url: "https://example.test/song",
  });
  await until(() => started.length === 4);
  assert.equal(started[3], "download:online");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='queued'").get()
      .n,
    5,
  );
  release();
  await until(
    () =>
      store.db
        .prepare(
          "SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')",
        )
        .get().n === 0,
  );
  const child = store.db
    .prepare("SELECT payload FROM jobs WHERE kind='import'")
    .get();
  assert.equal(JSON.parse(child.payload).priority, "online");
});

test("active tasks survive 150 newer completed records, resolve song titles and real model progress", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-task-view-"));
  const store = openStore(dir);
  t.after(async () => {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  store.db
    .prepare(
      "INSERT INTO songs(id,path,title,artist,created) VALUES(?,?,?,?,?)",
    )
    .run("s", "/isolated/song.mp4", "晴天", "周杰伦", 1);
  const add = store.db.prepare(
    "INSERT INTO jobs(id,kind,payload,status,stage,created) VALUES(?,?,?,?,?,?)",
  );
  add.run(
    "active",
    "organize",
    JSON.stringify({ id: "s" }),
    "running",
    "separating",
    1,
  );
  for (let i = 0; i < 150; i++)
    add.run("done-" + i, "scan", "{}", "done", "done", i + 2);
  for (let i = 0; i < 110; i++)
    add.run(
      "waiting-" + i,
      "import",
      JSON.stringify({ metadata: { title: "排队歌" + i, artist: "歌手" } }),
      "queued",
      "",
      i + 152,
    );
  store.set("separation:s:provider", {
    result: { status: "running", stage: "separating", model_progress: 42 },
  });
  const view = taskStatus(store);
  assert.equal(view[0].id, "active");
  assert.equal(view[0].title, "晴天");
  assert.equal(view[0].artist, "周杰伦");
  assert.equal(view[0].model_progress, 42);
  assert.equal(view.filter((j) => j.status === "queued").length, 110);
  assert.equal("payload" in view[0], false);
  store.set("separation:s:provider", {
    result: { status: "done", stage: "done" },
  });
  store.db
    .prepare("UPDATE jobs SET stage='preparing-video' WHERE id='active'")
    .run();
  assert.equal(taskStatus(store)[0].stage, "preparing-video");
  assert.equal(taskStatus(store)[0].model_progress, null);
});

test("100 local background jobs do not block online requests; online capacity is 200", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-online-capacity-"));
  await mkdir(path.join(dir, "media"));
  const service = createApp({
    dataDir: path.join(dir, "db"),
    roots: [path.join(dir, "media")],
    downloads: path.join(dir, "downloads"),
    adminToken: "feedback-test-password",
    worker: false,
    discovery: false,
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const db = service.store.db;
  const insert = db.prepare(
    "INSERT INTO jobs(id,kind,payload,status,created) VALUES(?,?,?,?,?)",
  );
  for (let i = 0; i < 100; i++)
    insert.run("background-" + i, "organize", "{}", "queued", i);
  const request = () =>
    fetch(`http://127.0.0.1:${server.address().port}/api/online`, {
      method: "POST",
      headers: {
        Authorization: "Bearer feedback-test-password",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "在线歌",
        artist: "歌手",
        url: "https://www.bilibili.com/video/BV1gF4m1K7Aa",
        client: "mobile",
      }),
    });
  let response = await request();
  assert.equal(response.status, 200);
  await response.json();
  for (let i = 0; i < 199; i++)
    insert.run(
      "online-" + i,
      "acquire",
      JSON.stringify({ title: String(i) }),
      "queued",
      i,
    );
  response = await request();
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /200/);
});

test("half-standard bulk organization submits only the provided tier", async () => {
  let submitted;
  const rows = [
    {
      id: "audio",
      tier: "audio",
      title: "半标准",
      artist: "歌手",
      metadataRevision: 3,
    },
  ];
  await organizeBatch(rows, [], async (url, body) => {
    submitted = body.items;
    return { results: body.items.map((r) => ({ ...r, status: "success" })) };
  });
  assert.deepEqual(
    submitted.map((r) => r.id),
    ["audio"],
  );
  assert.equal(submitted[0].expectedRevision, 3);
});
