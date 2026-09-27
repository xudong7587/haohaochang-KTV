import path from "node:path";
import { mkdir, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { probe } from "./media-utils.js";
import { encodeResource } from "./song-package.js";
import { checkTaskCancellation } from "./task-cancellation.js";
import { checkProvider, runProviderJob } from "./separation/protocol.js";
import { taskProgress } from "./task-progress.js";

export const waitingWorker = (message = "等待局域网 PC 整理器上线") =>
  Object.assign(new Error(message), { code: "WAITING_WORKER" });
export function clipRange(input, duration) {
  if (!input) return null;
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    ["start", "end"].some(
      (key) => input[key] != null && typeof input[key] !== "number",
    )
  )
    throw new Error("裁剪时间必须为秒数");
  const start = input.start == null ? 0 : Number(input.start),
    end = input.end == null ? duration : Number(input.end);
  if (
    ![start, end, duration].every(Number.isFinite) ||
    start < 0 ||
    end <= start ||
    end > duration + 0.1 ||
    duration > 21600
  )
    throw new Error("裁剪区间无效，请检查开始与结束时间");
  return { start, end: Math.min(end, duration) };
}
// Keep the existing entry point: PC remains an optimization, while NAS CPU is
// always available for clipping. NPU selection applies to audio separation.
export async function clipOnPc(
  store,
  job,
  payload,
  file,
  downloads,
  videoOnly = false,
) {
  checkTaskCancellation();
  if (!payload.clip) return file;
  if (!/^[a-zA-Z0-9_-]+$/.test(job.id)) throw new Error("Invalid clip job");
  const source = await probe(file);
  const clip = clipRange(payload.clip, source.duration);
  if (!source.hasVideo || (!videoOnly && !source.audio.length))
    throw new Error("裁剪来源缺少所需音视频轨道");
  const duration =
    (videoOnly
      ? Math.min(clip.end, source.videoDuration || source.duration)
      : clip.end) - clip.start;
  if (duration <= 0) throw new Error("裁剪区间超出画面时长");
  const signature = await stat(file);
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        path.resolve(file),
        signature.size,
        signature.mtimeMs,
        clip,
        videoOnly,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const staging = path.join(downloads, ".ktv-online", "clips", job.id, key);
  await mkdir(staging, { recursive: true });
  const target = path.join(staging, "complete.mp4");
  const valid = (info) =>
    info.hasVideo &&
    (videoOnly
      ? !info.audio.length
      : info.audio.length === source.audio.length) &&
    (!source.height || info.height >= source.height) &&
    (!source.videoFps || info.videoFps + 0.1 >= source.videoFps) &&
    Math.abs(info.duration - duration) < 0.5;
  try {
    if (valid(await probe(target))) return target;
  } catch {
    checkTaskCancellation();
  }
  const ai = store.get("ai", {});
  if (ai.pcEndpoint) {
    const config = {
      endpoint: ai.pcEndpoint,
      apiKey: ai.pcApiKey,
      model: `${videoOnly ? "video" : "clip"}:${clip.start}:${clip.end}`,
    };
    let result;
    try {
      const health = await checkProvider(config, 3000);
      const hdr = ["smpte2084", "arib-std-b67"].includes(source.colorTransfer);
      if (
        health.capabilities?.includes("video-clip-v1") &&
        (!hdr || health.capabilities?.includes("video-prepare-v2"))
      ) {
        result = await runProviderJob(
          store,
          { id: job.id, title: payload.title, artist: payload.artist },
          file,
          staging,
          config,
          {
            clip,
            videoOnly,
            videoInfo: source,
            maxVideoBytes: health.max_video_upload_bytes,
          },
        );
        if (!valid(await probe(result.file)))
          throw new Error("PC 裁剪结果不匹配");
        // Only publish a fully decoded, atomic copy. Partial downloads cannot be reused.
        await encodeResource(
          ["-i", result.file, "-map", "0", "-c", "copy"],
          target,
          null,
          result.validated ? "packets" : "decode",
        );
        store.set(result.checkpointKey, null);
        await result.acknowledge();
        return target;
      }
    } catch {
      checkTaskCancellation();
      if (result) store.set(result.checkpointKey, null);
      // Offline, busy, old or failed PC: finish this operation locally.
    }
  }
  checkTaskCancellation();
  const hdr = ["smpte2084", "arib-std-b67"].includes(source.colorTransfer);
  const filters = hdr
    ? [
        "-vf",
        `zscale=pin=bt2020:tin=${source.colorTransfer}:min=bt2020nc:t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p`,
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
      ]
    : [];
  try {
    await encodeResource(
      [
        "-ss",
        String(clip.start),
        "-i",
        file,
        "-t",
        String(duration),
        "-map",
        "0:v:0",
        ...(videoOnly
          ? ["-an"]
          : ["-map", "0:a", "-c:a", "aac", "-b:a", "192k"]),
        ...filters,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
      ],
      target,
      {
        duration,
        report: (value) =>
          taskProgress(store, job.id, { ...value, label: "裁剪视频" }),
      },
    );
    if (!valid(await probe(target)))
      throw new Error("NAS 裁剪结果时长或音视频轨道不匹配");
    checkTaskCancellation();
    return target;
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  } finally {
    taskProgress(store, job.id, null);
  }
}
