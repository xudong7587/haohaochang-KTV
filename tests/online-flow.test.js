import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import {
  startDiscovery,
  broadcastAddresses,
  privateIPv4,
} from "../server/discovery.js";
import { searchSongs, rankVideos } from "../server/online-search.js";
import { biliStreamUrl, previewSessions } from "../server/online-preview.js";
import { clipOnPc, clipRange } from "../server/clipping.js";
import { run } from "../server/process.js";
import { probe } from "../server/media-utils.js";
import { openStore } from "../server/db.js";
import { createApp } from "../server/app.js";
process.env.FFMPEG = ffmpeg;
process.env.FFPROBE = ffprobe.path;

test("low-resolution preview accepts a separate HD download choice and preserves clip identity", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-preview-quality-"));
  const service = createApp({
    dataDir: path.join(dir, "db"),
    roots: [path.join(dir, "media")],
    adminToken: "preview-test-password",
    worker: false,
    discovery: false,
  });
  service.store.set("ai", { enabled: true });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const localFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.bilibili.com");
    return new Response(
      JSON.stringify(
        url.pathname.endsWith("/view")
          ? {
              code: 0,
              data: { cid: 123, bvid: "BV1BZbSzZEGT", duration: 120 },
            }
          : {
              code: 0,
              data: {
                timelength: 120000,
                dash: {
                  video: [360, 1080, 2160].map((height) => ({
                    height,
                    codecs: height === 2160 ? "hev1" : "avc1",
                    bandwidth: height * 1000,
                    baseUrl: `https://fixture.bilivideo.com/${height}`,
                  })),
                  audio: [
                    {
                      codecs: "mp4a",
                      baseUrl: "https://fixture.bilivideo.com/audio",
                    },
                  ],
                },
              },
            },
      ),
    );
  });
  const post = async (endpoint, body) =>
    localFetch(`http://127.0.0.1:${server.address().port}/api/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + service.store.get("roomToken"),
      },
      body: JSON.stringify(body),
    });
  const url = "https://www.bilibili.com/video/BV1BZbSzZEGT";
  const preview = await (
    await post("online/preview", { url, quality: "2160" })
  ).json();
  assert.equal(preview.previewHeight, 360);
  assert.equal(preview.downloadHeight, 2160);
  const response = await post("online", {
    url,
    title: "测试歌",
    artist: "测试歌手",
    onlineSelection: true,
    previewId: preview.id,
    quality: "1080",
    clip: { start: 12, end: 32 },
  });
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const payload = JSON.parse(
    service.store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(id)
      .payload,
  );
  assert.equal(payload.quality, "1080");
  assert.equal(payload.expectedHeight, 1080);
  assert.deepEqual(payload.clip, { start: 12, end: 32 });
  assert.equal(
    (
      await post("online", {
        url: "https://www.bilibili.com/video/BV1gF4m1K7Aa",
        title: "另一首",
        artist: "歌手",
        onlineSelection: true,
        previewId: preview.id,
        quality: "highest",
      })
    ).status,
    400,
  );
});

test("LAN discovery pairs only fresh private sender replies and never broadcasts credentials", async () => {
  const values = new Map(),
    outgoing = [],
    calls = [];
  let wakes = 0;
  class Socket extends EventEmitter {
    bind(_port, _host, cb) {
      queueMicrotask(cb);
    }
    unref() {}
    setBroadcast() {}
    close() {}
    send(body, _port, target, cb) {
      outgoing.push({ body: JSON.parse(body), target });
      cb();
    }
  }
  const socket = new Socket();
  const discovery = startDiscovery(
    {
      enabled: true,
      store: {
        get: (k, d) => values.get(k) ?? d,
        set: (k, v) => values.set(k, v),
        db: { prepare: () => ({ run: () => wakes++ }) },
      },
      work: () => {},
      emit: () => {},
    },
    {
      createSocket: () => socket,
      fetcher: async (url, opts) => {
        calls.push({ url, ...opts });
        return {
          ok: true,
          json: async () => ({
            id: "worker-12345678",
            key: "private-test-key-at-least-16",
          }),
        };
      },
    },
  );
  try {
    await new Promise((r) => setImmediate(r));
    assert.ok(outgoing.length);
    assert.deepEqual(Object.keys(outgoing[0].body).sort(), [
      "nonce",
      "protocol",
    ]);
    const reply = {
      protocol: "haohaochang-lan-v1",
      nonce: outgoing[0].body.nonce,
      id: "worker-12345678",
      port: 8000,
      challenge: "challenge-123456789",
      name: "test PC",
      securePairing: 2,
    };
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ ...reply, nonce: "stale" })),
      { address: "192.168.5.20" },
    );
    socket.emit("message", Buffer.from(JSON.stringify(reply)), {
      address: "8.8.8.8",
    });
    socket.emit("message", Buffer.from(JSON.stringify(reply)), {
      address: "127.0.0.1",
    });
    assert.equal(calls.length, 0);
    socket.emit("message", Buffer.from(JSON.stringify(reply)), {
      address: "192.168.5.20",
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls[0].url, "http://192.168.5.20:8000/lan/pair");
    assert.equal(values.get("ai").pcEndpoint, "http://192.168.5.20:8000");
    assert.equal(values.get("ai").enabled, true);
    assert.equal(wakes, 1);
    assert.ok(!JSON.stringify(discovery.info()).includes("private-test-key"));
    values.set("ai", { ...values.get("ai"), autoDiscover: false });
    socket.emit("message", Buffer.from(JSON.stringify(reply)), {
      address: "192.168.5.20",
    });
    assert.equal(calls.length, 1);
  } finally {
    discovery.stop();
  }
  assert.equal(privateIPv4("192.168.1.999"), false);
  assert.deepEqual(
    broadcastAddresses({
      eth: [
        {
          family: "IPv4",
          internal: false,
          address: "192.168.5.2",
          netmask: "255.255.255.0",
        },
      ],
    }),
    ["255.255.255.255", "192.168.5.255"],
  );
});

test("song duration ranking uses recording duration and preserves relevance on ambiguous lyrics", async () => {
  const rows = [
    { url: "long", duration: 500 },
    { url: "short", duration: 180 },
    { url: "match", duration: 241 },
    { url: "unknown", duration: null },
  ];
  let query;
  const search = async (q) => {
    query = q;
    return rows;
  };
  let r = await searchSongs("歌名", "歌手", "", 1, {
    search,
    lyrics: async () => ({ recording: { duration: 240 }, source: "test" }),
  });
  assert.equal(query, "歌名 歌手");
  assert.equal(r.results[0].url, "match");
  assert.equal(r.duration, 240);
  r = await searchSongs("歌名", "歌手", "", 1, {
    search,
    lyrics: async () => {
      throw new Error("ambiguous");
    },
  });
  assert.deepEqual(
    r.results.map((r) => r.url),
    rows.map((r) => r.url),
  );
  assert.equal(r.duration, null);
  assert.ok(rankVideos(rows, null).every((r) => r.durationDifference === null));
});

test("preview sessions expose opaque local streams and restrict remote stream destinations", async () => {
  const sessions = previewSessions({
    resolve: async () => ({
      duration: 100,
      video: {
        url: "https://test.bilivideo.com/video",
        headers: { Cookie: "private" },
      },
    }),
  });
  const value = await sessions.create(
    "https://www.bilibili.com/video/BV123",
    "",
    "",
  );
  assert.ok(value.video.startsWith("/api/online/preview/"));
  assert.ok(!JSON.stringify(value).includes("private"));
  assert.ok(!JSON.stringify(value).includes("bilivideo"));
  assert.throws(() => sessions.lookup("missing"), /过期/);
  for (const url of [
    "http://test.bilivideo.com/a",
    "https://bilivideo.com.attacker.test/a",
    "https://127.0.0.1/a",
    "https://user:pass@test.bilivideo.com/a",
  ])
    assert.throws(() => biliStreamUrl(url));
  assert.equal(
    biliStreamUrl("https://test.bilivideo.com/a"),
    "https://test.bilivideo.com/a",
  );
  assert.deepEqual(clipRange({ start: 12, end: null }, 100), {
    start: 12,
    end: 100,
  });
  for (const range of [
    { start: -1, end: 5 },
    { start: 5, end: 4 },
    { start: 0, end: 101 },
    { start: NaN, end: 10 },
  ])
    assert.throws(() => clipRange(range, 100));
});

test("PC clip transport validates real A/V duration, persists checkpoints and reuses completed output", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-clip-")),
    store = openStore(path.join(dir, "db"));
  const input = path.join(dir, "input.mp4"),
    output = path.join(dir, "output.mp4");
  await run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=24:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    input,
  ]);
  await run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-ss",
    "1.25",
    "-i",
    input,
    "-t",
    "1.5",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    output,
  ]);
  const app = express();
  app.use(express.raw({ type: () => true, limit: "5mb" }));
  let submits = 0;
  app.get("/health", (_q, r) =>
    r.json({ protocol: "ktv-separation-v1", capabilities: ["video-clip-v1"] }),
  );
  app.post("/clip", (q, r) => {
    submits++;
    assert.match(q.body.toString(), /name="start"\r\n\r\n1.25/);
    assert.match(q.body.toString(), /name="end"\r\n\r\n2.75/);
    r.json({ id: "clip-test", status: "done", video_url: "/artifact" });
  });
  app.get("/artifact", (_q, r) => r.sendFile(output));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  store.set("ai", {
    enabled: true,
    pcEndpoint: `http://127.0.0.1:${server.address().port}`,
  });
  const payload = {
      title: "Test",
      artist: "Test",
      clip: { start: 1.25, end: 2.75 },
    },
    job = { id: "job-test" };
  const file = await clipOnPc(store, job, payload, input, dir);
  assert.ok(Math.abs((await probe(file)).duration - 1.5) < 0.15);
  assert.equal(await clipOnPc(store, job, payload, input, dir), file);
  assert.equal(submits, 1);
  store.set("ai", {});
  const local = await clipOnPc(store, { id: "offline" }, payload, input, dir);
  assert.ok(Math.abs((await probe(local)).duration - 1.5) < 0.15);
  assert.equal((await probe(local)).audio.length, 1);
});

test("online selection records identity and queues without requiring PC or writing library fixtures", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ktv-online-api-"));
  const service = createApp({
    dataDir: path.join(dir, "db"),
    roots: [path.join(dir, "media")],
    adminToken: "test-only-password",
    worker: false,
    discovery: false,
  });
  const { store } = service;
  store.set("onlineEnabled", true);
  store.set("ai", { enabled: true, autoDiscover: true });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const submit = async (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/online`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + store.get("roomToken"),
      },
      body: JSON.stringify({
        url: "https://www.bilibili.com/video/BV1BZbSzZEGT",
        title: "晴天",
        artist: "周杰伦",
        onlineSelection: true,
        enqueue: true,
        ...body,
      }),
    });
  const r = await submit({}),
    { id } = await r.json();
  assert.equal(r.status, 200);
  const p = JSON.parse(
    store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(id).payload,
  );
  assert.equal(p.artist, "周杰伦");
  assert.equal(p.enqueue, false);
  assert.equal(p.onlineSelection, true);
  assert.equal(
    store.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,
    "queued",
  );
  assert.equal((await (await submit({})).json()).id, id);

  assert.equal((await submit({ artist: "" })).status, 400);
  assert.equal(
    (await submit({ clip: { start: 1, end: 2 }, previewId: "fake" })).status,
    410,
  );
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM songs").get().n, 0);
});
