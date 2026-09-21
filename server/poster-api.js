import {
  currentSong,
  checkRevision,
  assertSongIdle,
  withSongWrite,
} from "./song-writes.js";
import { posterName, scrapePoster } from "./song-poster.js";
import { bilibiliProvider } from "./providers/bilibili.js";
import { biliCookie } from "./bili-credentials.js";
import {
  allowedPosterUrl,
  downloadPoster,
  validatePosterBytes,
} from "./poster-source.js";
import { randomUUID } from "node:crypto";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
export function posterApi({
  app,
  admin,
  store,
  cache,
  addJob,
  emit,
  posterOptions = {},
}) {
  const candidates = new Map();
  const download = posterOptions.download || downloadPoster;
  function candidate(id) {
    const value = candidates.get(id);
    if (!value || value.expires < Date.now())
      throw Object.assign(new Error("封面候选已过期，请重新搜索"), {
        status: 404,
      });
    return value;
  }
  app.get("/api/admin/poster-search", admin, async (req, res) => {
    const query = String(req.query.q || "")
      .trim()
      .slice(0, 160);
    if (!query) throw new Error("请输入歌名、歌手或封面关键词");
    const page = Math.max(1, Math.min(10, Number(req.query.page) || 1));
    const rows = await (posterOptions.search || bilibiliProvider.search)(
      query,
      biliCookie(store),
      undefined,
      page,
    );
    const results = [];
    for (const row of rows.slice(0, 20)) {
      try {
        const imageUrl = allowedPosterUrl(
          String(row.cover).replace(/^http:/, "https:"),
        ).href;
        const sourceUrl = new URL(row.url);
        if (
          sourceUrl.protocol !== "https:" ||
          sourceUrl.hostname !== "www.bilibili.com" ||
          !/^\/video\/(BV[\w]+|av\d+)\/?$/.test(sourceUrl.pathname)
        )
          continue;
        const id = randomUUID();
        const item = {
          id,
          title: String(row.title || "").slice(0, 240),
          uploader: String(row.uploader || row.artist || "").slice(0, 120),
          duration: Number(row.duration) || 0,
          source: "手动选择的 B站封面",
          provider: "bilibili",
          sourceUrl: sourceUrl.href,
          imageUrl,
          expires: Date.now() + 15 * 60000,
        };
        candidates.set(id, item);
        results.push({
          id,
          title: item.title,
          uploader: item.uploader,
          duration: item.duration,
          sourceUrl: item.sourceUrl,
        });
      } catch {}
    }
    for (const [id, item] of candidates)
      if (item.expires < Date.now()) candidates.delete(id);
    while (candidates.size > 400)
      candidates.delete(candidates.keys().next().value);
    res
      .set("Cache-Control", "no-store")
      .json({ results, page, hasMore: rows.length >= 20 && page < 10 });
  });
  app.get("/api/admin/poster-candidates/:id/image", admin, async (req, res) => {
    const bytes = validatePosterBytes(
      await download(candidate(req.params.id).imageUrl),
    );
    const type =
      bytes[0] === 0xff
        ? "image/jpeg"
        : bytes[0] === 137
          ? "image/png"
          : "image/webp";
    res.set("Cache-Control", "private, max-age=300").type(type).send(bytes);
  });
  async function saveChosen(req, source, bytes) {
    return withSongWrite(
      store,
      req.params.id,
      async () => {
        const result = await scrapePoster(store, req.params.id, cache, {
          force: true,
          find: async () => source,
          findArtist: async () => null,
          download: async () =>
            validatePosterBytes(bytes || (await download(source.imageUrl))),
        });
        emit("library", {});
        return result;
      },
      {
        expectedRevision: Number(
          req.query.expectedRevision ?? req.body.expectedRevision,
        ),
        required: true,
        idle: true,
      },
    );
  }
  app.post("/api/admin/library/:id/poster/select", admin, async (req, res) => {
    const { expires, id, ...source } = candidate(req.body.candidateId);
    res.json(await saveChosen(req, source));
  });
  app.post(
    "/api/admin/library/:id/poster/upload",
    admin,
    express.raw({
      type: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/octet-stream",
      ],
      limit: "8mb",
    }),
    async (req, res) => {
      const bytes = validatePosterBytes(req.body);
      res.json(
        await saveChosen(
          req,
          { provider: "manual", source: "手动上传", sourceUrl: "" },
          bytes,
        ),
      );
    },
  );
  function submit(item) {
    const song = currentSong(store, item.id);
    checkRevision(song, item.expectedRevision);
    assertSongIdle(store, song.id);
    if (
      !item.force &&
      song.poster &&
      existsSync(song.poster) &&
      path.basename(song.poster) === posterName
    )
      return { id: song.id, status: "skipped", message: "已有歌曲封面" };
    const jobId = addJob("poster", { id: song.id, force: item.force === true });
    return {
      id: song.id,
      status: "success",
      message: "已加入封面任务，原唱和伴奏保持可用",
      jobId,
    };
  }
  app.post("/api/admin/library/:id/poster", admin, (req, res) => {
    const result = submit({ ...req.body, id: req.params.id });
    emit("library", {});
    res.json(result);
  });
  app.post("/api/admin/poster-batch", admin, (req, res) => {
    if (
      !Array.isArray(req.body.items) ||
      !req.body.items.length ||
      req.body.items.length > 20
    )
      throw new Error("每批需包含 1 至 20 首歌曲");
    const results = req.body.items.map((item) => {
      try {
        return submit(item);
      } catch (error) {
        return {
          id: item?.id,
          status:
            error.code === "REVISION_CONFLICT"
              ? "conflict"
              : error.code === "SONG_BUSY"
                ? "skipped"
                : "failed",
          message: error.message,
        };
      }
    });
    emit("library", {});
    res.json({ results });
  });
  return {
    candidate,
    download,
    register(source) {
      const id = randomUUID();
      const item = {
        ...source,
        id,
        imageUrl: allowedPosterUrl(source.imageUrl).href,
        expires: Date.now() + 15 * 60000,
      };
      candidates.set(id, item);
      while (candidates.size > 400)
        candidates.delete(candidates.keys().next().value);
      return {
        id,
        title: item.title || item.artist || "歌手照片",
        uploader: item.source,
        sourceUrl: item.sourceUrl,
      };
    },
  };
}
