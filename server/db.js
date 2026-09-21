import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { managedSeparation } from "./separation/providers.js";

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "ktv.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
      search TEXT NOT NULL DEFAULT '', duration REAL DEFAULT 0, audio TEXT DEFAULT '[]', mode TEXT DEFAULT 'original',
      backing INTEGER DEFAULT 0, vocal INTEGER DEFAULT 0, status TEXT DEFAULT 'new', error TEXT DEFAULT '',
      source TEXT DEFAULT 'local', created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, song_id TEXT NOT NULL REFERENCES songs(id), name TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS queue_rooms (entry_id TEXT PRIMARY KEY REFERENCES queue(id) ON DELETE CASCADE, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS queue_rooms_room ON queue_rooms(room_id);
    CREATE TABLE IF NOT EXISTS task_room_deliveries (job_id TEXT NOT NULL, room_id TEXT NOT NULL, song_id TEXT NOT NULL, PRIMARY KEY(job_id,room_id,song_id));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, error TEXT DEFAULT '', created INTEGER NOT NULL);
  `);
  const jobColumns = db
    .prepare("PRAGMA table_info(jobs)")
    .all()
    .map((c) => c.name);
  for (const name of ["started", "finished"])
    if (!jobColumns.includes(name))
      db.exec("ALTER TABLE jobs ADD COLUMN " + name + " INTEGER");
  if (!jobColumns.includes("stage"))
    db.exec("ALTER TABLE jobs ADD COLUMN stage TEXT DEFAULT ''");
  const columns = db
    .prepare("PRAGMA table_info(songs)")
    .all()
    .map((c) => c.name);
  if (!columns.includes("needs_video"))
    db.exec("ALTER TABLE songs ADD COLUMN needs_video INTEGER DEFAULT 0");
  if (!columns.includes("lyrics"))
    db.exec("ALTER TABLE songs ADD COLUMN lyrics TEXT DEFAULT ''");
  for (const [name, type] of [
    ["evidence", "TEXT DEFAULT '[]'"],
    ["tags", "TEXT DEFAULT '[]'"],
    ["tags_manual", "INTEGER DEFAULT 0"],
    ["poster", "TEXT DEFAULT ''"],
    ["metadata_source", "TEXT DEFAULT '文件名'"],
    ["needs_review", "INTEGER DEFAULT 0"],
  ])
    if (!columns.includes(name))
      db.exec("ALTER TABLE songs ADD COLUMN " + name + " " + type);
  for (const name of ["metadataRevision", "resourceRevision"])
    if (!columns.includes(name))
      db.exec(
        "ALTER TABLE songs ADD COLUMN " + name + " INTEGER NOT NULL DEFAULT 0",
      );
  db.exec(`DROP TRIGGER IF EXISTS songs_metadata_revision;
    CREATE TRIGGER songs_metadata_revision AFTER UPDATE OF title,artist,lyrics,mode,backing,vocal,tags,needs_review,path,metadata_source,evidence ON songs
    WHEN OLD.title IS NOT NEW.title OR OLD.artist IS NOT NEW.artist OR OLD.lyrics IS NOT NEW.lyrics OR OLD.mode IS NOT NEW.mode OR OLD.backing IS NOT NEW.backing OR OLD.vocal IS NOT NEW.vocal OR OLD.tags IS NOT NEW.tags OR OLD.needs_review IS NOT NEW.needs_review OR OLD.path IS NOT NEW.path OR OLD.metadata_source IS NOT NEW.metadata_source OR OLD.evidence IS NOT NEW.evidence
    BEGIN UPDATE songs SET metadataRevision=OLD.metadataRevision+1 WHERE id=NEW.id; END;`);
  const readDb = (key, fallback) => {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  };
  const configPath = path.join(dir, "settings.json");
  const defaults = {
    version: 1,
    autoImport: true,
    publicUrl: "",
    onlineEnabled: true,
    ai: {
      enabled: managedSeparation(),
      endpoint: "",
      model: "",
      apiKey: "",
    },
  };
  let config;
  try {
    if (existsSync(configPath)) {
      config = JSON.parse(
        readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""),
      );
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("配置格式错误");
      config = { ...defaults, ...config };
    } else
      config = {
        ...defaults,
        publicUrl: readDb("publicUrl", ""),
        onlineEnabled: readDb("onlineEnabled", true),
        ai: readDb("ai", defaults.ai),
      };
  } catch (e) {
    db.close();
    throw new Error(`无法读取 ${configPath}：${e.message}。原配置未被覆盖。`);
  }
  const flush = (value) => {
    writeFileSync(configPath + ".tmp", JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(configPath + ".tmp", configPath);
  };
  if (!config.onlineDefaultMigrated) {
    config.onlineEnabled = true;
    config.onlineDefaultMigrated = true;
  }
  // 1.1.1 曾把在线找歌和收藏夹拆成两份登录；1.1.2 恢复为一份，把当时分开保存的
  // 凭证并回 favorites。优先保留仍能自动维护（带刷新令牌）的那一份，避免多令牌轮换。
  if (config["bili-online"] || config.biliLoginSplit) {
    const favorites = config.favorites || {},
      online = config["bili-online"] || {},
      keep =
        online.cookie &&
        (!favorites.cookie ||
          (!!online.credentials?.ac_time_value &&
            !favorites.credentials?.ac_time_value))
          ? online
          : favorites;
    config.favorites = {
      ...favorites,
      cookie: keep.cookie || favorites.cookie || "",
      credentials: keep.credentials || favorites.credentials || {},
    };
    delete config["bili-online"];
    delete config.biliLoginSplit;
  }
  flush(config);
  const keys = new Set([
    "publicUrl",
    "onlineEnabled",
    "ai",
    "autoImport",
    "enrichment",
    "favorites",
    "lyricsStyle",
  ]);
  db.prepare(
    "DELETE FROM settings WHERE key IN ('publicUrl','onlineEnabled','ai')",
  ).run();
  const get = (key, fallback) =>
    keys.has(key) ? (config[key] ?? fallback) : readDb(key, fallback);
  const set = (key, value) => {
    if (keys.has(key)) {
      const next = { ...config, [key]: value };
      flush(next);
      config = next;
    } else
      db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run(
        key,
        JSON.stringify(value),
      );
  };
  if (!get("roomToken")) set("roomToken", randomBytes(24).toString("hex"));
  if (!get("playback"))
    set("playback", { paused: false, vocal: false, revision: 0 });
  db.prepare(
    "UPDATE jobs SET status='queued',error='' WHERE status='running'",
  ).run();
  // Older versions paused these downloads before fetching or clipping media.
  // They can now continue on the NAS; separation jobs retain their own policy.
  db.prepare(
    "UPDATE jobs SET status='queued',stage='',error='' WHERE status='waiting-worker' AND kind='download' AND (json_extract(payload,'$.onlineSelection')=1 OR json_type(payload,'$.clip')='object')",
  ).run();
  if (
    managedSeparation() &&
    get("ai", {}).enabled &&
    get("ai", {}).cpuEnabled !== false
  )
    db.prepare(
      "UPDATE jobs SET status='queued',stage='',error='' WHERE status='waiting-worker'",
    ).run();
  return { db, get, set, configPath };
}
