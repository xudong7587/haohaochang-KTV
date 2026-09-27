import path from "node:path";
import { statSync } from "node:fs";

export const resourceNames = {
  video: "画面.mp4",
  vocal: "原唱.m4a",
  backing: "伴奏.m4a",
  lyrics: "歌词.lrc",
};
const present = (file) => {
  try {
    return statSync(file).isFile() && statSync(file).size > 0;
  } catch {
    return false;
  }
};
export function resourceManifest(store, song, cache) {
  const v2 = !!store.get("package-ready:" + song.id),
    dir = store.get("package:" + song.id);
  const revision = song.resourceRevision || 0;
  const videoSource = store.get("video-source:" + song.id, {}) || {},
    health = store.get("package-health:" + song.id, {});
  const resources = Object.fromEntries(
    Object.entries(resourceNames).map(([kind, name]) => {
      const file =
        v2 && dir
          ? path.join(dir, name)
          : path.join(
              cache,
              `${song.id}-${kind === "video" ? "vocal" : kind}.mp4`,
            );
      let verified = false;
      if (v2 && health[kind]?.available && health[kind].file === file) {
        try {
          const info = statSync(file);
          verified =
            health[kind].size === info.size &&
            health[kind].mtimeMs === info.mtimeMs;
        } catch {}
      }
      const available = v2
        ? verified
        : kind === "lyrics"
          ? !!song.lyrics?.trim()
          : present(file);
      return [
        kind,
        {
          available,
          reason: available
            ? undefined
            : health[kind]?.reason || "文件缺失、已改变或尚未校验",
          url: v2
            ? `/api/assets/${song.id}/${kind}?r=${revision}`
            : `/api/media/${song.id}/${kind === "video" ? "vocal" : kind}`,
          duration: health[kind]?.duration || song.duration || 0,
          ...(kind === "video"
            ? {
                width: health.video?.width,
                height: health.video?.height,
                codec: health.video?.codec,
                fps: health.video?.fps,
                pixelFormat: health.video?.pixelFormat,
              }
            : {}),
          offset: kind === "video" ? Number(videoSource.offset) || 0 : 0,
        },
      ];
    }),
  );
  const missing = Object.keys(resources).filter((k) => !resources[k].available);
  const playable =
    song.status === "ready" &&
    (resources.vocal.available || resources.backing.available);
  const identity =
    !song.needs_review &&
    song.title &&
    song.artist &&
    song.artist !== "未知歌手";
  const complete =
    playable &&
    identity &&
    ["separated", "tracks", "channels"].includes(song.mode) &&
    resources.vocal.available &&
    resources.backing.available;
  return {
    version: v2 ? 2 : 1,
    revision,
    resources,
    missing,
    playable,
    video: resources.video.available,
    vocal: resources.vocal.available,
    backing: resources.backing.available,
    lyrics: resources.lyrics.available,
    tier: complete
      ? resources.video.available
        ? "standard"
        : "audio"
      : "pending",
    background: store.get("background", {}),
  };
}
export function canEnqueue(store, song, cache) {
  return (
    !!song &&
    !store.get("deletion:" + song.id) &&
    !store.get("hidden:" + song.id) &&
    resourceManifest(store, song, cache).playable
  );
}
