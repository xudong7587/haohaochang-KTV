import { withSongWrite } from "./song-writes.js";
import { findLyrics } from "./lyrics-source.js";
import path from "node:path";
import { stat, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  canonicalVideo,
  onlineSearch,
  downloadVideo,
  downloadAudio,
  withBiliCookie,
} from "./sources.js";
import { biliCookie } from "./bili-credentials.js";
import { run } from "./process.js";
import { importMedia, importKey } from "./library.js";
import { prepareSong, probe, safeMedia } from "./media.js";
import { separateSong } from "./separation.js";
import {
  createSourceCandidate,
  metadataFromCandidate,
} from "../shared/source-candidate.js";

const normalized = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
export function matchCandidates(items, title, artist, video = false) {
  const song = normalized(title),
    singer = normalized(artist);
  return items
    .filter((item) => {
      const name = normalized(item.title);
      return (
        song &&
        singer &&
        name.includes(song) &&
        name.includes(singer) &&
        !/翻唱|串烧|教学|教程|reaction|cover\b/i.test(item.title) &&
        (!video ||
          /\bMV\b|官方.*视频|official.*video|music video/i.test(item.title))
      );
    })
    .sort(
      (a, b) =>
        Number(/伴奏|instrumental|karaoke/i.test(b.title)) -
        Number(/伴奏|instrumental|karaoke/i.test(a.title)),
    );
}

export async function candidates(title, artist, video, search = onlineSearch) {
  const found = [];
  for (const provider of ["bilibili", "youtube"]) {
    try {
      const items = await search(
        `${artist} ${title}${video ? " 官方 MV" : ""}`,
        provider,
      );
      const matches = matchCandidates(items, title, artist, video).filter(
        (v) => video || !/伴奏|instrumental|karaoke/i.test(v.title),
      );
      if (matches.length) {
        if (video) return matches;
        found.push(...matches.slice(0, 3));
      }
    } catch {}
  }
  return found;
}

export async function acquireSong(
  payload,
  { store, downloads, roots, outputs, search = onlineSearch },
) {
  const preview = payload.candidate
    ? metadataFromCandidate(payload.candidate)
    : {};
  const title = String(
    payload.metadata?.title || preview.title || payload.title || "",
  ).trim();
  const artist = String(
    payload.metadata?.artist || preview.artist || payload.artist || "",
  ).trim();
  if (!title || !artist || artist === "未知歌手")
    return {
      review: "请补充歌手与歌名，以免自动下载同名歌曲。",
      metadata: { title, artist },
    };
  search =
    search === onlineSearch
      ? (q, p) => onlineSearch(q, p, biliCookie(store))
      : search;
  const found = payload.candidate
    ? [createSourceCandidate(payload.candidate)]
    : payload.sourceUrl
      ? [
          createSourceCandidate({
            url: payload.sourceUrl,
            title: `${artist} ${title}`,
            identity: { title, artist, needs_review: 1 },
          }),
        ]
      : (await candidates(title, artist, false, search)).map((item) =>
          createSourceCandidate(item),
        );
  if (!found.length)
    return {
      review: "未找到可靠匹配。请补充资源链接，或检查歌手、歌名后重试。",
      metadata: { title, artist },
    };
  let last;
  for (const candidate of found.slice(0, 6)) {
    if (
      candidate.reviewReasons.length &&
      !payload.approved &&
      !payload.confirmed
    )
      return {
        review: "来源的歌手或录音版本需要核对，请确认此候选后继续。",
        metadata: { title, artist, lyrics: payload.metadata?.lyrics || "" },
        candidate,
      };
    try {
      await mkdir(downloads, { recursive: true });
      const id = createHash("sha256")
        .update(candidate.canonicalUrl)
        .digest("hex")
        .slice(0, 24);
      const { file } = await withBiliCookie(
        biliCookie(store),
        path.join(downloads, ".credentials"),
        (cookieFile) =>
          downloadAudio(candidate.canonicalUrl, downloads, cookieFile),
      );
      const mode = "original";
      let lyrics = payload.metadata?.lyrics || "";
      let lyricsMatch;
      if (!lyrics) {
        try {
          lyricsMatch = await findLyrics(
            title,
            artist,
            (await probe(file)).duration,
            { version: candidate.identity.version },
          );
          lyrics = lyricsMatch.lyrics;
        } catch {}
      }
      if (!lyrics)
        return {
          review: "已下载音频，缺少匹配歌词，请补充 LRC 后继续",
          metadata: { title, artist, lyrics: "" },
          candidate,
        };
      const songId = await importMedia(store, file, downloads, roots[0], {
        ...metadataFromCandidate(candidate),
        title,
        artist,
        tags: [],
        mode,
        metadata_source: "点歌信息",
        needs_review: 0,
      });
      return await withSongWrite(
        store,
        songId,
        async () => {
          const existing = store.db
            .prepare("SELECT * FROM songs WHERE id=?")
            .get(songId);
          if (existing.status !== "ready") {
            store.db
              .prepare("UPDATE songs SET lyrics=? WHERE id=?")
              .run(lyrics, songId);
            store.set("source:" + songId, {
              url: candidate.canonicalUrl,
              title: candidate.externalTitle,
              candidate,
            });
            if (lyricsMatch)
              store.set("lyrics-match:" + songId, {
                ...lyricsMatch,
                lyrics: undefined,
              });
            await prepareSong(store, songId, [...roots, downloads], outputs);
          }
          const song = store.db
            .prepare("SELECT * FROM songs WHERE id=?")
            .get(songId);
          if (mode === "original" && store.get("ai", {}).enabled)
            await separateSong(store, song, outputs);
          if (
            store.db.prepare("SELECT mode FROM songs WHERE id=?").get(songId)
              .mode === "original"
          )
            return {
              review: "音频与歌词已保存，请连接 PC 或分离 API 后重试",
              metadata: { title, artist, lyrics },
              candidate,
            };
          return { id: songId, title, artist };
        },
        { wait: true, jobId: payload.jobId },
      );
    } catch (error) {
      last = error;
    }
  }
  return {
    review: "资源处理失败：" + (last?.message || "请检查下载源"),
    metadata: { title, artist },
  };
}

export async function findVideo(
  payload,
  {
    store,
    downloads,
    outputs,
    search = onlineSearch,
    download = downloadVideo,
    inspect = probe,
  },
) {
  const song = store.db
    .prepare("SELECT * FROM songs WHERE id=?")
    .get(payload.id);
  if (!song || !song.needs_video) return {};
  const key = "mtv-candidate:" + song.id,
    previous = store.get(key);
  const action =
    payload.action ||
    (payload.confirmed || payload.approved ? "confirm" : "preview");
  if (action === "reject") {
    if (previous?.candidate)
      store.set("mtv-rejected:" + song.id, [
        ...new Set([
          ...store.get("mtv-rejected:" + song.id, []),
          previous.candidate.canonicalUrl,
        ]),
      ]);
    store.set(key, null);
    return { rejected: true };
  }
  if (!["preview", "confirm", "research"].includes(action))
    throw new Error("未知候选操作");
  const metadata = { title: song.title, artist: song.artist };
  const url =
    action === "research"
      ? null
      : payload.candidate?.canonicalUrl || payload.sourceUrl || payload.url;
  // Explicit URLs and staged paths always win. Confirm never launches a search.
  const samePath =
    !payload.candidatePath ||
    (previous?.path &&
      path.resolve(previous.path) === path.resolve(payload.candidatePath));
  let selected =
    action === "research"
      ? null
      : payload.candidate ||
        (samePath &&
        (!url || previous?.candidate?.canonicalUrl === canonicalVideo(url))
          ? previous?.candidate
          : null);
  let candidatePath =
    action === "research"
      ? null
      : payload.candidatePath ||
        (!url || previous?.candidate?.canonicalUrl === canonicalVideo(url)
          ? previous?.path
          : null);
  if (action === "confirm" && !selected && !candidatePath && !url)
    throw new Error("请先选择候选视频，再确认版本与偏移");
  if (url && !selected)
    selected = createSourceCandidate({
      url,
      title: `${song.artist} ${song.title}`,
      identity: { ...metadata, needs_review: 1 },
    });
  if (candidatePath) {
    const file = await safeMedia(candidatePath, [
      path.join(outputs, "mtv-candidates", song.id),
      downloads,
    ]);
    const info = await inspect(file);
    if (!info.hasVideo) throw new Error("候选文件不含视频画面");
    if (!selected)
      selected = createSourceCandidate({
        provider: "local",
        title: `${song.artist} ${song.title}`,
        duration: info.duration,
        identity: { ...metadata, needs_review: 1 },
      });
    return candidateResult(
      file,
      createSourceCandidate({ ...selected, duration: info.duration }),
    );
  }
  if (search === onlineSearch)
    search = (q, p) => onlineSearch(q, p, biliCookie(store));
  const rejected = store.get("mtv-rejected:" + song.id, []);
  const found = selected
    ? [selected]
    : (await candidates(song.title, song.artist, true, search))
        .map((item) => createSourceCandidate(item))
        .filter((item) => !rejected.includes(item.canonicalUrl));
  let last;
  for (const candidate of found.slice(0, selected ? 1 : 2)) {
    try {
      const { file } = await withBiliCookie(
        biliCookie(store),
        path.join(downloads, ".credentials"),
        (cookieFile) => download(candidate.canonicalUrl, downloads, cookieFile),
      );
      const info = await inspect(file);
      if (!info.hasVideo) throw new Error("候选文件不含视频画面");
      const folder = path.join(outputs, "mtv-candidates", song.id);
      await mkdir(folder, { recursive: true });
      const target = path.join(folder, path.basename(file));
      await copyFile(file, target);
      store.set(importKey(file, await stat(file)), song.id);
      return candidateResult(
        target,
        createSourceCandidate({ ...candidate, duration: info.duration }),
      );
    } catch (error) {
      last = error;
    }
  }
  if (selected && last) throw last;
  return {
    review: "暂未找到可用 MTV。音频版本保持可用，可以继续唱；请补充视频链接。",
    metadata,
  };

  function candidateResult(file, candidate) {
    const reasons = [
      ...candidate.reviewReasons,
      "recording-alignment-needs-review",
    ];
    if (song.duration && Math.abs(candidate.duration - song.duration) > 4)
      reasons.push("duration-mismatch");
    candidate = { ...candidate, reviewReasons: [...new Set(reasons)] };
    store.set(key, {
      path: file,
      url: candidate.canonicalUrl,
      duration: candidate.duration,
      candidate,
    });
    if (action === "confirm") {
      const offset = Number(payload.offset ?? 0);
      if (!Number.isFinite(offset) || Math.abs(offset) > 600)
        throw new Error("视频偏移必须为 -600 到 600 秒");
      return {
        file,
        sourceUrl: candidate.canonicalUrl,
        candidate,
        confirmed: true,
        offset,
      };
    }
    return {
      review:
        "已保存 MTV 候选。请试听并核对录音版本和起始偏移，再确认关联画面。",
      metadata,
      candidatePath: file,
      candidate,
    };
  }
}
