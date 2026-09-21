import { taskStatus } from "../task-status.js";
import { ensureBiliCredentials } from "../bili-credentials.js";
import {
  videoQuality,
  previewDownloadHeight,
} from "../../shared/video-quality.js";
import { canonicalVideo, onlineSearch } from "../media.js";
import { resourceManifest } from "../resource-manifest.js";

import { fail, clean } from "../http-utils.js";
import { searchSongs } from "../online-search.js";
import { onlineCoverApi } from "../online-cover.js";
import { jobRoomTargets } from "../room-targets.js";
import { previewSessions } from "../online-preview.js";
import { clipRange } from "../clipping.js";
import { biliLoginStatus } from "../bili-login.js";
import { requireDownloadHeight } from "../bili-download.js";
import { assertSongIdle, currentSong, checkRevision } from "../song-writes.js";
import { recordingSource } from "../recording-source.js";
import {
  videoRefreshMode,
  canonicalBiliRecording,
} from "../../shared/video-refresh.js";

export function onlineApi({
  app,
  admin,
  member,
  store,
  db,
  get,
  set,
  cache,
  legacyCache,
  dir,
  roots,
  downloads,
  addJob,
  work,
  emit,
  snapshot,
  isPlaying,
  allowedOrigin,
}) {
  const previews = previewSessions();
  onlineCoverApi({ app, member });
  app.post("/api/admin/library/:id/refresh-video", admin, (req, res) => {
    const song = currentSong(store, req.params.id);
    assertSongIdle(store, song.id);
    checkRevision(song, req.body.expectedRevision);
    if (
      isPlaying?.(song.id) ||
      snapshot?.().ambient?.song_id === song.id ||
      db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id)
    )
      throw fail(409, "请先将歌曲移出播放队列，再更新视频");
    const url = canonicalBiliRecording(req.body.url),
      quality = videoQuality(req.body.quality);
    let clip = null,
      expectedHeight = 0;
    if (req.body.previewId) {
      const selected = previews.lookup(req.body.previewId);
      if (canonicalBiliRecording(selected.url) !== url)
        throw fail(400, "预览不属于当前视频");
      expectedHeight = previewDownloadHeight(selected, quality);
      if (req.body.clip) clip = clipRange(req.body.clip, selected.duration);
    } else if (req.body.clip) throw fail(400, "请先预览视频，再标记裁剪区间");
    const plan = videoRefreshMode(recordingSource(store, song), url, clip);
    const available = resourceManifest(store, song, cache);
    if (!available.vocal || !available.backing)
      Object.assign(plan, {
        mode: "recording",
        reason: "双音轨尚未齐全，将重新生成原唱并分离伴奏。",
      });
    if (plan.mode === "recording" && !get("ai", {}).enabled)
      throw fail(400, "本次更新需要重新分离伴奏，请先启用 PC 整理与伴奏分离");
    res.json({
      ...plan,
      id: addJob("refresh-video", {
        id: song.id,
        url,
        clip,
        quality,
        expectedHeight,
        expectedRevision: song.metadataRevision,
        priority: "online",
      }),
    });
  });
  app.get("/api/requests/status", member, (req, res) => {
    const rows = db
      .prepare(
        "SELECT id,kind,status,stage,payload,created FROM jobs WHERE status IN ('running','queued','waiting-worker') AND json_extract(payload,'$.priority') IN ('mobile','online') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting-worker' THEN 1 ELSE 2 END, created",
      )
      .all();
    const progress = new Map(taskStatus(store).map((row) => [row.id, row]));
    res.set("Cache-Control", "no-store").json(
      rows
        .filter((row) => {
          const payload = JSON.parse(row.payload);
          return (
            jobRoomTargets(store, payload).some(
              (target) => target.roomId === req.roomId,
            ) ||
            (!payload.enqueue && (payload.roomId || "legacy") === req.roomId)
          );
        })
        .slice(0, 1)
        .map((row) => {
          const p = JSON.parse(row.payload),
            detail = progress.get(row.id);
          const rawPercent =
            detail?.media_progress?.percent ?? detail?.model_progress;
          return {
            percent: Number.isFinite(rawPercent)
              ? Math.max(0, Math.min(100, rawPercent))
              : null,
            progressLabel: clean(detail?.media_progress?.label, 60),
            id: row.id,
            requestId: p.requestId || row.id,
            title: clean(detail?.title || p.title || p.metadata?.title),
            artist: clean(detail?.artist || p.artist || p.metadata?.artist),
            status: row.status,
            stage: detail?.stage || row.stage || row.kind,
            created: row.created,
            message:
              row.status === "review"
                ? "需要管理员核对歌曲或补充歌词"
                : row.status === "failed"
                  ? "暂未完成，请稍后重试或联系管理员"
                  : row.status === "waiting-worker"
                    ? "等待 PC 整理器连接"
                    : "",
          };
        }),
    );
  });
  let loginCache;
  app.get("/api/online/bilibili/status", member, async (req, res) => {
    const cookie = await ensureBiliCredentials(store);
    if (
      !loginCache ||
      loginCache.cookie !== cookie ||
      loginCache.expires < Date.now()
    )
      loginCache = {
        cookie,
        expires: Date.now() + 60000,
        value: await biliLoginStatus(cookie),
      };
    res.json({
      loggedIn: loginCache.value.loggedIn,
      vip: loginCache.value.vip,
    });
  });
  app.get("/api/online/songs", member, async (req, res) => {
    if (!get("onlineEnabled", true))
      throw fail(
        403,
        "在线搜索已手动关闭，请到“设置与任务 → 在线资源”重新启用。",
      );
    const title = clean(req.query.title),
      artist = clean(req.query.artist),
      page = Number(req.query.page || 1);
    if (!title || !Number.isInteger(page) || page < 1 || page > 20)
      throw fail(400, "请填写歌名和有效页码");
    res.json(
      await searchSongs(
        title,
        artist,
        await ensureBiliCredentials(store),
        page,
      ),
    );
  });
  app.post("/api/online/preview", member, async (req, res) => {
    if (!get("onlineEnabled", true))
      throw fail(
        403,
        "在线搜索已手动关闭，请到“设置与任务 → 在线资源”重新启用。",
      );
    res.json(
      await previews.create(
        canonicalVideo(req.body.url),
        await ensureBiliCredentials(store),
        dir,
        {
          refresh: req.body.refresh === true,
          quality: "highest",
        },
      ),
    );
  });
  app.get("/api/online/preview/:id/:track", member, async (req, res) => {
    if (!get("onlineEnabled", true)) throw fail(403, "在线资源已关闭");
    await previews.stream(req, res);
  });
  app.post("/api/requests", member, (req, res) => {
    if (!get("onlineEnabled", true))
      throw fail(
        403,
        "在线搜索已手动关闭，请到“设置与任务 → 在线资源”重新启用。",
      );
    throw fail(410, "请在在线找歌中选择视频后点歌。");
  });
  app.get("/api/online", member, async (req, res) => {
    if (!get("onlineEnabled", true))
      throw fail(
        403,
        "在线搜索已手动关闭，请到“设置与任务 → 在线资源”重新启用。",
      );
    const query = clean(req.query.q);
    if (query.length < 2) throw fail(400, "至少输入两个字");
    res.json(
      await onlineSearch(
        /伴奏|karaoke|instrumental/i.test(query) ? query : `${query} 伴奏 KTV`,
        req.query.provider === "bilibili" ? "bilibili" : "youtube",
      ),
    );
  });
  app.post("/api/online", member, async (req, res) => {
    if (!get("onlineEnabled", true))
      throw fail(
        403,
        "在线搜索已手动关闭，请到“设置与任务 → 在线资源”重新启用。",
      );
    if (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','waiting-worker') AND (kind IN ('acquire','download') OR json_extract(payload,'$.priority') IN ('online','mobile'))",
        )
        .get().n >= 200
    )
      throw fail(429, "在线任务已达到 200 项，请等待部分任务完成");
    const payload = {
      roomId: req.roomId,
      url: canonicalVideo(req.body.url),
      quality: videoQuality(req.body.quality),
      title: clean(req.body.title) || "在线歌曲",
      artist: clean(req.body.artist) || "未知歌手",
      enqueue: !!req.body.enqueue,
      name: clean(req.body.name, 24) || "家人",
      isBacking: req.body.isBacking === true,
      priority: req.body.client === "mobile" ? "mobile" : "online",
    };
    if (req.body.onlineSelection === true) {
      if (!clean(req.body.title) || !clean(req.body.artist))
        throw fail(400, "请填写歌名和歌手");
      if (get("ai", {}).enabled === false)
        throw fail(400, "请先启用 PC 整理与伴奏分离");
      payload.onlineSelection = true;
      payload.isBacking = false;
      payload.enqueue = payload.priority === "mobile";
      if (req.body.previewId) {
        const selected = previews.lookup(req.body.previewId);
        if (selected.url !== payload.url)
          throw fail(400, "预览不属于当前视频，请重新预览");
        payload.expectedHeight = previewDownloadHeight(
          selected,
          payload.quality,
        );
        if (payload.expectedHeight)
          requireDownloadHeight(payload.expectedHeight, payload.quality);
      }
      if (req.body.clip) {
        const preview = previews.lookup(req.body.previewId);
        if (preview.url !== payload.url)
          throw fail(400, "标记区间不属于当前视频");
        payload.clip = clipRange(req.body.clip, preview.duration);
      }
    }
    res.json({ id: addJob("download", payload) });
  });
}
