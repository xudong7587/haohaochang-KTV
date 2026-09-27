import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, renameSync, rmSync } from "node:fs";
import { inside } from "./media-utils.js";

// Persist the move plan before touching files. Startup restores an interrupted
// deletion, or finishes reclamation only after the database commit succeeded.
export const deletionKey = (id) => "deletion:" + id;
function checked(target, roots) {
  if (
    !path.isAbsolute(target.path) ||
    path.dirname(target.path) !== path.dirname(target.staged) ||
    !path.basename(target.staged).startsWith(".ktv-delete-")
  )
    throw new Error("删除恢复路径无效");
  const parent = realpathSync(path.dirname(target.path));
  if (
    !roots.some((root) => {
      try {
        return inside(realpathSync(root), parent);
      } catch {
        return false;
      }
    })
  )
    throw new Error("删除恢复路径不在媒体目录内");
}
export function finishDeletion(store, id, roots) {
  const key = deletionKey(id),
    journal = store.get(key);
  if (!journal) return;
  for (const target of [...journal.targets].reverse()) {
    checked(target, roots);
    if (!existsSync(target.staged)) continue;
    if (journal.committed)
      rmSync(target.staged, { recursive: target.directory, force: true });
    else {
      if (existsSync(target.path))
        throw new Error("恢复目标已存在，保留隔离文件等待核对");
      renameSync(target.staged, target.path);
    }
  }
  store.db.prepare("DELETE FROM settings WHERE key=?").run(key);
}
export function recoverDeletions(store, roots) {
  for (const { key } of store.db
    .prepare("SELECT key FROM settings WHERE key LIKE 'deletion:%'")
    .all())
    finishDeletion(store, key.slice("deletion:".length), roots);
}
export function quarantineDeletion(store, id, targets, roots, commit) {
  const key = deletionKey(id);
  const journal = {
    committed: false,
    targets: targets.map((target) => ({
      ...target,
      staged: path.join(
        path.dirname(target.path),
        ".ktv-delete-" + randomUUID(),
      ),
    })),
  };
  store.set(key, journal);
  try {
    for (const target of journal.targets) {
      checked(target, roots);
      renameSync(target.path, target.staged);
    }
    store.db.exec("BEGIN IMMEDIATE");
    try {
      commit();
      store.set(key, { ...journal, committed: true });
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    finishDeletion(store, id, roots);
    throw error;
  }
  // A cleanup failure leaves a committed journal for restart, never restores
  // deleted songs or removes their still-needed source on a failed DB commit.
  try {
    finishDeletion(store, id, roots);
  } catch {}
}
