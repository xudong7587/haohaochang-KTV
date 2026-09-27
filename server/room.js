import express from "express";
import { LEGACY_ROOM } from "./room-registry.js";
import { jobRoomTargets } from "./room-targets.js";
import { createPlayerLease } from "./player-lease.js";
import { selectAmbient } from "./ambient-selection.js";
import { clampLyricsOffset } from "../shared/lyrics.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { canEnqueue } from "./resource-manifest.js";
import { inspectPackage } from "./resource-health.js";
import { fail, clean } from "./http-utils.js";
function createScopedRoom({
  app,
  member,
  store,
  cache,
  emit,
  addJob,
  roomId,
  rooms,
}) {
  const { db } = store;
  const scopedKey = (key) =>
    roomId !== LEGACY_ROOM &&
    (key === "playback" ||
      key === "ambient-history" ||
      key.startsWith("lyrics-offset:"))
      ? `room:${roomId}:${key}`
      : key;
  const get = (key, fallback) =>
    store.get(
      scopedKey(key),
      key === "playback"
        ? { paused: false, vocal: false, revision: 0 }
        : key.startsWith("lyrics-offset:")
          ? 0
          : fallback,
    );
  const set = (key, value) => store.set(scopedKey(key), value);
  const playerLease = createPlayerLease({ preferTv: roomId === LEGACY_ROOM });
  const queued = (id) =>
    db
      .prepare(
        "SELECT q.id FROM queue q LEFT JOIN queue_rooms qr ON qr.entry_id=q.id WHERE q.song_id=? AND COALESCE(qr.room_id,'legacy')=?",
      )
      .get(id, roomId);
  let ambient = null;
  function snapshot() {
    const queue = db
      .prepare(
        "SELECT q.*,s.title,s.artist,s.mode,s.duration,s.status,s.needs_video,s.lyrics,CASE WHEN s.poster!='' THEN 1 ELSE 0 END AS hasPoster FROM queue q JOIN songs s ON q.song_id=s.id LEFT JOIN queue_rooms qr ON qr.entry_id=q.id WHERE COALESCE(qr.room_id,'legacy')=? ORDER BY position",
      )
      .all(roomId)
      .map((song) => ({
        ...song,
        posterVersion: get("poster-source:" + song.song_id)?.hash || "",
      }));
    const pending = db
      .prepare(
        "SELECT id,kind,payload,status FROM jobs WHERE status IN ('queued','running') AND kind NOT IN ('scan','poster') ORDER BY created",
      )
      .all()
      .filter((j) => {
        const payload = JSON.parse(j.payload);
        return (
          jobRoomTargets(store, payload).some(
            (target) => target.roomId === roomId,
          ) ||
          (!payload.enqueue && (payload.roomId || LEGACY_ROOM) === roomId)
        );
      })
      .map((j) => {
        const p = JSON.parse(j.payload);
        return {
          id: j.id,
          title:
            p.title ||
            (p.id
              ? db.prepare("SELECT title FROM songs WHERE id=?").get(p.id)
                  ?.title
              : path.basename(p.file || "")) ||
            "准备歌曲",
          status: j.status,
        };
      });
    return {
      room: { id: roomId, code: rooms?.byId(roomId)?.code || "" },
      queue,
      pending,
      ambient: queue.length ? null : ambient,
      playback: {
        ...get("playback"),
        lyricsOffsetMs: get(
          "lyrics-offset:" + (queue[0]?.song_id || ambient?.song_id),
          0,
        ),
      },
      playerOnline: !!playerLease.snapshot(),
      player: playerLease.snapshot(),
    };
  }
  const revise = (patch = {}) => {
    const old = get("playback");
    set("playback", { ...old, ...patch, revision: old.revision + 1 });
    emit();
  };
  function enqueue(id, name) {
    const song = db.prepare("SELECT * FROM songs WHERE id=?").get(id);
    if (!canEnqueue(store, song, cache))
      throw fail(409, "歌曲尚未就绪，请先在后台准备播放");
    if (queued(id)) return;
    if (snapshot().queue.length >= 100) throw fail(409, "已点列表已满");
    const position = db
      .prepare("SELECT COALESCE(MAX(position),0)+1 AS p FROM queue")
      .get().p;
    const entryId = randomUUID();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO queue VALUES (?,?,?,?)").run(
        entryId,
        id,
        name,
        position,
      );
      if (roomId !== LEGACY_ROOM)
        db.prepare("INSERT INTO queue_rooms VALUES (?,?)").run(entryId, roomId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (snapshot().queue.length === 1) revise({ paused: false, vocal: false });
    else emit();
  }
  app.get("/api/state", member, (req, res) => res.json(snapshot()));
  app.post("/api/queue", member, async (req, res) => {
    const id = clean(req.body.songId),
      name = clean(req.body.name, 24) || "家人";
    let song = db.prepare("SELECT * FROM songs WHERE id=?").get(id);
    if (!song) throw fail(404, "歌曲不存在");
    if (get("deletion:" + id)) throw fail(409, "歌曲正在删除，请稍后刷新");
    if (get("package-ready:" + id) && get("package:" + id))
      await inspectPackage(store, song, get("package:" + id));
    song = db.prepare("SELECT * FROM songs WHERE id=?").get(id);
    if (!song || get("deletion:" + id)) throw fail(409, "歌曲正在删除或已删除");
    if (get("hidden:" + id)) throw fail(409, "歌曲已隐藏，请在后台恢复后点歌");
    if (song.status === "ready" && !canEnqueue(store, song, cache))
      throw fail(409, "播放文件缺失，请先在后台重新整理");
    if (queued(id)) return res.json(snapshot());
    if (
      song.status !== "ready" ||
      (song.mode === "original" && get("ai", {}).enabled)
    ) {
      addJob("prepare", { id, enqueue: true, name, roomId });
      res.json({ ...snapshot(), preparing: true });
    } else {
      enqueue(id, name);
      res.json(snapshot());
    }
  });
  app.post("/api/queue/:id/top", member, (req, res) => {
    const queue = snapshot().queue;
    if (!queue.some((q) => q.id === req.params.id))
      throw fail(404, "歌曲不在队列中");
    const reordered = [
      queue[0],
      ...queue.slice(1).filter((q) => q.id === req.params.id),
      ...queue.slice(1).filter((q) => q.id !== req.params.id),
    ];
    db.exec("BEGIN");
    try {
      reordered.forEach((q, i) =>
        db.prepare("UPDATE queue SET position=? WHERE id=?").run(i, q.id),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    emit();
    res.json(snapshot());
  });
  app.post("/api/queue/:id/first", member, (req, res) => {
    const queue = snapshot().queue;
    const selected = queue.find((entry) => entry.id === req.params.id);
    if (!selected) throw fail(404, "歌曲不在队列中");
    if (queue[0].id === selected.id) return res.json(snapshot());
    const reordered = [
      selected,
      ...queue.filter((entry) => entry.id !== selected.id),
    ];
    db.exec("BEGIN");
    try {
      reordered.forEach((entry, index) =>
        db
          .prepare("UPDATE queue SET position=? WHERE id=?")
          .run(index, entry.id),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    revise({ paused: false, vocal: false });
    res.json(snapshot());
  });
  app.delete("/api/queue/:id", member, (req, res) => {
    const queue = snapshot().queue;
    if (!queue.some((entry) => entry.id === req.params.id))
      throw fail(404, "歌曲不在当前歌房中");
    if (queue[0]?.id === req.params.id)
      throw fail(409, "请使用切歌结束当前歌曲");
    db.prepare("DELETE FROM queue WHERE id=?").run(req.params.id);
    emit();
    res.json(snapshot());
  });
  app.post("/api/control", member, (req, res) => {
    const current = snapshot().queue[0],
      action = req.body.action;
    if (action === "lyrics-offset") {
      const entry = current || ambient;
      if (!entry || req.body.entryId !== entry.id)
        throw fail(409, "当前歌曲已改变，请重试");
      const delta = Number(req.body.deltaMs);
      if (
        req.body.reset !== true &&
        (!Number.isInteger(delta) || Math.abs(delta) > 10000)
      )
        throw fail(400, "歌词调节每次最多 10 秒");
      const key = "lyrics-offset:" + entry.song_id;
      set(
        key,
        req.body.reset === true ? 0 : clampLyricsOffset(get(key, 0) + delta),
      );
      revise();
      return res.json(snapshot());
    }
    if (!current && ambient && req.body.entryId === ambient.id) {
      if (action === "next") pickAmbient();
      else if (action === "pause") {
        ambient = { ...ambient, paused: !ambient.paused };
        emit();
      } else throw fail(409, "开场音乐固定播放原唱");
      return res.json(snapshot());
    }
    if (!current) throw fail(409, "先点一首歌吧");
    if (req.body.entryId !== current.id)
      throw fail(409, "当前歌曲已改变，请重试");
    if (action === "next") {
      db.prepare("DELETE FROM queue WHERE id=?").run(current.id);
      revise({ paused: false, vocal: false });
    } else if (action === "pause") revise({ paused: !get("playback").paused });
    else if (action === "vocal") {
      if (["original", "instrumental"].includes(current.mode))
        throw fail(
          409,
          current.mode === "instrumental"
            ? "这首歌只有伴奏版本"
            : "这首歌只有原始音频",
        );
      revise({ vocal: !get("playback").vocal });
    } else throw fail(400, "未知控制");
    res.json(snapshot());
  });
  app.post("/api/player/heartbeat", member, (req, res) => {
    const id = clean(req.body.id, 80);
    if (!id) throw fail(400, "缺少播放器标识");
    const result = playerLease.heartbeat({
      id,
      type: req.body.type,
      claim: req.body.claim,
    });
    if (result.freshClaim) {
      if (snapshot().queue.length && get("playback").paused)
        revise({ paused: false });
      if (ambient?.paused) ambient = { ...ambient, paused: false };
    }
    if (!snapshot().queue.length && !ambient) pickAmbient();
    else if (result.changed) emit();
    res.json({ ok: true, owner: result.owner });
  });
  app.post("/api/player/ended", member, (req, res) => {
    if (!playerLease.owns(req.body.playerId))
      throw fail(409, "播放器连接已失效");
    if (ambient?.id === req.body.entryId && !snapshot().queue.length) {
      pickAmbient();
      return res.json(snapshot());
    }
    const current = snapshot().queue[0];
    if (current?.id === req.body.entryId) {
      db.prepare("DELETE FROM queue WHERE id=?").run(current.id);
      revise({ paused: false, vocal: false });
    }
    res.json(snapshot());
  });
  function pickAmbient() {
    const songs = db
      .prepare(
        "SELECT * FROM songs WHERE status='ready' AND mode!='instrumental'",
      )
      .all()
      .filter((s) => canEnqueue(store, s, cache));
    const { song, history } = selectAmbient(songs, get("ambient-history", {}));
    if (song) set("ambient-history", history);
    ambient = song
      ? {
          ...song,
          song_id: song.id,
          id: "ambient-" + randomUUID(),
          ambient: true,
        }
      : null;
    emit();
    if (
      !song &&
      !db
        .prepare(
          "SELECT id FROM jobs WHERE kind='prepare' AND status IN ('queued','running') LIMIT 1",
        )
        .get()
    ) {
      const candidate = db
        .prepare(
          "SELECT id FROM songs WHERE status='new' AND mode!='instrumental' ORDER BY RANDOM()",
        )
        .all()
        .find((s) => !get("hidden:" + s.id));
      if (candidate)
        addJob("prepare", { id: candidate.id, ambientOnly: true, roomId });
    }
  }
  app.post("/api/reactions", member, (req, res) => {
    if (!["👏", "🎉", "❤️", "🌟"].includes(req.body.emoji))
      throw fail(400, "不支持的互动");
    emit("reaction", { emoji: req.body.emoji, id: randomUUID() });
    res.json({ ok: true });
  });
  return {
    snapshot,
    enqueue,
    revoke: () => {
      playerLease.revoke();
      emit();
    },
    isPlaying: (id) => playerLease.snapshot() && ambient?.song_id === id,
  };
}

export function createRoom(options) {
  const scopes = new Map();
  function scope(id = LEGACY_ROOM) {
    if (!scopes.has(id)) {
      if (options.rooms && !options.rooms.byId(id))
        throw fail(404, "歌房不存在");
      const router = express.Router();
      const controller = createScopedRoom({
        ...options,
        roomId: id,
        app: router,
        member: (_req, _res, next) => next(),
        emit: (type, data) => options.emit(type, data, id),
      });
      scopes.set(id, { ...controller, router });
    }
    return scopes.get(id);
  }
  options.app.use((req, res, next) => {
    if (
      !/^\/api\/(state|queue|control|reactions|player\/(heartbeat|ended))(\/|$)/.test(
        req.path,
      )
    )
      return next();
    options.member(req, res, (error) =>
      error ? next(error) : scope(req.roomId).router(req, res, next),
    );
  });
  return {
    snapshot: (roomId) => scope(roomId).snapshot(),
    enqueue: (id, name, roomId) => scope(roomId).enqueue(id, name),
    isPlaying: (id) => [...scopes.values()].some((room) => room.isPlaying(id)),
    revokePlayers: () => {
      for (const room of scopes.values()) room.revoke();
    },
  };
}
