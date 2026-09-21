import { deliverJobSong } from "../room-targets.js";
import { metadataFromCandidate } from "../../shared/source-candidate.js";
import { withSongWrite } from "../song-writes.js";
import { identifyTitle } from "../../shared/catalog.js";
import { findLyrics } from "../lyrics-source.js";
import { sourceMetadata, withBiliCookie } from "../sources.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stat, copyFile } from "node:fs/promises";
import { safeMedia } from "../media-utils.js";
import { enrichSong } from "../enrichment.js";
import { metadata, importMedia, importKey } from "../library.js";
import { downloadVideo, prepareSong } from "../media.js";
import { separateSong } from "../separation.js";
import { upgradeSplitVideo } from "../split-video.js";
import { biliCookie } from "../bili-credentials.js";

export async function importJob(job, payload, context) {
  const {
    db,
    get,
    set,
    store,
    dir,
    roots,
    downloads,
    cache,
    legacyCache,
    emit,
    addJob,
    enqueue,
    fail,
  } = context;
  if (job.kind === "import") {
    if (payload.replacementUrl) {
      const originalFile = payload.file,
        originalInfo = await stat(originalFile);
      const replacement = await withBiliCookie(
        biliCookie(store),
        dir,
        (cookieFile) =>
          downloadVideo(payload.replacementUrl, downloads, cookieFile),
      );
      const downloaded = await stat(replacement.file);
      set(importKey(originalFile, originalInfo), "replaced-by:" + job.id);
      payload = {
        ...payload,
        file: replacement.file,
        signature: downloaded.size + ":" + downloaded.mtimeMs,
        sourceUrl: payload.replacementUrl,
        replacementUrl: undefined,
        metadata: { ...payload.metadata, lyrics: "" },
      };
      db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
        JSON.stringify(payload),
        job.id,
      );
    }
    const sourceInfo = await stat(payload.file);
    if (payload.signature !== sourceInfo.size + ":" + sourceInfo.mtimeMs)
      throw fail(409, "下载文件仍在变化，等待下次检查");
    let meta = payload.approved
      ? payload.metadata
      : payload.candidate
        ? {
            ...(await metadata(payload.file, [downloads])),
            ...metadataFromCandidate(payload.candidate),
          }
        : await metadata(payload.file, [downloads]);
    if (!payload.approved && !payload.candidate) {
      let videoTitle = payload.title;
      const bv = path
        .basename(payload.file)
        .match(/(BV[a-zA-Z0-9]+).*S\d+E(\d+)/i);
      if (!videoTitle && bv) {
        try {
          const info = await sourceMetadata(
            "https://www.bilibili.com/video/" + bv[1] + "?p=" + Number(bv[2]),
            biliCookie(store),
          );
          videoTitle = info.title;
        } catch {}
      }
      if (videoTitle) meta = { ...meta, ...identifyTitle(videoTitle) };
    }
    if (
      !payload.approved &&
      !payload.candidate &&
      get("enrichment", {}).enabled
    )
      meta = {
        ...meta,
        ...(await enrichSong(get("enrichment"), {
          title: payload.title || meta.title,
          artist: meta.artist,
          tags: meta.tags,
          sourceUrl: payload.sourceUrl || "",
        })),
      };
    let lyrics = meta.lyrics || "";
    if (!lyrics) {
      try {
        lyrics = await readFile(
          path.join(
            path.dirname(payload.file),
            path.parse(payload.file).name + ".lrc",
          ),
          "utf8",
        );
      } catch {}
    }
    if (!lyrics && !meta.needs_review) {
      try {
        const result = await findLyrics(
          meta.title,
          meta.artist,
          (await (await import("../media-utils.js")).probe(payload.file))
            .duration,
        );
        lyrics = result.lyrics;
        meta.lyricsSource = { ...result, lyrics: undefined };
      } catch {}
    }
    meta.lyrics = lyrics;
    if (meta.needs_review) {
      db.prepare(
        "UPDATE jobs SET status='review',payload=?,error=? WHERE id=?",
      ).run(
        JSON.stringify({ ...payload, metadata: meta }),
        meta.note || "请补充歌手、歌名后继续",
        job.id,
      );
      emit("library", {});
      return "review";
    }
    if (payload.isBacking) meta.mode = "instrumental";
    if (
      (meta.mode === "instrumental" || !get("ai", {}).enabled) &&
      !["tracks", "channels"].includes(meta.mode)
    ) {
      db.prepare(
        "UPDATE jobs SET status='review',payload=?,error=? WHERE id=?",
      ).run(
        JSON.stringify({ ...payload, metadata: meta }),
        meta.mode === "instrumental"
          ? "仅有伴奏，仍需补充原唱资源"
          : "请先配置 PC 或云端分离服务，再继续制作双版本",
        job.id,
      );
      return "review";
    }
    const id = await importMedia(
      store,
      payload.file,
      downloads,
      roots[0],
      meta,
    );
    if (meta.albumPoster && !get("poster-source:" + id))
      set("poster-source:" + id, meta.albumPoster);
    if (meta.albumHint && !get("album-hint:" + id))
      set("album-hint:" + id, meta.albumHint);
    await withSongWrite(
      store,
      id,
      async () => {
        db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
          JSON.stringify({ ...payload, id, metadata: meta, approved: true }),
          job.id,
        );
        const existing = db.prepare("SELECT * FROM songs WHERE id=?").get(id);
        if (existing.status === "ready" && payload.videoFile)
          await upgradeSplitVideo(
            store,
            existing,
            await safeMedia(payload.videoFile, [downloads]),
            payload.sourceUrl,
            cache,
          );
        if (existing.status !== "ready") {
          if (payload.videoFile) {
            const source = await safeMedia(payload.videoFile, [downloads]);
            const retained = path.join(
              path.dirname(existing.path),
              "来源画面.mp4",
            );
            await copyFile(source, retained);
            set("split-video:" + id, retained);
            set("download-quality:" + id, {
              height: payload.downloadedHeight,
              sourceUrl: payload.sourceUrl,
            });
          }
          if (payload.candidate) set("source:" + id, payload.candidate);
          if (payload.sourceUrl)
            set("recording-source:" + id, {
              url: payload.sourceUrl,
              // All onlineSelection downloads explicitly carry the clip choice.
              ...(payload.approved ? { clip: payload.clip || null } : {}),
              updated: Date.now(),
            });
          if (meta.lyricsSource) set("lyrics-match:" + id, meta.lyricsSource);
          db.prepare("UPDATE songs SET evidence=?,lyrics=? WHERE id=?").run(
            JSON.stringify(meta.evidence || []),
            meta.lyrics || "",
            id,
          );
          context.report?.("preparing");
          await prepareSong(
            store,
            id,
            [...roots, downloads, path.join(dir, "downloads")],
            cache,
          );
        }
        const song = db.prepare("SELECT * FROM songs WHERE id=?").get(id);
        if (song.mode === "original" && get("ai", {}).enabled) {
          context.report?.("separating");
          await separateSong(store, song, cache);
        }
        deliverJobSong(store, enqueue, job, id);
      },
      { wait: true, jobId: job.id },
    );
  }
}
