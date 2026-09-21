import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { run, prepareSong } from "../server/media.js";
import { probe } from "../server/media-utils.js";
import { openStore } from "../server/db.js";
import { importMedia } from "../server/library.js";
import { upgradeSplitVideo, hdUpgradeSource } from "../server/split-video.js";
import { withSongWrite } from "../server/song-writes.js";
import { biliLoginApi, biliLoginStatus } from "../server/bili-login.js";
import { bilibiliProvider } from "../server/providers/bilibili.js";
import {
  downloadBiliTracks,
  requireDownloadHeight,
} from "../server/bili-download.js";
process.env.FFMPEG = ffmpeg;
process.env.FFPROBE = ffprobe.path;
const images = {
  img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
  sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
};
const json = (body, headers) => new Response(JSON.stringify(body), { headers });

test("Bili signed download rejects expired saved credentials and selects 4K beyond browser AVC", async () => {
  let loggedIn = false;
  const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname.endsWith("/view"))
      return json({
        code: 0,
        data: { cid: 123, bvid: "BVfixture", duration: 20 },
      });
    if (url.pathname.endsWith("/nav"))
      return json({
        code: loggedIn ? 0 : -101,
        data: { isLogin: loggedIn, wbi_img: images },
      });
    assert.equal(url.pathname, "/x/player/wbi/playurl");
    assert.match(url.searchParams.get("w_rid"), /^[a-f0-9]{32}$/);
    assert.ok(Number(url.searchParams.get("wts")) > 0);
    assert.equal(options.headers.Cookie, "SESSDATA=isolated-fixture");
    return json({
      code: 0,
      data: {
        timelength: 20000,
        dash: {
          video: [
            { height: 480, codecs: "avc1", baseUrl: "low" },
            { height: 1080, codecs: "avc1", baseUrl: "hd" },
            { height: 2160, codecs: "avc1", frameRate: "30", baseUrl: "uhd30" },
            {
              height: 2160,
              codecs: "hev1",
              frameRate: "60000/1001",
              baseUrl: "uhd",
            },
          ],
          audio: [{ codecs: "mp4a", baseUrl: "audio" }],
        },
      },
    });
  };
  await assert.rejects(
    bilibiliProvider.preview(
      "https://www.bilibili.com/video/BVfixture",
      "SESSDATA=isolated-fixture",
      fetcher,
      "highest",
      true,
    ),
    /凭证已过期/,
  );
  assert.equal(calls.length, 2);
  loggedIn = true;
  const selected = await bilibiliProvider.preview(
    "https://www.bilibili.com/video/BVfixture",
    "SESSDATA=isolated-fixture",
    fetcher,
    "highest",
    true,
  );
  assert.equal(selected.video, "uhd");
  assert.equal(selected.previewHeight, 2160);
  assert.ok(selected.previewFps > 59.9);
  requireDownloadHeight(480, "highest");
  assert.throws(() => requireDownloadHeight(1080, "highest", 2160), /未达到/);
  requireDownloadHeight(720, "1080");
  requireDownloadHeight(460, "480");
  assert.throws(() => requireDownloadHeight(0, "highest"), /未达到/);
  requireDownloadHeight(480, "480");
});

test("real DASH files retain 4K with independent audio through download cache and song preparation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktv-bili-hd-"));
  const store = openStore(path.join(root, "db"));
  t.after(async () => {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  });
  const video = path.join(root, "4k.mp4"),
    audio = path.join(root, "source.m4a");
  await run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=s=3840x2160:r=60:d=4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    video,
  ]);
  await run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    "-c:a",
    "aac",
    audio,
  ]);
  const resolve = async () => ({
    previewHeight: 2160,
    duration: 1000,
    video: "video",
    audio: "audio",
  });
  let transfers = 0;
  const transfer = async (kind, out) => {
    transfers++;
    await copyFile(kind === "video" ? video : audio, out);
  };
  const downloads = path.join(root, "downloads");
  const args = [
    "https://www.bilibili.com/video/BVfixture",
    downloads,
    "SESSDATA=secret-fixture",
    "highest",
    2160,
    { resolve, transfer },
  ];
  const [one, two] = await Promise.all([
    downloadBiliTracks(...args),
    downloadBiliTracks(...args),
  ]);
  assert.equal(one.file, two.file);
  assert.equal(transfers, 2);
  assert.equal((await probe(one.videoFile)).height, 2160);
  assert.equal((await probe(one.file)).hasVideo, false);
  assert.ok(
    (await probe(one.videoFile)).duration - (await probe(one.file)).duration >
      2,
  );
  assert.equal((await probe(one.videoFile)).audio.length, 0);
  assert.ok(!one.file.includes("secret-fixture"));
  const media = path.join(root, "media");
  await mkdir(media);
  const id = await importMedia(store, one.file, downloads, media, {
    title: "隔离测试",
    artist: "测试歌手",
  });
  const song = store.db.prepare("SELECT * FROM songs WHERE id=?").get(id);
  const retained = path.join(path.dirname(song.path), "来源画面.mp4");
  await copyFile(one.videoFile, retained);
  store.set("split-video:" + id, retained);
  const prepared = await prepareSong(
    store,
    id,
    [media],
    path.join(root, "cache"),
  );
  const folder = store.get("package:" + id);
  assert.equal(prepared.needs_video, 0);
  assert.equal((await probe(path.join(folder, "画面.mp4"))).height, 2160);
  assert.equal((await probe(path.join(folder, "画面.mp4"))).videoFps, 60);
  assert.equal((await probe(path.join(folder, "原唱.m4a"))).hasVideo, false);
  const audioBefore = await readFile(path.join(folder, "原唱.m4a"));
  // Simulate a previously prepared 720p picture for the same exact audio.
  await run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=s=1280x720:r=2:d=1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    path.join(folder, "画面.mp4"),
  ]);
  await withSongWrite(store, id, () =>
    upgradeSplitVideo(
      store,
      store.db.prepare("SELECT * FROM songs WHERE id=?").get(id),
      one.videoFile,
      "https://www.bilibili.com/video/BVfixture",
      path.join(root, "cache"),
    ),
  );
  const upgraded = store.get("package:" + id);
  assert.notEqual(upgraded, folder);
  assert.equal((await probe(path.join(upgraded, "画面.mp4"))).height, 2160);
  assert.deepEqual(
    await readFile(path.join(upgraded, "原唱.m4a")),
    audioBefore,
  );
  assert.equal((await probe(path.join(folder, "画面.mp4"))).height, 720);
  // A advertised-HD stream containing only audio must never publish a download cache.
  await assert.rejects(
    downloadBiliTracks(
      ...args.slice(0, 1),
      path.join(root, "bad"),
      ...args.slice(2, 5),
      { resolve, transfer: async (kind, out) => copyFile(audio, out) },
    ),
    /未达到/,
  );
});

test("HD upgrade preserves the recorded clip and declines an unrelated later MV", () => {
  let replacement;
  const store = { get: () => replacement };
  const song = {
    id: "song",
    evidence: JSON.stringify([
      {
        kind: "user-selection",
        url: "https://www.bilibili.com/video/BVfixture",
        clip: { start: 0, end: 290.28157 },
      },
    ]),
  };
  assert.deepEqual(hdUpgradeSource(store, song), {
    url: "https://www.bilibili.com/video/BVfixture",
    clip: { start: 0, end: 290.28157 },
  });
  replacement = { url: "https://www.bilibili.com/video/BVother" };
  assert.equal(hdUpgradeSource(store, song), null);
});

test("QR login accepts current official account domain and stores credentials only after phone confirmation", async (t) => {
  const values = new Map([
    [
      "favorites",
      {
        favoriteId: "123",
        enabled: true,
        cookie: "old-expired",
        credentials: { sessdata: "old" },
      },
    ],
  ]);
  const store = {
    get: (k, d) => values.get(k) ?? d,
    set: (k, v) => values.set(k, v),
  };
  let code = 86101;
  const fetcher = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/generate"))
      return json({
        code: 0,
        data: {
          url: "https://account.bilibili.com/h5/account-h5/auth/scan-web?fixture=1",
          qrcode_key: "test-qr",
        },
      });
    if (url.pathname.endsWith("/poll"))
      return json(
        { code: 0, data: { code, refresh_token: "qr-refresh-fixture" } },
        {
          "Set-Cookie": [
            "SESSDATA=new-fixture; Path=/; Secure",
            "bili_jct=csrf-fixture; Path=/",
            "DedeUserID=123; Path=/",
          ],
        },
      );
    if (url.pathname.endsWith("getbuvid"))
      return json({ code: 0, data: { buvid: "device-fixture" } });
    return json({
      code: 0,
      data: { isLogin: true, uname: "测试账号", vipStatus: 1 },
    });
  };
  // Response's Set-Cookie representation needs distinct header lines.
  const transport = async (input, opts) => {
    const response = await fetcher(input, opts);
    if (new URL(input).pathname.endsWith("/poll"))
      response.headers.getSetCookie = () => [
        "SESSDATA=new-fixture; Path=/; Secure",
        "bili_jct=csrf-fixture; Path=/",
        "DedeUserID=123; Path=/",
      ];
    return response;
  };
  const app = express();
  app.use(express.json());
  biliLoginApi({
    app,
    store,
    fetcher: transport,
    admin: (req, res, next) =>
      req.headers.authorization === "Bearer test"
        ? next()
        : res.status(401).end(),
  });
  app.use((error, req, res, next) =>
    res.status(400).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const request = async (url, body) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/bilibili` + url,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body || {}),
      },
    );
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${server.address().port}/api/admin/bilibili/qr`,
        { method: "POST" },
      )
    ).status,
    401,
  );
  const qr = await (await request("/qr")).json();
  assert.match(qr.image, /^data:image\/png;base64,/);
  assert.equal(qr.qrcode_key, undefined);
  const pending = await (await request("/qr/" + qr.id)).json();
  assert.equal(pending.status, "pending");
  assert.equal(store.get("favorites").cookie, "old-expired");
  const fresh = await (await request("/qr")).json();
  code = 0;
  const success = await (await request("/qr/" + fresh.id)).json();
  assert.equal(success.status, "success");
  assert.equal(success.cookie, undefined);
  const saved = store.get("favorites");
  assert.match(saved.cookie, /SESSDATA=new-fixture/);
  assert.equal(saved.credentials.sessdata, "new-fixture");
  assert.equal(saved.credentials.ac_time_value, "qr-refresh-fixture");
  assert.equal(success.credentials, undefined);
  // 扫码只写这一条共享记录，收藏夹设置保持原样，在线找歌读到同一份 Cookie。
  assert.equal(store.get("bili-online"), undefined);
  assert.equal(store.get("favorites").favoriteId, "123");
  assert.equal(store.get("favorites").enabled, true);
  assert.match(success.message, /在线找歌和收藏夹同步共用/);
  // 手动填写凭证也写同一条记录，并保留收藏夹设置。
  const manual = await (
    await request("/credentials", {
      sessdata: "manual-sess",
      bili_jct: "manual-csrf",
      dedeuserid: "456",
    })
  ).json();
  assert.equal(manual.ok, true);
  assert.match(store.get("favorites").cookie, /SESSDATA=manual-sess/);
  assert.equal(store.get("favorites").favoriteId, "123");
  assert.equal(store.get("favorites").enabled, true);
  assert.equal(store.get("favorites").credentials.buvid3, "device-fixture");
  assert.equal(
    (await (await request("/credentials", { clearCookie: true })).json()).ok,
    true,
  );
  assert.equal(store.get("favorites").cookie, "");
  assert.equal(store.get("favorites").credentials.sessdata, "");
  assert.equal(store.get("favorites").favoriteId, "123");
  assert.deepEqual(
    await biliLoginStatus("expired", async () => json({ code: -101 })),
    { loggedIn: false },
  );
});

test("old MV accepts freshly available 480p despite stale preview and rejects a substituted lower stream", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktv-old-mv-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = path.join(root, "old.mp4"),
    audio = path.join(root, "old.m4a");
  await run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=s=640x480:r=2:d=1",
    "-c:v",
    "libx264",
    video,
  ]);
  await run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    "-c:a",
    "aac",
    audio,
  ]);
  const transfer = (kind, out) =>
    copyFile(kind === "video" ? video : audio, out);
  const resolve = async () => ({
    previewHeight: 480,
    previewFps: 2,
    video: "video",
    audio: "audio",
  });
  for (const quality of ["highest", "1080", "480"]) {
    const result = await downloadBiliTracks(
      "https://www.bilibili.com/video/BVold",
      path.join(root, quality),
      "",
      quality,
      1080,
      { resolve, transfer },
    );
    assert.equal(result.height, 480);
  }
  await assert.rejects(
    downloadBiliTracks(
      "https://www.bilibili.com/video/BVold",
      path.join(root, "bad"),
      "",
      "highest",
      0,
      {
        resolve: async () => ({ ...(await resolve()), previewHeight: 1080 }),
        transfer,
      },
    ),
    /未达到所选视频流/,
  );
});

test("signed highest download can select an anonymous old 480p MV", async () => {
  const fetcher = async (input) => {
    const pathname = new URL(input).pathname;
    if (pathname.endsWith("/view"))
      return json({ code: 0, data: { cid: 123, bvid: "BVold" } });
    if (pathname.endsWith("/nav"))
      return json({ code: -101, data: { isLogin: false, wbi_img: images } });
    return json({
      code: 0,
      data: {
        dash: {
          video: [{ height: 480, codecs: "avc1", baseUrl: "video" }],
          audio: [{ codecs: "mp4a", baseUrl: "audio" }],
        },
      },
    });
  };
  const selected = await bilibiliProvider.preview(
    "https://www.bilibili.com/video/BVold",
    "",
    fetcher,
    "highest",
    true,
  );
  assert.equal(selected.previewHeight, 480);
  assert.equal(selected.qualities[0].label, "最高可用画质");
});
