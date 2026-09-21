import {
  registerFavoriteBundle,
  finishFavoritePart,
} from "../favorite-bundles.js";
import { prepareTaskDirectory } from "../task-files.js";
import { checkTaskCancellation, taskFetch } from "../task-cancellation.js";
import { favoriteParts, favoriteNfo } from "../favorites.js";
import { moveLocalFile } from "../local-intake.js";
import path from "node:path";
import { stat, writeFile, mkdir } from "node:fs/promises";
import { downloadBiliTracks } from "../bili-download.js";
import { encodeResource } from "../song-package.js";
import { taskProgress } from "../task-progress.js";
const component = (text) =>
  String(text || "视频")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 70) || "视频";
// 收藏夹下载和在线找歌走同一套 B站 API 取流（不经过网页解析），再把独立画面与
// 原唱合成一个可直接播放的文件交给后面的整理流程。
async function muxRecording({ file: audio, videoFile }, target) {
  const tracks = [
    "-i",
    videoFile,
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
  ];
  try {
    await encodeResource([...tracks, "-c", "copy"], target);
  } catch {
    await encodeResource(
      [
        ...tracks,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
      ],
      target,
    );
  }
}
export async function favorite_download(job, payload, context) {
  const { store, get, downloads, addJob, db } = context;
  const config = get("favorites", {});
  const parts = await favoriteParts(
    payload,
    config,
    context.favoriteFetch || taskFetch,
  );
  const part = payload.cid
    ? parts.find((p) => p.cid === String(payload.cid))
    : parts.find((p) => p.page === 1);
  if (!part) throw new Error("原分 P 已移除，已停止下载，避免取得其他歌曲");
  if (!payload.bundleId) {
    const group = await registerFavoriteBundle(parts, {
      ...context,
      currentDownload: job.id,
    });
    part.bundleId = group.id;
  }
  checkTaskCancellation();
  db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
    JSON.stringify({ ...payload, ...part }),
    job.id,
  );
  context.report?.("downloading");
  const workspace = await prepareTaskDirectory(downloads, job.id);
  const tracks = await (context.favoriteTracks || downloadBiliTracks)(
    part.url,
    path.join(workspace, "dash"),
    config.cookie,
    "highest",
    0,
    {
      progress: (label, percent) =>
        taskProgress(store, job.id, { label, percent }),
    },
  );
  checkTaskCancellation();
  const file = path.join(workspace, "favorite.mp4");
  await (context.favoriteMux || muxRecording)(tracks, file);
  taskProgress(store, job.id, null);
  checkTaskCancellation();
  const info = await stat(file);
  const folder = path.join(
    workspace,
    component(part.collectionTitle),
    "Season 1",
  );
  await mkdir(folder, { recursive: true });
  const stem =
    component(part.title) + ` - S01E${String(part.page).padStart(2, "0")}`;
  const target = path.join(folder, stem + path.extname(file));
  await writeFile(path.join(folder, stem + ".nfo"), favoriteNfo(part), "utf8");
  await moveLocalFile(
    file,
    target,
    [downloads],
    info.size + ":" + info.mtimeMs,
  );
  checkTaskCancellation();
  const fresh = JSON.parse(
    db.prepare("SELECT payload FROM jobs WHERE id=?").get(job.id).payload,
  );
  await finishFavoritePart(
    { ...part, bundleId: fresh.bundleId || part.bundleId },
    target,
    context,
  );
}
