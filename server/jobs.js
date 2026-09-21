import { ensureBiliCredentials } from "./bili-credentials.js";
import {
  analyzeFavoriteBundle,
  processFavoritePart,
} from "./favorite-bundles.js";
import { scrapePoster } from "./song-poster.js";
import { supplementLyrics } from "./lyrics-batch.js";
import { migrateSongAssets } from "./assets.js";
import { organize } from "./job-handlers/organize.js";
import { acquire } from "./job-handlers/acquire.js";
import { attach } from "./job-handlers/attach.js";
import { enrich } from "./job-handlers/enrich.js";
import { favorite_sync } from "./job-handlers/favorite-sync.js";
import { favorite_download } from "./job-handlers/favorite-download.js";
import { importJob } from "./job-handlers/import.js";
import { scan } from "./job-handlers/scan.js";
import { prepare } from "./job-handlers/prepare.js";
import { download } from "./job-handlers/download.js";
import { cleanResourceVersions } from "./resource-cleanup.js";
import { standardize } from "./job-handlers/standardize.js";
import { upgradeHd } from "./job-handlers/upgrade-hd.js";
import { compatibleVideo } from "./job-handlers/compatible-video.js";
import { cleanImportedDownloads } from "./download-cleanup.js";
import { refreshVideo } from "./job-handlers/refresh-video.js";
import { stageLocalFile } from "./local-intake.js";

const handlers = {
  "favorite-analyze": analyzeFavoriteBundle,
  "favorite-process": processFavoritePart,
  "local-intake": stageLocalFile,
  "refresh-video": refreshVideo,
  lyrics: supplementLyrics,
  poster: (_job, payload, context) =>
    scrapePoster(context.store, payload.id, context.cache, {
      sourceRoots: [...context.roots, context.downloads],
      ...context.posterOptions,
      force: payload.force === true,
      report: context.report,
    }),
  "compatible-video": compatibleVideo,
  "upgrade-hd": upgradeHd,
  standardize,
  "resource-cleanup": async (_job, _payload, context) => {
    await cleanResourceVersions(context.store, context.cache, {
      legacyCache: context.legacyCache,
      isPlaying: context.isPlaying,
    });
    await cleanImportedDownloads(context.store, context.downloads);
  },
  organize: organize,
  acquire: acquire,
  attach: attach,
  enrich: enrich,
  "favorite-sync": favorite_sync,
  "favorite-download": favorite_download,
  import: importJob,
  scan: scan,
  prepare: prepare,
  download: download,
  "find-video": acquire,
  "attach-video": attach,
};
export async function runJob(job, payload, context) {
  if (
    [
      "download",
      "favorite-sync",
      "favorite-download",
      "acquire",
      "find-video",
      "attach",
      "attach-video",
      "refresh-video",
      "upgrade-hd",
      "import",
      "organize",
    ].includes(job.kind)
  )
    // 在线下载用在线登录，收藏夹下载用收藏夹登录；两份登录各自维护，互不覆盖。
    await Promise.all(
      ["online", "favorites"].map((scope) =>
        ensureBiliCredentials(context.store, { scope }),
      ),
    );
  if (payload.id)
    await migrateSongAssets(payload.id, context.legacyCache, context.cache);
  const handler = handlers[job.kind];
  if (!handler) throw new Error("未知任务类型：" + job.kind);
  return handler(job, payload, context);
}
