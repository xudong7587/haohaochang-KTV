import { favoriteBundles } from "./favorite-bundles.js";
import { normalizeLyricsStyle } from "../shared/lyrics-style.js";
import { randomUUID } from "node:crypto";
import { inspectPackage } from "./resource-health.js";
import { createSourceCandidate } from "../shared/source-candidate.js";
import { previewSourceCandidate } from "./sources.js";
import {
  resourceManifest,
  canEnqueue,
  resourceNames,
} from "./resource-manifest.js";
import { assertSongIdle, currentSong, checkRevision } from "./song-writes.js";
import { saveSongMetadata } from "./song-metadata.js";
import path from "node:path";
import { libraryVideoInfo } from "./library-video-info.js";
import { stat } from "node:fs/promises";
import {
  libraryTier,
  packageDir,
  present,
  savePackageInfo,
} from "./song-package.js";
import { sourceMetadata, canonicalVideo } from "./sources.js";
import {
  catalogSeed,
  identifyTitle,
  identifyVideo,
} from "../shared/catalog.js";
import { findLyrics } from "./lyrics-source.js";
import { searchText, safeMedia, inside } from "./media-utils.js";
import { biliCookie } from "./bili-credentials.js";
import { filesUnder, importKey, metadata } from "./library.js";
import { enrichSong } from "./enrichment.js";
import { hdUpgradeSource } from "./split-video.js";
import { queueMissingLyrics } from "./lyrics-batch.js";
import { recordingSource } from "./recording-source.js";
import { canonicalBiliRecording } from "../shared/video-refresh.js";
import {
  intakeKey,
  intakeRoot,
  assertLocalFileIdle,
  intakeCleanupSources,
} from "./local-intake.js";

async function posterAvailable(file) {
  if (!file) return false;
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
export function libraryApi({
  app,
  admin,
  member,
  store,
  cache,
  downloads,
  addJob,
  emit,
  resolveReview,
  snapshot,
  isPlaying,
}) {
  const { db, get, set } = store;
  const previews = new Map();
  app.post("/api/admin/lyrics-batch", admin, (req, res) => {
    const { all, items } = req.body;
    if (
      all !== true &&
      (!Array.isArray(items) || !items.length || items.length > 20)
    )
      throw new Error("每批需包含 1 至 20 首歌曲，或选择补充全部缺失歌词");
    const results = queueMissingLyrics(
      store,
      addJob,
      all === true ? undefined : items,
    );
    res.json({ results });
  });
  app.post("/api/admin/library/:id/compatible-video", admin, (req, res) => {
    const song = currentSong(store, req.params.id);
    assertSongIdle(store, song.id);
    checkRevision(song, req.body.expectedRevision, false);
    if (
      isPlaying?.(song.id) ||
      snapshot().ambient?.song_id === song.id ||
      db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id)
    )
      throw new Error("请在歌曲播放结束后转换兼容画面");
    const manifest = resourceManifest(store, song, cache);
    if (!manifest.video || !manifest.vocal || !manifest.backing)
      throw new Error("请先完成歌曲整理");
    res.json({
      id: addJob("compatible-video", {
        id: song.id,
        expectedRevision: song.metadataRevision,
      }),
    });
  });
  const assertIdle = (id) => assertSongIdle(store, id);
  const organize = (req, res) => {
    const song = db
      .prepare("SELECT * FROM songs WHERE id=?")
      .get(req.params.id);
    if (!song) throw new Error("歌曲不存在");
    assertIdle(song.id);
    checkRevision(song, req.body.expectedRevision, false);
    if (db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id))
      throw new Error("请先移出播放队列");
    const known =
      song.title?.trim() && song.artist?.trim() && song.artist !== "未知歌手";
    res.json({
      id: addJob("organize", {
        id: song.id,
        approved: !!known,
        ...(known
          ? {
              metadata: {
                title: song.title,
                artist: song.artist,
                lyrics: song.lyrics || "",
                needs_review: 0,
              },
            }
          : {}),
      }),
    });
  };
  app.post("/api/admin/library/:id/organize", admin, organize);
  app.post("/api/admin/refresh-metadata-batch", admin, async (req, res) => {
    const items = req.body.items;
    if (!Array.isArray(items) || !items.length || items.length > 20)
      throw new Error("每批需包含 1 至 20 首歌曲");
    const results = [];
    for (const item of items) {
      try {
        const song = currentSong(store, item.id);
        assertIdle(song.id);
        checkRevision(song, item.expectedRevision);
        let parsed = identifyTitle(song.title + " - " + song.artist);
        if (parsed.needs_review && get("enrichment", {}).enabled)
          parsed = await enrichSong(get("enrichment"), {
            title: song.title,
            artist: song.artist,
            sourceUrl: "",
          });
        if (parsed.needs_review)
          results.push({
            id: song.id,
            status: "review",
            message: "无法可靠确认，请手动核对歌名和歌手",
          });
        else {
          await saveSongMetadata(
            store,
            song.id,
            {
              title: parsed.title,
              artist: parsed.artist,
              expectedRevision: item.expectedRevision,
              metadata_source: "自动识别",
              needs_review: 0,
            },
            cache,
          );
          results.push({
            id: song.id,
            status: "success",
            message: "歌名与歌手已更新",
          });
        }
      } catch (error) {
        results.push({
          id: item?.id,
          status:
            error.code === "REVISION_CONFLICT"
              ? "conflict"
              : error.code === "SONG_BUSY"
                ? "skipped"
                : "failed",
          message: error.message,
        });
      }
    }
    emit("library", {});
    res.json({ results });
  });
  app.post("/api/admin/refresh-metadata", admin, async (req, res) => {
    const song = req.body.id
      ? db.prepare("SELECT * FROM songs WHERE id=?").get(req.body.id)
      : null;
    const title = String(req.body.title || song?.title || "").trim(),
      artist = String(req.body.artist || song?.artist || "").trim();
    let result;
    if (req.body.url) {
      const source = await sourceMetadata(
        req.body.url,
        biliCookie(store),
      );
      result = {
        ...identifyVideo(source),
        sourceTitle: source.title,
        duration: source.duration,
      };
    } else result = identifyTitle(title + " - " + artist);
    if (result.needs_review && get("enrichment", {}).enabled)
      result = await enrichSong(get("enrichment"), {
        title,
        artist,
        sourceUrl: req.body.url || "",
      });
    res.json({
      ...result,
      note: result.needs_review
        ? "无法可靠确认，请手动核对歌名和歌手"
        : "已匹配歌名与歌手，保存后生效",
    });
  });
  app.get("/api/admin/library", admin, async (req, res) => {
    const rows = db
      .prepare("SELECT * FROM songs ORDER BY created DESC")
      .all()
      .filter(
        (s) =>
          !!get("hidden:" + s.id) === (req.query.hidden === "true") &&
          (!req.query.artist || s.artist === req.query.artist),
      );
    const result = await Promise.all(
      rows.map(async (row) => {
        if (get("package-ready:" + row.id) && get("package:" + row.id))
          await inspectPackage(store, row, get("package:" + row.id));
        const s = currentSong(store, row.id),
          manifest = resourceManifest(store, s, cache);
        return {
          ...s,
          tier: manifest.tier,
          manifest,
          videoInfo: await libraryVideoInfo(store, s, manifest, cache),
          missing: manifest.missing,
          hasPoster: await posterAvailable(s.poster),
          posterSource: get("poster-source:" + s.id, null),
          posterAttempt: get("poster-attempt:" + s.id, null),
          lyricsSource: get("lyrics-match:" + s.id, null),
          recordingSource: recordingSource(store, s),
          canUpgradeHd:
            manifest.vocal && manifest.backing && !!hdUpgradeSource(store, s),
          lyricsAlignment:
            get("lyrics-auto:" + s.id)?.lyrics === s.lyrics
              ? { shiftMs: get("lyrics-auto:" + s.id).shiftMs }
              : null,
          sourceUrl:
            recordingSource(store, s)?.url ||
            get("video-source:" + s.id)?.url ||
            get("source:" + s.id)?.canonicalUrl ||
            get("source:" + s.id)?.url ||
            get("download-quality:" + s.id)?.sourceUrl ||
            "",
          folder: get("package:" + s.id, "尚未生成新格式"),
        };
      }),
    );
    res.json(result);
  });
  app.get("/api/catalog", member, (req, res) => {
    const q = String(req.query.q || "").toLowerCase();
    const entries = [...catalogSeed, ...get("catalog", [])];
    const unique = [
      ...new Map(entries.map((s) => [s.artist + "\0" + s.title, s])).values(),
    ];
    res.json(
      unique
        .filter((s) => searchText(s.title, s.artist).includes(q))
        .slice(0, 300)
        .map((s) => ({
          ...s,
          localId:
            db
              .prepare("SELECT * FROM songs WHERE title=? AND artist=?")
              .all(s.title, s.artist)
              .find((song) => canEnqueue(store, song, cache))?.id || null,
        })),
    );
  });
  app.post("/api/admin/catalog", admin, (req, res) => {
    const rows = req.body.songs;
    if (
      !Array.isArray(rows) ||
      rows.length > 1000 ||
      rows.some(
        (s) =>
          typeof s.title !== "string" ||
          typeof s.artist !== "string" ||
          !s.title.trim() ||
          !s.artist.trim(),
      )
    )
      throw new Error(
        "请导入包含 title、artist 的 JSON 数组，每批最多 1000 首",
      );
    set("catalog", [
      ...get("catalog", []),
      ...rows.map((s) => ({
        title: s.title.trim().slice(0, 120),
        artist: s.artist.trim().slice(0, 120),
      })),
    ]);
    res.json({ ok: true });
  });
  app.post("/api/admin/source-info", admin, async (req, res) => {
    let candidate = await previewSourceCandidate(
      req.body.url,
      biliCookie(store),
    );
    if (candidate.identity.needs_review && get("enrichment", {}).enabled) {
      const parsed = await enrichSong(get("enrichment"), {
        title: candidate.externalTitle,
        sourceUrl: candidate.canonicalUrl,
      });
      candidate = createSourceCandidate(
        {
          ...candidate,
          reviewReasons: [],
          evidence: [...candidate.evidence, ...(parsed.evidence || [])],
        },
        parsed,
      );
    }
    const candidateId = randomUUID();
    previews.set(candidateId, { candidate, created: Date.now() });
    if (previews.size > 200) previews.delete(previews.keys().next().value);
    res.json({
      ...candidate.identity,
      videoTitle: candidate.externalTitle,
      duration: candidate.duration,
      url: candidate.canonicalUrl,
      candidate,
      candidateId,
    });
  });
  app.get("/api/admin/inbox", admin, async (req, res) => {
    const handled = db
      .prepare(
        "SELECT id,payload,status,stage FROM jobs WHERE kind IN ('import','local-intake') AND status IN ('review','running','queued','waiting-worker')",
      )
      .all()
      .map((j) => ({ ...j, payload: JSON.parse(j.payload) }));
    const groupedFiles = new Set(
      favoriteBundles(store).flatMap((g) =>
        g.parts.map((p) => p.file).filter(Boolean),
      ),
    );
    const rows = [];
    for (const file of await filesUnder(downloads)) {
      if (groupedFiles.has(file)) continue;
      try {
        const info = await stat(file);
        const job = handled.find((j) => j.payload.file === file);
        const intake = get(intakeKey(file));
        if (inside(intakeRoot(downloads), file) && intake?.status !== "staged")
          continue;
        if (get(importKey(file, info)) || job?.status === "review") continue;
        rows.push({
          id: importKey(file, info),
          file,
          inbox: true,
          ...(await metadata(file, [downloads])),
          ...(job?.payload.metadata || {}),
          ...(intake?.status === "staged"
            ? { ...intake.metadata, intakeStage: "staged", tier: "audio" }
            : {}),
          processing: !!job,
          status: job?.status || "import",
          jobId: job?.id,
          note: job
            ? {
                queued: "已加入整理队列",
                running: "正在整理，完成后自动更新",
                "waiting-worker": "等待 PC 上线后继续",
              }[job.status]
            : intake?.metadata?.note || "下载工作区 · 等待信息完整和文件稳定",
          lyrics: "",
        });
      } catch (error) {
        rows.push({
          id: file,
          file,
          inbox: true,
          title: path.basename(file),
          artist: "未知歌手",
          note: "读取失败：" + error.message,
        });
      }
    }
    res.json(rows);
  });
  app.post("/api/admin/inbox/complete-metadata", admin, async (req, res) => {
    const file = await safeMedia(String(req.body.file || ""), [downloads]);
    const artistOverride = String(req.body.artistOverride || "").trim();
    if (
      artistOverride.length > 120 ||
      /[\x00-\x1f]/.test(artistOverride) ||
      artistOverride === "未知歌手"
    )
      throw new Error("请填写有效的歌手名字");
    if (inside(intakeRoot(downloads), file) && !artistOverride)
      throw new Error("文件已在半标准曲库，请核对后确认入库");
    if (req.body.reviewId) {
      const job = db
        .prepare(
          "SELECT payload FROM jobs WHERE id=? AND kind='import' AND status='review'",
        )
        .get(req.body.reviewId);
      const p = job ? JSON.parse(job.payload) : null;
      if (
        !p ||
        p.file !== file ||
        p.id ||
        p.existingId ||
        p.candidate ||
        p.sourceUrl ||
        p.url ||
        p.onlineSelection ||
        p.replacementUrl
      )
        throw new Error("该项目不是待核对的本地文件");
    }
    assertLocalFileIdle(store, file, req.body.reviewId);
    const info = await stat(file);
    if (get(importKey(file, info)))
      throw new Error("该文件已经导入，请刷新列表");
    const id = addJob("local-intake", {
      file,
      signature: info.size + ":" + info.mtimeMs,
      artistOverride,
    });
    if (req.body.reviewId)
      db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(
        req.body.reviewId,
      );
    res.json({ id });
  });
  const submitInbox = async (req, res) => {
    const file = await safeMedia(String(req.body.file || ""), [downloads]),
      info = await stat(file);
    if (
      inside(intakeRoot(downloads), file) &&
      get(intakeKey(file))?.status !== "staged"
    )
      throw new Error("文件还在移动，请等待元数据整理完成");
    const existing = db
      .prepare(
        "SELECT id,payload,status FROM jobs WHERE kind='import' AND status IN ('queued','running','review','waiting-worker')",
      )
      .all()
      .find((j) => JSON.parse(j.payload).file === file);
    if (existing) {
      if (existing.status === "review")
        throw new Error("媒体已进入待核对，请刷新后从待核对项目继续");
      return res.json({ id: existing.id, existing: true });
    }
    const title = String(req.body.title || "")
        .trim()
        .slice(0, 120),
      artist = String(req.body.artist || "")
        .trim()
        .slice(0, 120);
    if (!title || !artist || artist === "未知歌手")
      throw new Error("请填写歌名和歌手");
    const replacementUrl = req.body.sourceUrl
      ? canonicalVideo(req.body.sourceUrl)
      : undefined;
    const localIntake =
      get(intakeKey(file))?.status === "staged" && !replacementUrl;
    const cleanupSources = localIntake
      ? await intakeCleanupSources(store, file, downloads)
      : undefined;
    assertLocalFileIdle(store, file);
    res.json({
      id: addJob("import", {
        file,
        ...(localIntake ? { localIntake: true, cleanupSources } : {}),
        signature: info.size + ":" + info.mtimeMs,
        replacementUrl,
        approved: true,
        metadata: {
          ...(localIntake
            ? {
                albumHint: get(intakeKey(file))?.metadata?.albumHint,
                ...(artist === get(intakeKey(file))?.metadata?.artist
                  ? {
                      poster: get(intakeKey(file))?.metadata?.poster,
                      albumPoster: get(intakeKey(file))?.metadata?.albumPoster,
                    }
                  : {}),
              }
            : {}),
          title,
          artist,
          lyrics: replacementUrl
            ? ""
            : String(req.body.lyrics || "").slice(0, 25000),
          tags: [],
          needs_review: 0,
          metadata_source: "手动",
        },
      }),
    });
  };
  app.post("/api/admin/inbox", admin, submitInbox);
  app.post("/api/admin/organize-batch", admin, async (req, res) => {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length > 20)
      throw new Error("每批最多提交 20 首");
    const results = [];
    for (const item of items) {
      let result = { id: item?.id, title: item?.title, artist: item?.artist };
      try {
        if (!["song", "inbox", "review"].includes(item?.kind))
          throw new Error("无效的整理类型");
        const handler = {
          song: organize,
          inbox: submitInbox,
          review: resolveReview,
        }[item?.kind];
        if (!handler) throw new Error("无效的整理类型");
        // Reuse the same revision, queue and file checks as individual actions.
        let output;
        await handler(
          {
            params: { id: item.id },
            body: {
              title: item.title,
              artist: item.artist,
              file: item.file,
              expectedRevision: item.expectedRevision,
              action: "confirm",
            },
          },
          {
            json: (value) => {
              output = value;
              return value;
            },
          },
        );
        result = {
          ...result,
          status: output?.existing ? "skipped" : "success",
          message: output?.existing ? "已在整理队列中" : "已加入整理队列",
        };
      } catch (error) {
        result = {
          ...result,
          status:
            error.code === "SONG_BUSY"
              ? "skipped"
              : error.code === "REVISION_CONFLICT"
                ? "conflict"
                : "failed",
          message: error.message,
        };
      }
      results.push(result);
    }
    res.json({ results });
  });
  app.post("/api/admin/inbox-link", admin, async (req, res) => {
    const url = canonicalVideo(req.body.url);
    let candidate;
    if (req.body.candidateId) {
      const preview = previews.get(req.body.candidateId);
      if (!preview || Date.now() - preview.created > 3600000)
        throw new Error("链接预览已过期，请重新解析");
      candidate = preview.candidate;
      if (candidate.canonicalUrl !== url)
        throw new Error("链接与已预览候选不一致，请重新解析");
    } else
      candidate = await previewSourceCandidate(
        url,
        biliCookie(store),
      );
    res.json({
      id: addJob("download", {
        url,
        title: candidate.externalTitle,
        candidate,
        enqueue: false,
      }),
    });
  });
  app.post("/api/admin/migrate-packages", admin, (req, res) => {
    const rows = db
      .prepare("SELECT id FROM songs WHERE status='ready'")
      .all()
      .filter(
        (s) =>
          !get("package-ready:" + s.id) &&
          !db.prepare("SELECT id FROM queue WHERE song_id=?").get(s.id),
      );
    for (const row of rows) addJob("prepare", { id: row.id });
    res.json({ count: rows.length });
  });
  app.post("/api/admin/standardize-batch", admin, (req, res) => {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length > 20)
      throw new Error("每批最多 20 首");
    const results = items.map((item) => {
      try {
        const song = currentSong(store, item.id);
        checkRevision(song, item.expectedRevision);
        assertIdle(song.id);
        if (
          get("hidden:" + song.id) ||
          resourceManifest(store, song, cache).tier !== "standard"
        )
          throw new Error("仅整理标准曲库内的歌曲");
        if (
          isPlaying?.(song.id) ||
          snapshot?.().ambient?.song_id === song.id ||
          db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id)
        )
          return {
            id: song.id,
            status: "skipped",
            message: "正在播放队列中，已跳过",
          };
        return {
          id: song.id,
          status: "success",
          message: "已排队检查格式并回收旧版本",
          jobId: addJob("standardize", { id: song.id }),
        };
      } catch (error) {
        return {
          id: item?.id,
          status: error.code === "SONG_BUSY" ? "skipped" : "failed",
          message: error.message,
        };
      }
    });
    res.json({ results });
  });
  app.post(
    "/api/admin/library/:id/lyrics-alignment/reset",
    admin,
    async (req, res) => {
      const song = currentSong(store, req.params.id),
        record = get("lyrics-auto:" + song.id);
      if (!record || record.lyrics !== song.lyrics)
        throw new Error("歌词已手动更新，无法覆盖为旧稿");
      await saveSongMetadata(
        store,
        song.id,
        {
          lyrics: record.original,
          expectedRevision: req.body.expectedRevision,
        },
        cache,
      );
      set("lyrics-auto:" + song.id, { ...record, restored: true });
      emit("library", {});
      res.json({ ok: true });
    },
  );
  app.post("/api/admin/find-lyrics", admin, async (req, res) =>
    res.json(
      await findLyrics(
        req.body.title,
        req.body.artist,
        Number(req.body.duration) || 0,
        {
          manual: true,
          source: ["qqmusic", "netease", "lrclib", "local-lrc"].includes(
            req.body.source,
          )
            ? req.body.source
            : "auto",
        },
      ),
    ),
  );
  app.get("/api/lyrics-style", member, (req, res) =>
    res.json(normalizeLyricsStyle(get("lyricsStyle", {}))),
  );
  app.post("/api/admin/lyrics-style", admin, (req, res) => {
    const value = normalizeLyricsStyle(req.body);
    set("lyricsStyle", value);
    res.json(value);
  });
  app.get("/api/playback-assets/:id", member, async (req, res) => {
    const song = db
      .prepare("SELECT * FROM songs WHERE id=?")
      .get(req.params.id);
    if (!song) throw new Error("歌曲不存在");
    if (get("package-ready:" + song.id) && get("package:" + song.id))
      await inspectPackage(store, song, get("package:" + song.id));
    res.json(resourceManifest(store, currentSong(store, song.id), cache));
  });
  app.get("/api/assets/:id/:kind", member, async (req, res) => {
    const names = {
      video: "画面.mp4",
      vocal: "原唱.m4a",
      backing: "伴奏.m4a",
      lyrics: "歌词.lrc",
    };
    const song = db
      .prepare("SELECT * FROM songs WHERE id=?")
      .get(req.params.id);
    if (!song || !names[req.params.kind]) throw new Error("资源不存在");
    const revision =
      req.query.r === undefined ? song.resourceRevision : Number(req.query.r);
    const dir =
      revision === song.resourceRevision
        ? get("package:" + song.id)
        : get("package-version:" + song.id + ":" + revision);
    if (!dir) throw Object.assign(new Error("资源版本不存在"), { status: 404 });
    res.sendFile(
      await safeMedia(path.join(dir, names[req.params.kind]), [cache]),
    );
  });
  app.post("/api/admin/library/:id/save", admin, async (req, res) => {
    const song = db
      .prepare("SELECT * FROM songs WHERE id=?")
      .get(req.params.id);
    if (!song) throw new Error("歌曲不存在");
    assertIdle(song.id);
    if (db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id))
      throw new Error("请先将歌曲移出播放队列");
    const title = String(req.body.title || "")
        .trim()
        .slice(0, 120),
      artist = String(req.body.artist || "")
        .trim()
        .slice(0, 120),
      lyrics = String(req.body.lyrics || "").slice(0, 25000);
    if (!title || !artist) throw new Error("请填写歌名和歌手");
    const updated = await saveSongMetadata(
      store,
      song.id,
      {
        title,
        artist,
        lyrics,
        lyricsSource: req.body.lyricsSource || {
          source: "手动 LRC",
          offsetUnit: "milliseconds",
        },
        expectedRevision: req.body.expectedRevision,
        metadata_source: "手动",
        needs_review: 0,
      },
      cache,
    );
    if (req.body.prepare) addJob("organize", { id: song.id });
    emit("library", {});
    res.json({ ok: true, metadataRevision: updated.metadataRevision });
  });
  app.post("/api/admin/library/:id/source", admin, (req, res) => {
    const song = db
      .prepare("SELECT * FROM songs WHERE id=?")
      .get(req.params.id);
    if (!song) throw new Error("歌曲不存在");
    assertIdle(song.id);
    const url = canonicalBiliRecording(req.body.url);
    if (db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id))
      throw new Error("请先移出播放队列");
    checkRevision(song, req.body.expectedRevision);
    res.json({
      id: addJob("refresh-video", {
        id: song.id,
        url,
        clip: null,
        quality: "highest",
        expectedRevision: song.metadataRevision,
        priority: "online",
      }),
    });
  });
  app.post("/api/admin/library/:id/upgrade-hd", admin, (req, res) => {
    const song = currentSong(store, req.params.id);
    assertIdle(song.id);
    checkRevision(song, req.body.expectedRevision);
    const manifest = resourceManifest(store, song, cache);
    if (!manifest.vocal || !manifest.backing || !hdUpgradeSource(store, song))
      throw new Error("仅支持有原视频裁剪记录的双音轨歌曲升级高清画面");
    if (
      isPlaying?.(song.id) ||
      snapshot?.().ambient?.song_id === song.id ||
      db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id)
    )
      throw new Error("请先将歌曲移出播放队列");
    res.json({
      id: addJob("refresh-video", {
        id: song.id,
        url: hdUpgradeSource(store, song).url,
        clip: hdUpgradeSource(store, song).clip,
        quality: "highest",
        expectedRevision: song.metadataRevision,
        priority: "online",
      }),
    });
  });
  app.post("/api/admin/library/:id/restore", admin, (req, res) => {
    currentSong(store, req.params.id);
    set("hidden:" + req.params.id, false);
    emit("library", {});
    res.json({ ok: true });
  });
  app.delete("/api/admin/library/:id", admin, (req, res) => {
    if (db.prepare("SELECT id FROM queue WHERE song_id=?").get(req.params.id))
      throw new Error("请先移出播放队列");
    assertIdle(req.params.id);
    set("hidden:" + req.params.id, true);
    emit("library", {});
    res.json({ ok: true, note: "已从曲库隐藏，原始媒体保留，可恢复" });
  });
}
