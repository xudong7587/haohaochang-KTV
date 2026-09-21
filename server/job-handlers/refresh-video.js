import path from "node:path";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { videoRefreshMode } from "../../shared/video-refresh.js";
import { recordingSource } from "../recording-source.js";
import { downloadBiliTracks } from "../bili-download.js";
import { clipOnPc, clipRange, waitingWorker } from "../clipping.js";
import { probe } from "../media-utils.js";
import { stageResources } from "../resource-publication.js";
import {
  encodePicture,
  encodePackageResource,
  encodeResource,
  savePackageInfo,
} from "../song-package.js";
import { requireHealthyPackage } from "../resource-health.js";
import { separateRecording } from "../separation/recording.js";
import { findLyrics } from "../lyrics-source.js";
import { alignLyrics } from "../lyrics-alignment.js";
import {
  publicationKey,
  metadataRevisionFor,
  checkRevision,
} from "../song-writes.js";
import { resourceManifest } from "../resource-manifest.js";
import { biliCookie } from "../bili-credentials.js";

export async function refreshVideo(job, payload, context) {
  const { store, cache, downloads } = context;
  const song = store.db
    .prepare("SELECT * FROM songs WHERE id=?")
    .get(payload.id);
  if (!song) throw new Error("歌曲不存在");
  const published = publicationKey(song.id, "refresh-video");
  if (published && store.get(published)) return;
  if (payload.expectedRevision !== undefined)
    checkRevision(song, payload.expectedRevision);
  const assertNotPlaying = () => {
    if (
      context.isPlaying?.(song.id) ||
      store.db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id)
    )
      throw new Error("请先将歌曲移出播放队列，更新期间旧资源保持可用");
  };
  assertNotPlaying();
  const plan = videoRefreshMode(
    recordingSource(store, song),
    payload.url,
    payload.clip,
  );
  const available = resourceManifest(store, song, cache);
  if (!available.vocal || !available.backing) plan.mode = "recording";
  if (plan.mode === "recording" && !store.get("ai", {}).enabled)
    throw waitingWorker("本次更新需要重新分离伴奏，请启用 PC 整理器");
  // Separate cache per operation: a refresh fetches the current B站 streams,
  // while an interrupted retry can reuse its own complete download.
  if (!/^[a-zA-Z0-9_-]+$/.test(job.id)) throw new Error("Invalid update job");
  const taskRoot = path.join(downloads, ".ktv-online", "refresh", job.id);
  context.report?.("downloading");
  const downloaded = await (context.downloadRecording || downloadBiliTracks)(
    plan.url,
    taskRoot,
    biliCookie(store),
    payload.quality || "highest",
    payload.expectedHeight || 0,
  );
  const info = await probe(downloaded.videoFile);
  const clip = payload.clip ? clipRange(payload.clip, info.duration) : null;
  const picture = await clipOnPc(
    store,
    job,
    { ...payload, clip, title: song.title, artist: song.artist },
    downloaded.videoFile,
    downloads,
    true,
  );
  const stage = await stageResources(store, song, cache, {
    phase: "refresh-video",
    copy: plan.mode === "video-only",
  });
  let result;
  try {
    context.report?.("preparing-video");
    await encodePicture(stage.store, song, picture, stage.directory);
    const patch = { needs_video: 0, error: "" };
    if (plan.mode === "recording") {
      context.report?.("preparing-audio");
      const source = path.join(stage.directory, "来源.m4a");
      if (clip)
        await encodeResource(
          [
            "-i",
            downloaded.file,
            "-ss",
            String(clip.start),
            "-t",
            String(clip.end - clip.start),
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
          ],
          source,
        );
      else await copyFile(downloaded.file, source);
      const audio = await probe(source);
      const nextSong = {
        ...song,
        path: source,
        mode: "original",
        duration: audio.duration,
      };
      await encodePackageResource(
        stage.store,
        nextSong,
        "vocal",
        [
          "-i",
          source,
          "-vn",
          "-map",
          "0:a:0",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-ac",
          "2",
        ],
        stage.directory,
      );
      context.report?.("separating");
      const staging = path.join(stage.directory, "分离暂存");
      await mkdir(staging);
      result = await (context.separateRecording || separateRecording)(
        stage.store,
        nextSong,
        path.join(stage.directory, "原唱.m4a"),
        staging,
      );
      await encodePackageResource(
        stage.store,
        nextSong,
        "backing",
        ["-i", result.file, "-vn", "-c:a", "aac", "-b:a", "192k", "-ac", "2"],
        stage.directory,
      );
      await rm(staging, { recursive: true, force: true });
      context.report?.("lyrics");
      let lyrics = "",
        lyricsSource;
      try {
        const found = await (context.findRecordingLyrics || findLyrics)(
          song.title,
          song.artist,
          audio.duration,
        );
        lyrics = found.lyrics || "";
        lyricsSource = {
          ...found,
          lyrics: undefined,
          status: lyrics ? "candidate" : "missing",
        };
      } catch {
        lyricsSource = {
          status: "missing-after-refresh",
          message: "新录音未找到匹配歌词，请补充 LRC；旧歌词已留档",
        };
      }
      const aligned =
        lyrics &&
        alignLyrics(lyrics, result.vocalActivity, {
          title: song.title,
          artist: song.artist,
          duration: audio.duration,
        });
      if (aligned) lyrics = aligned.lyrics;
      stage.store.set(`recording-history:${song.id}:${song.resourceRevision}`, {
        source: recordingSource(store, song),
        lyrics: song.lyrics,
        lyricsOffsetMs: store.get("lyrics-offset:" + song.id, 0),
        updated: Date.now(),
      });
      stage.store.set("lyrics-offset:" + song.id, 0);
      stage.store.set("lyrics-match:" + song.id, lyricsSource);
      stage.store.set(
        "lyrics-auto:" + song.id,
        aligned ? { ...aligned, lyrics } : null,
      );
      stage.store.set("package-fingerprint:" + song.id, null);
      Object.assign(patch, {
        path: source,
        mode: "separated",
        status: "ready",
        duration: audio.duration,
        audio: JSON.stringify(audio.audio),
        lyrics,
        needs_review: 0,
        evidence: JSON.stringify([
          { kind: "user-selection", url: plan.url, clip },
        ]),
      });
    }
    stage.store.set(
      "split-video:" + song.id,
      path.join(stage.directory, "画面.mp4"),
    );
    stage.store.set("recording-source:" + song.id, {
      url: plan.url,
      clip,
      updated: Date.now(),
    });
    stage.store.set("video-source:" + song.id, {
      url: plan.url,
      path: path.join(stage.directory, "画面.mp4"),
      keepAudio: true,
      recordingMatched: true,
      offset: 0,
      clip,
    });
    stage.store.set("download-quality:" + song.id, {
      height: (await probe(picture)).height,
      sourceUrl: plan.url,
    });
    stage.store.set("package-ready:" + song.id, true);
    const updated = {
      ...song,
      ...patch,
      metadataRevision: metadataRevisionFor(song, patch),
      resourceRevision: song.resourceRevision + 1,
    };
    await savePackageInfo(stage.store, updated, cache);
    await requireHealthyPackage(stage.store, updated, stage.directory, [
      "video",
      "vocal",
      "backing",
    ]);
    assertNotPlaying();
    stage.publish(patch);
  } catch (error) {
    await stage.abandon();
    throw error;
  }
  // Publication is already committed. Cleanup must never abandon the live version.
  if (result) store.set(result.checkpointKey, null);
  // Only disposable input copies belonging to this operation are removed.
  await rm(taskRoot, { recursive: true, force: true }).catch(() => {});
}
