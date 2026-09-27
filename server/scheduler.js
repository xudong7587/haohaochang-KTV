import { taskProgress } from "./task-progress.js";
import { cancellableDownload, withTaskSignal } from "./task-cancellation.js";
import { cleanTaskFiles } from "./task-files.js";
import { needsPoster } from "./song-poster.js";
import { randomUUID, createHash } from "node:crypto";
import { runJob } from "./jobs.js";
import { cleanImportedDownloads } from "./download-cleanup.js";
import { cleanSongVersions } from "./resource-cleanup.js";
import { songIdFor, currentSong, withSongWrite } from "./song-writes.js";
import { resourceManifest } from "./resource-manifest.js";
import { mergeRoomTargets } from "./room-targets.js";
export function createScheduler(
  dependencies,
  { enabled = true, execute = runJob, onIdle = () => {} } = {},
) {
  const { db, get, set, store, cache, emit, enqueue } = dependencies;
  const active = new Map(),
    deleting = new Map();
  let running = 0,
    stopped = false;
  let resolveStop;
  const stoppedPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });
  function finishStop() {
    onIdle();
    resolveStop();
  }
  function addJob(kind, payload) {
    if (songIdFor(payload) && get("deletion:" + songIdFor(payload)))
      throw Object.assign(new Error("歌曲正在删除"), { status: 409 });
    function promote(existing) {
      if (payload.priority === "mobile" || payload.enqueue) {
        const p = JSON.parse(existing.payload);
        db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
          JSON.stringify({
            ...p,
            ...(payload.priority === "mobile"
              ? { priority: "mobile", requestId: p.requestId || existing.id }
              : {}),
            ...(payload.enqueue
              ? {
                  enqueue: true,
                  name: payload.name,
                  enqueueRooms: mergeRoomTargets(p, payload),
                }
              : {}),
          }),
          existing.id,
        );
        emit();
        setImmediate(work);
      }
      return existing.id;
    }
    if (kind === "acquire") {
      const existing = db
        .prepare(
          "SELECT id,payload FROM jobs WHERE kind='acquire' AND status IN ('queued','running','review')",
        )
        .all()
        .find((j) => {
          const p = JSON.parse(j.payload);
          return p.title === payload.title && p.artist === payload.artist;
        });
      if (existing) return promote(existing);
    }
    if (["download", "favorite-download"].includes(kind)) {
      const duplicate = db
        .prepare(
          "SELECT id,payload FROM jobs WHERE kind IN ('download','favorite-download') AND status IN ('queued','running','waiting-worker')",
        )
        .all()
        .find((j) => {
          const p = JSON.parse(j.payload);
          return (
            p.url === payload.url &&
            (p.quality || "legacy") === (payload.quality || "legacy") &&
            JSON.stringify(p.clip || null) ===
              JSON.stringify(payload.clip || null) &&
            (p.title || "") === (payload.title || "") &&
            (p.artist || "") === (payload.artist || "")
          );
        });
      if (duplicate) {
        return promote(duplicate);
      }
    }
    if (kind === "prepare") {
      const duplicate = db
        .prepare(
          "SELECT id,payload FROM jobs WHERE kind='prepare' AND status IN ('queued','running')",
        )
        .all()
        .find((j) => JSON.parse(j.payload).id === payload.id);
      if (duplicate) {
        if (!payload.ambientOnly)
          db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
            JSON.stringify({
              ...JSON.parse(duplicate.payload),
              ambientOnly: false,
            }),
            duplicate.id,
          );
        if (payload.enqueue) {
          const merged = {
            ...JSON.parse(duplicate.payload),
            enqueue: true,
            name: payload.name,
            enqueueRooms: mergeRoomTargets(
              JSON.parse(duplicate.payload),
              payload,
            ),
            ambientOnly: false,
          };
          db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
            JSON.stringify(merged),
            duplicate.id,
          );
        }
        return duplicate.id;
      }
    }
    const operationKey = String(
      payload.idempotencyKey ||
        createHash("sha256")
          .update(kind + "\n" + JSON.stringify(payload))
          .digest("hex"),
    ).slice(0, 200);
    const existing = db
      .prepare("SELECT id,payload,status FROM jobs WHERE kind=?")
      .all(kind)
      .find(
        (j) =>
          JSON.parse(j.payload).operationKey === operationKey &&
          (payload.idempotencyKey ||
            ["queued", "running", "waiting-worker"].includes(j.status)),
      );
    if (existing) return existing.id;
    const songId = songIdFor(payload);
    if (songId)
      payload = {
        ...payload,
        expectedRevision:
          payload.expectedRevision ??
          currentSong(store, songId).metadataRevision,
      };
    const id = randomUUID();
    payload = {
      ...payload,
      operationKey,
      jobId: id,
      stagingId: id,
      ...(payload.priority === "mobile"
        ? { requestId: payload.requestId || id }
        : {}),
    };
    db.prepare(
      "INSERT INTO jobs (id,kind,payload,status,created) VALUES (?,?,?,?,?)",
    ).run(id, kind, JSON.stringify(payload), "queued", Date.now());
    emit();
    setImmediate(work);
    return id;
  }
  async function deleteJob(id) {
    if (store.readOnlyMedia)
      throw Object.assign(new Error("只读模式不能清理下载文件"), {
        status: 409,
      });
    if (deleting.has(id)) return deleting.get(id);
    const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job)
      throw Object.assign(new Error("任务不存在或已删除"), { status: 404 });
    if (
      !cancellableDownload(job) ||
      !["queued", "running", "waiting-worker", "failed", "cancelling"].includes(
        job.status,
      )
    )
      throw Object.assign(
        new Error("此任务不能取消；仅下载任务支持取消并清理"),
        { status: 409 },
      );
    db.prepare(
      "UPDATE jobs SET status='cancelling',stage='cancelling',error='' WHERE id=?",
    ).run(id);
    emit("tasks", {});
    const operation = (async () => {
      try {
        const execution = active.get(id);
        execution?.controller.abort(
          Object.assign(new Error("用户取消下载"), { code: "TASK_CANCELLED" }),
        );
        if (execution) await execution.done;
        await cleanTaskFiles(store, dependencies.downloads, id);
        db.prepare("DELETE FROM settings WHERE key LIKE ?").run(
          `separation:${id}:%`,
        );
        db.prepare("DELETE FROM jobs WHERE id=? AND status='cancelling'").run(
          id,
        );
        emit("tasks", {});
        return { ok: true };
      } catch (error) {
        db.prepare(
          "UPDATE jobs SET stage='cleanup-failed',error=? WHERE id=?",
        ).run(error.message, id);
        emit("tasks", {});
        throw error;
      } finally {
        deleting.delete(id);
        if (stopped && !running && !deleting.size) finishStop();
      }
    })();
    deleting.set(id, operation);
    return operation;
  }
  // A power loss during cancellation must never restart the cancelled download.
  for (const job of db
    .prepare("SELECT * FROM jobs WHERE status='cancelling'")
    .all()) {
    if (enabled && cancellableDownload(job))
      setImmediate(() => deleteJob(job.id).catch(() => {}));
  }
  async function work() {
    if (running >= 4 || stopped || enabled === false) return;
    const jobSong = (j) => songIdFor(JSON.parse(j.payload));
    const activeSongs = new Set(
      db
        .prepare("SELECT payload FROM jobs WHERE status='running'")
        .all()
        .map(jobSong)
        .filter(Boolean),
    );
    const job = db
      .prepare(
        "SELECT * FROM jobs WHERE status='queued' ORDER BY CASE WHEN json_extract(payload,'$.priority')='mobile' THEN -1 WHEN kind IN ('acquire','download') OR json_extract(payload,'$.priority')='online' THEN 0 WHEN kind='resource-cleanup' THEN 1 WHEN kind='poster' THEN 3 ELSE 2 END, created",
      )
      .all()
      .find(
        (j) =>
          (!jobSong(j) || !activeSongs.has(jobSong(j))) &&
          (running < 3 ||
            ["acquire", "download"].includes(j.kind) ||
            ["online", "mobile"].includes(JSON.parse(j.payload).priority)),
      );
    if (!job) return;
    running++;
    const controller = new AbortController();
    let finished;
    const done = new Promise((resolve) => {
      finished = resolve;
    });
    active.set(job.id, { controller, done });
    const checkCancelled = () => controller.signal.throwIfAborted();
    setImmediate(work);
    db.prepare(
      "UPDATE jobs SET status='running',started=?,finished=NULL WHERE id=?",
    ).run(Date.now(), job.id);
    emit("tasks", {});
    const payload = JSON.parse(job.payload);
    try {
      const report = (stage) => {
        taskProgress(store, job.id, null);
        checkCancelled();
        db.prepare("UPDATE jobs SET stage=? WHERE id=?").run(stage, job.id);
        emit("tasks", {});
      };
      report(job.kind);
      const priority =
        payload.priority ||
        (["acquire", "download"].includes(job.kind) ? "online" : undefined);
      const context = {
        ...dependencies,
        addJob: (kind, child) => {
          checkCancelled();
          const fresh = JSON.parse(
            db.prepare("SELECT payload FROM jobs WHERE id=?").get(job.id)
              .payload,
          );
          const nextPriority = fresh.priority || priority;
          return addJob(kind, {
            ...child,
            roomId: child.roomId || fresh.roomId,
            ...(["import", "prepare", "acquire", "download"].includes(kind) &&
            fresh.enqueue
              ? {
                  sourceJobId: job.id,
                  enqueue: true,
                  enqueueRooms: mergeRoomTargets(fresh, child),
                }
              : {}),
            ...(nextPriority ? { priority: nextPriority } : {}),
            ...(fresh.requestId ? { requestId: fresh.requestId } : {}),
            ...(nextPriority === "mobile" && fresh.enqueue
              ? { enqueue: true, name: fresh.name }
              : {}),
          });
        },
        enqueue,
        report,
      };
      const songId = songIdFor(payload);
      const invoke = () =>
        withTaskSignal(
          cancellableDownload(job) ? controller.signal : undefined,
          () => execute(job, payload, context),
        );
      const outcome = songId
        ? await withSongWrite(store, songId, invoke, {
            expectedRevision: payload.expectedRevision,
            jobId: job.id,
            wait: true,
          })
        : await invoke();
      checkCancelled();
      if (outcome === "review") return;
      db.prepare(
        "UPDATE jobs SET status='done',stage='done',error='' WHERE id=?",
      ).run(job.id);
      const finishedPayload = JSON.parse(
        db.prepare("SELECT payload FROM jobs WHERE id=?").get(job.id).payload,
      );
      if (finishedPayload.id) {
        if (
          [
            "import",
            "organize",
            "prepare",
            "standardize",
            "attach-video",
            "find-video",
            "upgrade-hd",
            "refresh-video",
          ].includes(job.kind)
        ) {
          const song = db
            .prepare("SELECT * FROM songs WHERE id=?")
            .get(finishedPayload.id);
          if (needsPoster(store, song)) addJob("poster", { id: song.id });
        }
        try {
          await cleanSongVersions(store, finishedPayload.id, cache, {
            legacyCache: dependencies.legacyCache,
            isPlaying: dependencies.isPlaying,
          });
        } catch (error) {
          store.set("resource-cleanup", {
            error: error.message,
            checkedAt: Date.now(),
          });
        }
        try {
          await cleanImportedDownloads(store, dependencies.downloads, {
            id: finishedPayload.id,
          });
        } catch (error) {
          store.set("download-cleanup", {
            error: error.message,
            checkedAt: Date.now(),
          });
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e.code === "WAITING_WORKER") {
        db.prepare(
          "UPDATE jobs SET status='waiting-worker',stage='waiting-worker',error=? WHERE id=?",
        ).run(e.message, job.id);
        return;
      }
      db.prepare("UPDATE jobs SET status='failed',error=? WHERE id=?").run(
        e.message.slice(-1800),
        job.id,
      );
      if (
        job.kind === "prepare" &&
        !resourceManifest(store, currentSong(store, payload.id), cache).playable
      )
        db.prepare("UPDATE songs SET status='error',error=? WHERE id=?").run(
          e.message.slice(-1800),
          payload.id,
        );
    } finally {
      taskProgress(store, job.id, null);
      db.prepare("UPDATE jobs SET finished=? WHERE id=?").run(
        Date.now(),
        job.id,
      );
      active.delete(job.id);
      finished();
      running--;
      emit("library", {});
      emit();
      if (stopped && !running && !deleting.size) finishStop();
      else setImmediate(work);
    }
  }
  return {
    addJob,
    deleteJob,
    work,
    stop() {
      if (stopped) return stoppedPromise;
      stopped = true;
      if (!running && !deleting.size) finishStop();
      return stoppedPromise;
    },
  };
}
