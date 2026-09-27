import { taskProgress, runWithProgress } from "./task-progress.js";
import path from "node:path";
import { mkdir, stat, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { run } from "./process.js";
import { stageResources, requireFiles } from "./resource-publication.js";
import { withSongWrite, publicationKey, jobScope } from "./song-writes.js";
import { inspectPackage, requireHealthyPackage } from "./resource-health.js";
import { probe } from "./media-utils.js";
import { resourceNames } from "./resource-manifest.js";
import { prepareVideoOnPc } from "./video-preparation.js";
export const packageFolder = "歌曲";
export async function packageDir(store, song, cache) {
  let dir = store.get("package:" + song.id);
  if (!dir) {
    dir = path.join(cache, packageFolder, song.id);
    store.set("package:" + song.id, dir);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}
export async function present(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}
// Legacy metadata helper; HTTP classification uses resourceManifest.
export function libraryTier(song) {
  if (
    song.needs_review ||
    !song.title ||
    !song.artist ||
    song.artist === "未知歌手" ||
    song.status !== "ready" ||
    !["separated", "tracks", "channels"].includes(song.mode)
  )
    return "pending";
  return song.needs_video ? "audio" : "standard";
}
export async function savePackageInfo(store, song, cache) {
  const dir = await packageDir(store, song, cache);
  await writeFile(path.join(dir, "歌词.lrc"), song.lyrics || "");
  await inspectPackage(store, song, dir);
  await writeFile(
    path.join(dir, "歌曲信息.json"),
    JSON.stringify(
      {
        version: 2,
        id: song.id,
        title: song.title,
        artist: song.artist,
        metadataRevision: song.metadataRevision,
        resourceRevision: song.resourceRevision,
        tier: libraryTier(song),
        duration: song.duration,
        audioSource: song.path,
        videoSource: store.get("video-source:" + song.id),
        downloadedVideo: store.get("download-quality:" + song.id),
        recordingSource: store.get("recording-source:" + song.id),
        splitVideoSource: store.get("split-video:" + song.id),
        lyricsSource: store.get("lyrics-match:" + song.id),
        poster: song.poster
          ? {
              ...store.get("poster-source:" + song.id, {}),
              file: path.relative(dir, song.poster),
            }
          : null,
        files: {
          video: "画面.mp4",
          original: "原唱.m4a",
          accompaniment: "伴奏.m4a",
          lyrics: "歌词.lrc",
        },
      },
      null,
      2,
    ),
  );
}
export async function encodeResource(
  args,
  out,
  progress,
  verification = "decode",
) {
  const temporary = out + "." + randomUUID() + ".tmp";
  const execute = async (args, phase) => {
    if (!progress) return run(process.env.FFMPEG || "ffmpeg", args, 3600000);
    await runWithProgress(args, progress.duration, (percent) =>
      progress.report({ phase, percent }),
    );
  };
  try {
    await execute(
      [
        "-y",
        "-v",
        "error",
        ...args,
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        temporary,
      ],
      "转换",
    );
    await execute(
      [
        "-v",
        "error",
        "-xerror",
        "-err_detect",
        "explode",
        "-i",
        temporary,
        "-map",
        "0",
        ...(verification === "packets" ? ["-c", "copy"] : []),
        "-f",
        "null",
        "-",
      ],
      "校验",
    );
    await rename(temporary, out);
    const media = await probe(out),
      info = await stat(out);
    return { media, info };
  } finally {
    await rm(temporary, { force: true });
  }
}
function reportResourceStage(store, stage) {
  const job = jobScope();
  if (job)
    store.db
      .prepare("UPDATE jobs SET stage=? WHERE id=? AND status='running'")
      .run(stage, job);
}
export async function encodePackageResource(
  store,
  song,
  kind,
  args,
  directory,
  verification,
) {
  reportResourceStage(
    store,
    kind === "video" ? "preparing-video" : "preparing-audio",
  );
  const file = path.join(directory, resourceNames[kind]);
  const job = jobScope();
  const input = args[args.indexOf("-i") + 1];
  const inputInfo = input ? await probe(input) : null;
  const duration = job && inputInfo ? inputInfo.duration : 0;
  const passthrough =
    kind === "video" && args[args.indexOf("-c:v") + 1] === "copy";
  verification ||= passthrough ? "packets" : "decode";
  let result;
  try {
    result = await encodeResource(
      args,
      file,
      job
        ? {
            duration,
            report: (value) =>
              taskProgress(store, job, {
                ...value,
                label: `${kind === "video" ? "画面" : kind === "vocal" ? "原唱" : "伴奏"}${value.phase}`,
              }),
          }
        : null,
      verification,
    );
  } finally {
    if (job) taskProgress(store, job, null);
  }
  const { media, info } = result;
  if (
    passthrough &&
    Math.abs(media.duration - (inputInfo.videoDuration || inputInfo.duration)) >
      0.5
  )
    throw new Error("原画面封装后时长不一致，源文件已保留");
  if (
    !(media.duration > 0) ||
    (kind === "video"
      ? !media.hasVideo || media.audio.length
      : media.hasVideo || media.audio.length !== 1)
  )
    throw new Error("生成资源的音视频轨道或时长无效");
  // Passthrough traverses every packet without decoding; newly encoded media
  // is fully decoded. Cache the evidence for this exact immutable file.
  store.set("package-health:" + song.id, {
    ...store.get("package-health:" + song.id, {}),
    [kind]: {
      file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      available: true,
      duration: media.duration,
      ...(kind === "video"
        ? {
            width: media.width,
            height: media.height,
            codec: media.videoCodec,
            fps: media.videoFps,
            pixelFormat: media.pixelFormat,
            verification,
          }
        : {}),
    },
  });
}
export async function encodePicture(
  store,
  song,
  source,
  directory,
  { info, force = false } = {},
) {
  info ||= await probe(source);
  let codec = !force
    ? ["-c:v", "copy"]
    : [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-vf",
        "scale=w='trunc(iw/2)*2':h=-2",
        "-pix_fmt",
        "yuv420p",
      ];
  let prepared;
  try {
    if (codec.includes("libx264")) {
      reportResourceStage(store, "preparing-video-pc");
      prepared = await prepareVideoOnPc(store, song, source, directory);
      if (prepared) codec = ["-c:v", "copy"];
      else if (["smpte2084", "arib-std-b67"].includes(info.colorTransfer))
        throw new Error(
          "HDR 兼容转换需要连接新版 PC 整理器；原始 HDR 画面保持可用",
        );
    }
    if (prepared?.validated) {
      // The PC decoded this exact SHA-256 and NAS verified it while streaming.
      // Move the already-faststart file in this unpublished directory; do not
      // decode a full 4K video a second time on the NAS CPU.
      const target = path.join(directory, resourceNames.video);
      await rename(prepared.file, target);
      const [media, value] = await Promise.all([probe(target), stat(target)]);
      store.set("package-health:" + song.id, {
        ...store.get("package-health:" + song.id, {}),
        video: {
          file: target,
          size: value.size,
          mtimeMs: value.mtimeMs,
          available: true,
          duration: media.duration,
          width: media.width,
          height: media.height,
          codec: media.videoCodec,
          fps: media.videoFps,
          pixelFormat: media.pixelFormat,
          verification: "decode-pc",
        },
      });
      store.set(prepared.checkpointKey, null);
      await prepared.acknowledge?.();
      return;
    }
    await encodePackageResource(
      store,
      song,
      "video",
      [
        "-i",
        prepared?.file || source,
        "-map",
        "0:v:0",
        "-an",
        ...codec,
        ...(!force && info.videoCodec === "hevc" ? ["-tag:v", "hvc1"] : []),
      ],
      directory,
      prepared ? "decode" : undefined,
    );
    if (prepared) store.set(prepared.checkpointKey, null);
  } finally {
    if (prepared) await rm(prepared.file, { force: true });
  }
}
// Internal encoder: its store must point at an unpublished directory.
export async function encodePackage(store, song, info, cache) {
  const dir = await packageDir(store, song, cache),
    sourceStat = await stat(song.path);
  const signature = JSON.stringify([
    sourceStat.mtimeMs,
    sourceStat.size,
    song.mode,
    song.backing,
    song.vocal,
  ]);
  const priorSignature = store.get("package-fingerprint:" + song.id);
  const same = priorSignature === signature;
  if (
    song.mode === "separated" &&
    priorSignature &&
    JSON.stringify(JSON.parse(priorSignature).slice(0, 2)) !==
      JSON.stringify([sourceStat.mtimeMs, sourceStat.size])
  )
    throw new Error(
      "原始音频已改变，旧双音轨保持可用；请明确选择新音源并重新分离",
    );
  const health = await inspectPackage(store, song, dir);
  for (const variant of song.mode === "instrumental"
    ? ["backing"]
    : ["original", "separated"].includes(song.mode)
      ? ["vocal"]
      : ["vocal", "backing"]) {
    if ((same || song.mode === "separated") && health[variant]?.available)
      continue;
    const args = [
      "-i",
      song.path,
      "-vn",
      "-map",
      "0:a:" + (song.mode === "tracks" ? song[variant] : 0),
    ];
    if (song.mode === "channels")
      args.push(
        "-af",
        "pan=stereo|c0=c" + song[variant] + "|c1=c" + song[variant],
      );
    await encodePackageResource(
      store,
      song,
      variant,
      [...args, "-c:a", "aac", "-b:a", "192k", "-ac", "2"],
      dir,
    );
  }
  if (!same && song.mode === "original")
    await rm(path.join(dir, "伴奏.m4a"), { force: true });
  if (!same && song.mode === "instrumental")
    await rm(path.join(dir, "原唱.m4a"), { force: true });
  if (
    info.hasVideo &&
    !store.get("video-source:" + song.id)?.keepAudio &&
    (!same || !health.video?.available)
  ) {
    const splitVideo = store.get("split-video:" + song.id);
    await encodePicture(
      store,
      song,
      splitVideo || song.path,
      dir,
      splitVideo ? {} : { info },
    );
  }
  if (!info.hasVideo && !store.get("video-source:" + song.id)?.keepAudio)
    await rm(path.join(dir, "画面.mp4"), { force: true });
  if (song.mode === "separated" && !health.backing?.available) {
    const old = path.join(cache, "stems", song.id, "backing.wav");
    const legacy = (await present(old))
      ? old
      : path.join(cache, song.id + "-backing.mp4");
    if (await present(legacy))
      await encodePackageResource(
        store,
        song,
        "backing",
        ["-i", legacy, "-vn", "-c:a", "aac", "-b:a", "192k"],
        dir,
      );
    else await rm(path.join(dir, "伴奏.m4a"), { force: true });
  }
  await requireHealthyPackage(
    store,
    song,
    dir,
    song.mode === "instrumental"
      ? ["backing"]
      : ["original", "separated"].includes(song.mode)
        ? ["vocal"]
        : ["vocal", "backing"],
  );
  store.set("package-fingerprint:" + song.id, signature);
  store.set("package-ready:" + song.id, true);
}
export async function preparePackage(store, song, info, cache) {
  return withSongWrite(
    store,
    song.id,
    async (latest) => {
      const key = publicationKey(song.id, "prepare");
      if (key && store.get(key)) return latest;
      const stage = await stageResources(store, latest, cache, {
        phase: "prepare",
      });
      try {
        await encodePackage(
          stage.store,
          { ...latest, path: song.path },
          info,
          cache,
        );
        const patch = {
          duration: info.duration,
          audio: JSON.stringify(info.audio),
          needs_video: info.hasVideo ? 0 : 1,
          status: "ready",
          error: "",
        };
        await savePackageInfo(
          stage.store,
          {
            ...latest,
            ...patch,
            resourceRevision: latest.resourceRevision + 1,
          },
          cache,
        );
        return stage.publish(patch);
      } catch (e) {
        await stage.abandon();
        throw e;
      }
    },
    { wait: true },
  );
}
export async function repairPicture(store, song, cache) {
  return withSongWrite(
    store,
    song.id,
    async (latest) => {
      const stage = await stageResources(store, latest, cache);
      try {
        await encodePicture(stage.store, latest, latest.path, stage.directory, {
          force: true,
        });
        await savePackageInfo(
          stage.store,
          { ...latest, resourceRevision: latest.resourceRevision + 1 },
          cache,
        );
        stage.publish({ needs_video: 0 });
      } catch (e) {
        await stage.abandon();
        throw e;
      }
    },
    { wait: true },
  );
}
export async function publishBacking(store, song, cache, wav) {
  return withSongWrite(
    store,
    song.id,
    async (latest) => {
      const key = publicationKey(song.id, "backing");
      if (key && store.get(key)) return latest;
      const stage = await stageResources(store, latest, cache, {
        phase: "backing",
      });
      try {
        await encodePackageResource(
          stage.store,
          latest,
          "backing",
          ["-i", wav, "-vn", "-c:a", "aac", "-b:a", "192k"],
          stage.directory,
        );
        await requireHealthyPackage(stage.store, latest, stage.directory, [
          "vocal",
          "backing",
        ]);
        await savePackageInfo(
          stage.store,
          {
            ...latest,
            mode: "separated",
            status: "ready",
            metadataRevision:
              latest.metadataRevision + (latest.mode === "separated" ? 0 : 1),
            resourceRevision: latest.resourceRevision + 1,
          },
          cache,
        );
        stage.publish({ mode: "separated", status: "ready", error: "" });
      } catch (e) {
        await stage.abandon();
        throw e;
      }
    },
    { wait: true },
  );
}
