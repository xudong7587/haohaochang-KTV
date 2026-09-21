import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, stat, rename, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import {
  findPoster,
  findArtistPoster,
  downloadPoster,
} from "./poster-source.js";
import { withSongWrite, currentSong } from "./song-writes.js";
import { safeMedia, inside } from "./media-utils.js";
import { savePosterImage } from "./poster-image.js";
import { biliCookie } from "./bili-credentials.js";

export const posterName = "封面.jpg";
export const posterSearchVersion = 2;
export const posterBase = (store, id, cache) =>
  store.get("package-base:" + id) ||
  store.get("package:" + id) ||
  path.join(cache, "歌曲", id);
export function needsPoster(store, song) {
  if (
    !song ||
    song.status !== "ready" ||
    !store.get("package-ready:" + song.id)
  )
    return false;
  const attempt = store.get("poster-attempt:" + song.id);
  if (
    attempt?.at > Date.now() - 24 * 3600000 &&
    (attempt.status === "success" ||
      attempt.searchVersion === posterSearchVersion)
  )
    return false;
  return (
    !song.poster ||
    !existsSync(song.poster) ||
    path.basename(song.poster) !== posterName
  );
}
export async function scrapePoster(
  store,
  id,
  cache,
  {
    force = false,
    outputDirectory,
    sourceRoots = [cache],
    find = findPoster,
    findArtist = findArtistPoster,
    download = downloadPoster,
    report = () => {},
  } = {},
) {
  return withSongWrite(
    store,
    id,
    async (song) => {
      const folder = outputDirectory
        ? path.join(outputDirectory, id)
        : posterBase(store, id, cache);
      if (!inside(outputDirectory || cache, folder))
        throw new Error("封面保存位置超出曲库");
      await mkdir(folder, { recursive: true });
      // Resolve the parent before writing to reject an unexpected linked directory.
      await safeMedia(folder, [outputDirectory || cache]);
      const destination = path.join(folder, posterName);
      if (!force && song.poster === destination && existsSync(destination))
        return {
          status: "skipped",
          message: "已有封面",
          source: store.get("poster-source:" + id),
        };
      const temporary = path.join(folder, ".ktv-poster-" + randomUUID());
      const input = temporary + ".image",
        output = temporary + ".jpg";
      let source;
      try {
        report("poster-search");
        if (!force && song.poster && existsSync(song.poster)) {
          const file = await safeMedia(song.poster, [
            ...sourceRoots,
            ...(outputDirectory ? [outputDirectory] : []),
          ]);
          if ((await stat(file)).size > 8 * 1024 * 1024)
            throw new Error("原有封面超过 8 MB");
          await writeFile(input, await readFile(file), { flag: "wx" });
          source = store.get("poster-source:" + id) || {
            provider: "local",
            source: "本地封面",
            sourceUrl: "",
            album: "",
          };
        } else {
          source = await find(song, {
            source: store.get("source:" + id, {}),
            albumHint: store.get("album-hint:" + id, ""),
            sourceUrl:
              store.get("video-source:" + id)?.url ||
              store.get("download-quality:" + id)?.sourceUrl ||
              "",
            cookie: biliCookie(store),
          });
          let bytes;
          try {
            try {
              bytes = await download(source.imageUrl);
            } catch (error) {
              if (
                !source.fallbackImageUrl ||
                source.fallbackImageUrl === source.imageUrl
              )
                throw error;
              bytes = await download(source.fallbackImageUrl);
            }
          } catch (error) {
            if (
              source.fallback === "artist" ||
              (song.poster && existsSync(song.poster))
            )
              throw error;
            const artist = await findArtist(song.artist);
            if (!artist) throw error;
            bytes = await download(artist.imageUrl);
            source = artist;
          }
          await writeFile(input, bytes, { flag: "wx" });
        }
        report("poster-save");
        await savePosterImage(input, output);
        const bytes = await readFile(output);
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
          throw new Error("封面转换失败");
        const record = {
          ...source,
          file: posterName,
          hash: createHash("sha256").update(bytes).digest("hex"),
          updatedAt: Date.now(),
        };
        await writeFile(temporary + ".json", JSON.stringify(record, null, 2));
        await rename(output, destination);
        await rename(temporary + ".json", path.join(folder, "封面来源.json"));
        store.db
          .prepare("UPDATE songs SET poster=? WHERE id=?")
          .run(destination, id);
        store.set("poster-source:" + id, record);
        store.set("poster-attempt:" + id, {
          at: Date.now(),
          status: "success",
          searchVersion: posterSearchVersion,
        });
        return {
          status: "success",
          message: `${source.source}已保存`,
          source: record,
        };
      } catch (error) {
        store.set("poster-attempt:" + id, {
          at: Date.now(),
          status: "failed",
          searchVersion: posterSearchVersion,
          error: error.message,
        });
        throw error;
      } finally {
        await Promise.all(
          [input, output, temporary + ".json"].map((file) =>
            rm(file, { force: true }),
          ),
        );
      }
    },
    { wait: true },
  );
}
