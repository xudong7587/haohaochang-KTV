import { ensureBiliCredentials } from "./bili-credentials.js";
import {
  resumeFavoriteBundles,
  favoriteBundles,
  discoverLocalFavoriteBundles,
} from "./favorite-bundles.js";
import { stat } from "node:fs/promises";
import { queueMissingPosters } from "./poster-backfill.js";
import { filesUnder, importKey } from "./library.js";
import { inside } from "./media-utils.js";
import { intakeRoot, intakeKey } from "./local-intake.js";
import { scheduleResourceCleanup } from "./resource-cleanup-schedule.js";
export function startBackgroundTasks({
  store,
  roots,
  downloads,
  cache,
  legacyCache,
  isPlaying,
  addJob,
  enabled,
}) {
  const { db, get } = store;
  let stopped = false;
  let credentialsPromise;
  const maintainCredentials = () => {
    if (stopped || !enabled || credentialsPromise) return;
    // 在线找歌和收藏夹自动下载各有一份登录，分别维护刷新。
    credentialsPromise = Promise.all(
      ["online", "favorites"].map((scope) =>
        ensureBiliCredentials(store, { scope }),
      ),
    )
      .catch(() => {})
      .finally(() => {
        credentialsPromise = null;
      });
  };
  setImmediate(maintainCredentials);
  const credentialsTimer = setInterval(maintainCredentials, 15 * 60000);
  credentialsTimer.unref();
  const schedulePosters = () => {
    if (stopped || !enabled) return;
    queueMissingPosters({ store, addJob });
  };
  setImmediate(schedulePosters);
  const posterTimer = setInterval(schedulePosters, 60000);
  posterTimer.unref();
  let cleanupPromise;
  const scheduleCleanup = () => {
    if (stopped || !enabled || cleanupPromise) return;
    cleanupPromise = scheduleResourceCleanup({
      store,
      cache,
      downloads,
      addJob,
      legacyCache,
      isPlaying,
      stopped: () => stopped,
    })
      .catch((error) => console.error("旧资源检查失败:", error.message))
      .finally(() => {
        cleanupPromise = null;
      });
  };
  setImmediate(scheduleCleanup);
  const cleanupTimer = setInterval(scheduleCleanup, 15 * 60 * 1000);
  cleanupTimer.unref();
  let recoveryPromise = null;
  const recoverFavorites = () => {
    if (stopped || !enabled || recoveryPromise) return;
    recoveryPromise = resumeFavoriteBundles({ store, addJob })
      .catch((error) => console.error("收藏夹任务恢复失败:", error.message))
      .finally(() => {
        recoveryPromise = null;
      });
    return recoveryPromise;
  };
  setImmediate(recoverFavorites);
  const favoritesTimer = setInterval(() => {
    void recoverFavorites();
    const c = get("favorites", {});
    if (stopped || !enabled || !c.enabled) return;
    const recent = db
      .prepare(
        "SELECT created FROM jobs WHERE kind='favorite-sync' ORDER BY created DESC LIMIT 1",
      )
      .get();
    if (!recent || Date.now() - recent.created > c.intervalMinutes * 60000)
      addJob("favorite-sync", {});
  }, 30000);
  favoritesTimer.unref();
  let checking = false;
  const observed = new Map();
  const importer = setInterval(async () => {
    if (checking || stopped || !enabled || !get("autoImport", true)) return;
    checking = true;
    try {
      const files = await filesUnder(downloads),
        settled = new Set();
      // Imported or removed files must not remain in this process-wide history.
      const present = new Set(files);
      for (const file of observed.keys())
        if (!present.has(file)) observed.delete(file);
      for (const file of files) {
        const info = await stat(file),
          signature = info.size + ":" + info.mtimeMs;
        if (
          observed.get(file) === signature &&
          Date.now() - info.mtimeMs >= 60000
        )
          settled.add(file);
        observed.set(file, signature);
      }
      const grouped = await discoverLocalFavoriteBundles(
        files.filter(
          (file) =>
            !inside(intakeRoot(downloads), file) &&
            !inside(cache, file) &&
            !roots.some((root) => inside(root, file)),
        ),
        settled,
        {
          store,
          downloads,
          addJob,
        },
      );
      for (const group of favoriteBundles(store))
        for (const part of group.parts) if (part.file) grouped.add(part.file);
      for (const file of files) {
        if (grouped.has(file)) continue;
        if (
          inside(intakeRoot(downloads), file) ||
          get(intakeKey(file))?.status === "moving"
        )
          continue;
        if (roots.some((root) => inside(root, file)) || inside(cache, file))
          continue;
        const info = await stat(file),
          signature = info.size + ":" + info.mtimeMs,
          previous = settled.has(file);
        if (!previous) continue;
        if (get(importKey(file, info))) continue;
        const handled = db
          .prepare(
            "SELECT payload FROM jobs WHERE kind IN ('import','local-intake')",
          )
          .all()
          .some((j) => {
            const p = JSON.parse(j.payload);
            return p.file === file && p.signature === signature;
          });
        if (!handled) addJob("local-intake", { file, signature });
      }
    } catch (e) {
      console.error("下载目录检查失败:", e.message);
    } finally {
      checking = false;
    }
  }, 30000);
  importer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(credentialsTimer);
      clearInterval(importer);
      clearInterval(favoritesTimer);
      clearInterval(cleanupTimer);
      clearInterval(posterTimer);
      return Promise.all([recoveryPromise, credentialsPromise, cleanupPromise]);
    },
  };
}
