import path from "node:path";
import { lstat, realpath, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inside, safeMedia } from "./media-utils.js";
import { currentSong, withSongWrite } from "./song-writes.js";
import { intakeCleanupSources } from "./local-intake.js";
import {
  deletionKey,
  finishDeletion,
  quarantineDeletion,
} from "./song-deletion.js";

export async function deletionPlan(store, id, roots, cache, legacyCache) {
  const song = currentSong(store, id);
  const targets = [];
  async function directorySignature(directory) {
    const entries = [];
    async function walk(folder) {
      for (const name of (await readdir(folder)).sort()) {
        const file = path.join(folder, name),
          info = await lstat(file);
        if (info.isSymbolicLink())
          throw new Error("歌曲目录含有链接，请先检查文件位置");
        entries.push([path.relative(directory, file), info.size, info.mtimeMs]);
        if (info.isDirectory()) await walk(file);
      }
    }
    await walk(directory);
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  }
  async function add(file, directory = false) {
    if (!file) return;
    let info;
    try {
      info = await lstat(file);
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    if (info.isSymbolicLink())
      throw new Error("删除目标包含链接，请先检查文件位置");
    const actual = await safeMedia(file, roots);
    if (directory) {
      const parent = await realpath(path.dirname(file));
      if (!["歌曲", "sources", "stems"].includes(path.basename(parent)))
        throw new Error("不能删除共享媒体目录");
      const allowed = [cache, legacyCache]
        .filter(Boolean)
        .some(
          (root) =>
            inside(path.resolve(root), actual) && actual !== path.resolve(root),
        );
      if (!allowed || !info.isDirectory())
        throw new Error("歌曲目录不在资源目录内");
    } else if (!info.isFile()) throw new Error("媒体路径不是文件");
    targets.push({
      path: actual,
      directory,
      size: info.size,
      modified: info.mtimeMs,
      ...(directory ? { contents: await directorySignature(actual) } : {}),
    });
  }
  await add(song.path);
  await add(
    store.get(
      "package-base:" + id,
      store.get("package:" + id, path.join(cache, "歌曲", id)),
    ),
    true,
  );
  for (const root of [...new Set([cache, legacyCache].filter(Boolean))]) {
    for (const kind of ["sources", "stems"])
      await add(path.join(root, kind, id), true);
    for (const kind of ["vocal", "backing"])
      await add(path.join(root, `${id}-${kind}.mp4`));
  }
  const unique = [...new Map(targets.map((t) => [t.path, t])).values()];
  const selected = unique.filter(
    (t) =>
      !unique.some(
        (other) => other !== t && other.directory && inside(other.path, t.path),
      ),
  );
  for (const other of store.db
    .prepare("SELECT id,path FROM songs WHERE id<>?")
    .all(id)) {
    if (
      selected.some(
        (t) =>
          t.path === path.resolve(other.path) ||
          (t.directory && inside(t.path, path.resolve(other.path))),
      )
    )
      throw new Error("目录内存在其他歌曲，不能整目录删除");
  }
  const token = createHash("sha256")
    .update(
      JSON.stringify([song.metadataRevision, song.resourceRevision, selected]),
    )
    .digest("hex");
  return {
    id,
    title: song.title,
    artist: song.artist,
    token,
    targets: selected,
  };
}

export function libraryDeleteApi({
  app,
  admin,
  store,
  roots,
  downloads,
  cache,
  legacyCache,
  emit,
  snapshot,
  isPlaying,
}) {
  const allowed = [...roots, downloads, cache, legacyCache].filter(Boolean);
  async function inboxPlan(body) {
    let file = body.file;
    if (body.reviewId) {
      const job = store.db
        .prepare(
          "SELECT payload FROM jobs WHERE id=? AND kind='import' AND status='review'",
        )
        .get(body.reviewId);
      if (!job) throw new Error("待核对任务已变化，请刷新列表");
      const payload = JSON.parse(job.payload);
      if (payload.id) throw new Error("歌曲已经入库，请从曲库删除");
      file = payload.file;
    }
    file = await safeMedia(String(file || ""), [downloads]);
    const info = await lstat(file);
    if (!info.isFile()) throw new Error("只能删除下载区的媒体文件");
    const busy = store.db
      .prepare(
        "SELECT payload FROM jobs WHERE status IN ('queued','running','waiting-worker')",
      )
      .all()
      .some((j) => JSON.parse(j.payload).file === file);
    if (busy) throw new Error("媒体正在处理，请等待任务结束");
    const targets = [
      { path: file, directory: false, size: info.size, modified: info.mtimeMs },
    ];
    for (const sidecar of await intakeCleanupSources(store, file, downloads)) {
      const sideInfo = await lstat(sidecar.file);
      if (!sideInfo.isFile()) throw new Error("附属文件不是普通文件");
      targets.push({
        path: sidecar.file,
        directory: false,
        size: sideInfo.size,
        modified: sideInfo.mtimeMs,
      });
    }
    return {
      title: path.basename(file),
      targets,
      token: createHash("sha256").update(JSON.stringify(targets)).digest("hex"),
    };
  }
  app.post("/api/admin/inbox/delete-preview", admin, async (req, res) =>
    res.json(await inboxPlan(req.body)),
  );
  app.post("/api/admin/inbox/delete-files", admin, async (req, res) => {
    const plan = await inboxPlan(req.body);
    if (req.body.token !== plan.token)
      throw new Error("文件已变化，请重新查看删除清单");
    for (const target of plan.targets) await rm(target.path);
    for (const job of store.db
      .prepare(
        "SELECT id,payload FROM jobs WHERE kind IN ('import','local-intake')",
      )
      .all()) {
      if (JSON.parse(job.payload).file === plan.targets[0].path)
        store.db.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
    }
    emit("library", {});
    res.json({ ok: true });
  });
  app.get("/api/admin/library/:id/delete-preview", admin, async (req, res) => {
    res.json(
      await deletionPlan(store, req.params.id, allowed, cache, legacyCache),
    );
  });
  app.post("/api/admin/library/:id/delete-files", admin, async (req, res) => {
    await withSongWrite(
      store,
      req.params.id,
      async (song) => {
        if (
          isPlaying?.(song.id) ||
          snapshot?.().ambient?.song_id === song.id ||
          store.db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id)
        )
          throw new Error("请先移出播放队列");
        const key = deletionKey(song.id);
        store.set(key, { committed: false, targets: [] });
        try {
          const plan = await deletionPlan(
            store,
            song.id,
            allowed,
            cache,
            legacyCache,
          );
          if (!req.body.token || req.body.token !== plan.token)
            throw new Error("文件或歌曲资料已变化，请重新查看删除清单");
          quarantineDeletion(store, song.id, plan.targets, allowed, () => {
            for (const job of store.db
              .prepare("SELECT id,payload FROM jobs")
              .all()) {
              const p = JSON.parse(job.payload);
              if ([p.id, p.existingId, p.songId].includes(song.id))
                store.db.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
            }
            store.db.prepare("DELETE FROM songs WHERE id=?").run(song.id);
            for (const { key } of store.db
              .prepare("SELECT key FROM settings")
              .all()) {
              if (
                key !== deletionKey(song.id) &&
                (key.endsWith(":" + song.id) ||
                  key.includes(":" + song.id + ":"))
              )
                store.db.prepare("DELETE FROM settings WHERE key=?").run(key);
            }
          });
        } catch (error) {
          finishDeletion(store, song.id, allowed);
          throw error;
        }
      },
      { idle: true },
    );
    emit("library", {});
    res.json({ ok: true });
  });
}
