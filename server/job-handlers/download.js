import { prepareTaskDirectory } from "../task-files.js";
import { checkTaskCancellation } from "../task-cancellation.js";
import path from "node:path";
import { clipOnPc } from "../clipping.js";
import { withBiliCookie } from "../sources.js";
import { stat } from "node:fs/promises";
import { downloadVideo } from "../media.js";
import { downloadBiliTracks } from "../bili-download.js";
import { encodeResource } from "../song-package.js";
import { taskProgress } from "../task-progress.js";
import { biliCookie } from "../bili-credentials.js";

export async function download(job, payload, context) {
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
  if (job.kind === "download") {
    const workspace = await prepareTaskDirectory(downloads, job.id);
    checkTaskCancellation();
    context.report?.("downloading");
    const split =
      payload.onlineSelection &&
      new URL(payload.url).hostname === "www.bilibili.com";
    const downloaded = split
      ? await downloadBiliTracks(
          payload.url,
          path.join(workspace, "dash"),
          biliCookie(store),
          payload.quality,
          payload.expectedHeight,
          {
            progress: (label, percent) =>
              taskProgress(store, job.id, { label, percent }),
          },
        )
      : await withBiliCookie(biliCookie(store), dir, (file) =>
          downloadVideo(payload.url, workspace, file, payload.quality),
        );
    taskProgress(store, job.id, null);
    const original = downloaded.file;
    if (payload.clip) context.report?.("clipping");
    let file = original,
      videoFile = downloaded.videoFile;
    if (split) {
      videoFile = await clipOnPc(
        store,
        job,
        payload,
        videoFile,
        workspace,
        true,
      );
      if (payload.clip) {
        file = path.join(path.dirname(videoFile), "clip-audio.m4a");
        await encodeResource(
          [
            "-i",
            original,
            "-ss",
            String(payload.clip.start),
            "-t",
            String(payload.clip.end - payload.clip.start),
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
          ],
          file,
        );
      }
    } else file = await clipOnPc(store, job, payload, original, workspace);
    const info = await stat(file);
    const cleanupSources = await Promise.all(
      [
        ...new Set(
          [file, original, downloaded.videoFile, videoFile].filter(Boolean),
        ),
      ].map(async (source) => {
        const value = await stat(source);
        return { file: source, signature: value.size + ":" + value.mtimeMs };
      }),
    );
    checkTaskCancellation();
    addJob("import", {
      cleanupSources,
      file,
      videoFile,
      downloadedHeight: downloaded.height,
      signature: info.size + ":" + info.mtimeMs,
      title: payload.title,
      artist: payload.artist,
      approved: payload.onlineSelection === true,
      metadata: payload.onlineSelection
        ? {
            title: payload.title,
            artist: payload.artist,
            needs_review: payload.artist ? 0 : 1,
            evidence: [
              {
                kind: "user-selection",
                url: payload.url,
                clip: payload.clip || null,
              },
            ],
          }
        : undefined,
      clip: payload.clip,
      originalFile: original,
      candidate: payload.candidate,
      sourceUrl: payload.url,
      enqueue: payload.enqueue,
      name: payload.name,
      isBacking: payload.isBacking,
    });
  }
}
