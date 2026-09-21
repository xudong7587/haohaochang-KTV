import { favoriteBundles } from "../server/favorite-bundles.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { openStore } from "../server/db.js";
import { favoriteParts, favoriteNfo } from "../server/favorites.js";
import { favorite_sync } from "../server/job-handlers/favorite-sync.js";
import { favorite_download } from "../server/job-handlers/favorite-download.js";
import {
  stageLocalFile,
  intakeKey,
  nfoIdentity,
} from "../server/local-intake.js";
import { run } from "../server/process.js";
import { probe } from "../server/media-utils.js";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
const bvid = "BV1234567890";
const response = (data) => Response.json({ code: 0, data });
const pages = [
  { page: 1, cid: 101, part: "第一首" },
  { page: 2, cid: 102, part: "第二首" },
  { page: 3, cid: 103, part: "第三首" },
];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ktv-favorites-parts-"));
  const store = openStore(path.join(root, "data"));
  const downloads = path.join(root, "downloads");
  await mkdir(downloads);
  t.after(async () => {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  });
  const jobs = [];
  return {
    store,
    db: store.db,
    get: store.get,
    set: store.set,
    dir: path.join(root, "data"),
    downloads,
    jobs,
    fail: (_status, message) => new Error(message),
    addJob(kind, payload) {
      const id = "test-" + jobs.length;
      store.db
        .prepare(
          "INSERT INTO jobs(id,kind,payload,status,created) VALUES(?,?,?,'queued',0)",
        )
        .run(id, kind, JSON.stringify(payload));
      jobs.push({ id, kind, payload });
      return id;
    },
  };
}
test("favorites expand all parts, deduplicate by CID, and migrate the old P1 marker", async (t) => {
  const f = await fixture(t);
  f.set("favorites", { favoriteId: "123" });
  const old = f.addJob("favorite-download", { bvid, title: "旧标题" });
  f.set("favorite-seen:123:" + bvid, old);
  let current = pages;
  f.favoriteFetch = async (url) =>
    String(url).includes("/fav/")
      ? response({ medias: [{ bvid, title: "专辑" }], has_more: false })
      : response({ title: "歌手《专辑》", pages: current });
  await favorite_sync({}, {}, f);
  assert.equal(f.jobs.length, 3);
  assert.deepEqual(
    f.jobs.slice(1).map((j) => j.payload.page),
    [2, 3],
  );
  assert.equal(
    JSON.parse(
      f.db.prepare("SELECT payload FROM jobs WHERE id=?").get(old).payload,
    ).cid,
    "101",
  );
  await favorite_sync({}, {}, f);
  assert.equal(f.jobs.length, 3);
  current = [...pages, { page: 4, cid: 104, part: "附赠曲" }];
  await favorite_sync({}, {}, f);
  assert.equal(f.jobs.length, 4);
  assert.equal(f.jobs[3].payload.cid, "104");
});
test("invalid video does not block other favorites, malformed part lists are rejected", async (t) => {
  const f = await fixture(t);
  f.set("favorites", { favoriteId: "123" });
  f.favoriteFetch = async (url) =>
    String(url).includes("/fav/")
      ? response({ medias: [{ bvid: "BVbad" }, { bvid }] })
      : String(url).includes("BVbad")
        ? Response.json({ code: -404 })
        : response({ pages });
  await assert.rejects(favorite_sync({}, {}, f), /部分视频/);
  assert.equal(f.jobs.length, 3);
  await assert.rejects(
    favoriteParts({ bvid }, {}, async () =>
      response({ pages: [pages[0], { ...pages[1], page: 1 }] }),
    ),
    /分 P 信息无效/,
  );
});
test("download resolves reordered CID, writes each NFO, and waits for the rest of the bundle without direct import", async (t) => {
  const f = await fixture(t);
  f.set("favorites", {});
  f.favoriteFetch = async () =>
    response({
      title: "歌手《专辑》",
      pages: [
        { ...pages[1], page: 1 },
        { ...pages[0], page: 2 },
      ],
    });
  f.favoriteTracks = async (url, directory, cookie, quality) => {
    assert.match(url, /\?p=1$/);
    assert.equal(quality, "highest");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "audio.m4a"),
      videoFile = path.join(directory, "video.mp4");
    await writeFile(file, "independent part recording");
    await writeFile(videoFile, "independent part picture");
    return { file, videoFile };
  };
  f.favoriteMux = async (_tracks, target) =>
    writeFile(target, "muxed part recording");
  const payload = { bvid, cid: "102", page: 2 },
    id = f.addJob("favorite-download", payload);
  await favorite_download({ id }, payload, f);
  const group = favoriteBundles(f.store)[0];
  const received = group.parts.find((p) => p.cid === "102");
  assert.match(received.file, /Season 1/);
  const xml = await readFile(received.file.replace(/\.mp4$/, ".nfo"), "utf8");
  assert.equal(nfoIdentity(xml, "unused").title, "第二首");
  assert.equal(nfoIdentity(xml, "unused").albumHint, "歌手《专辑》");
  assert.equal(group.status, "downloading");
  assert.equal(
    f.jobs.some((j) =>
      [
        "import",
        "local-intake",
        "favorite-process",
        "favorite-analyze",
      ].includes(j.kind),
    ),
    false,
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM songs").get().n, 0);
  await assert.rejects(
    favorite_download({ id }, { bvid, cid: "999" }, f),
    /原分 P 已移除/,
  );
  assert.match(
    favoriteNfo({ ...payload, title: "A & B <C>", collectionTitle: "D" }),
    /A &amp; B &lt;C&gt;/,
  );
});

test("favorite downloads mux the API picture and original track into one playable file", async (t) => {
  process.env.FFMPEG = ffmpeg;
  process.env.FFPROBE = ffprobe.path;
  const f = await fixture(t);
  f.set("favorites", { favoriteId: "123" });
  f.favoriteFetch = async () =>
    response({ title: "歌手《专辑》", pages: [pages[0]] });
  const video = path.join(f.downloads, "track-video.mp4"),
    audio = path.join(f.downloads, "track-audio.m4a");
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:d=0.6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.6",
    "-ac",
    "2",
    "-c:a",
    "aac",
    audio,
  ]);
  f.favoriteTracks = async (url, directory, cookie, quality) => {
    assert.match(url, /\?p=1$/);
    assert.equal(quality, "highest");
    assert.equal(cookie, undefined);
    await mkdir(directory, { recursive: true });
    return { file: audio, videoFile: video };
  };
  const payload = { bvid, cid: "101", page: 1 },
    id = f.addJob("favorite-download", payload);
  await favorite_download({ id }, payload, f);
  const saved = favoriteBundles(f.store)[0].parts.find(
    (p) => p.cid === "101",
  ).file;
  assert.match(saved, /Season 1/);
  const info = await probe(saved);
  assert.equal(info.hasVideo, true, "收藏夹文件保留独立画面");
  assert.equal(info.audio.length > 0, true, "收藏夹文件保留原唱音轨");
});
