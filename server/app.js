import { favoriteBundlesApi } from "./favorite-bundles.js";
import { libraryPreviewApi } from "./library-preview.js";
import { posterApi } from "./poster-api.js";
import { artistApi } from "./artist-api.js";
import { requestLimits } from "./request-limits.js";
import { tvPairingApi } from "./tv-pairing.js";
import { liveEvents } from "./live-events.js";
import { startDiscovery } from "./discovery.js";
import { serverIdentity } from "./tv-discovery.js";
import { pcApi } from "./routes/pc.js";
import { startBackgroundTasks } from "./background-tasks.js";
import { backgroundApi } from "./background-api.js";
import { publicLibraryApi } from "./routes/public-library.js";
import { mediaApi } from "./routes/media.js";
import { onlineApi } from "./routes/online.js";
import { settingsApi } from "./routes/settings.js";
import { separationApi } from "./routes/separation.js";
import { reviewsApi } from "./routes/reviews.js";
import { legacyLibraryApi } from "./routes/legacy-library.js";
import { createRoom } from "./room.js";
import {
  createRoomRegistry,
  roomRegistryApi,
  LEGACY_ROOM,
} from "./room-registry.js";
import { createScheduler } from "./scheduler.js";
import { libraryApi } from "./library-api.js";
import { libraryDeleteApi } from "./library-delete.js";
import { resourceRoot } from "./assets.js";
import express from "express";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createAdminAuth } from "./admin-auth.js";
import { mkdirSync, existsSync } from "node:fs";
import { openStore } from "./db.js";
import { recoverDeletions } from "./song-deletion.js";

import { fail, equal } from "./http-utils.js";

export function createApp(options = {}) {
  const dir = path.resolve(options.dataDir || process.env.DATA_DIR || "./data");
  const roots = (
    options.roots || (process.env.MEDIA_ROOTS || "./media").split("|")
  ).map((p) => path.resolve(p));
  const downloads = path.resolve(
      options.downloads ||
        process.env.DOWNLOAD_DIR ||
        path.join(dir, "downloads"),
    ),
    cache = resourceRoot(roots[0]),
    legacyCache = path.join(dir, "cache");
  [downloads, cache].forEach((p) => mkdirSync(p, { recursive: true }));
  const store = openStore(dir),
    { db, get, set } = store;
  store.readOnlyMedia = !!options.readOnlyMedia;
  if (!store.readOnlyMedia)
    recoverDeletions(store, [...roots, downloads, cache, legacyCache]);
  const initialAdminToken =
    options.adminToken || process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
  if (!initialAdminToken || initialAdminToken.length < 6)
    throw new Error("请设置至少 6 位的 ADMIN_PASSWORD（管理密码）");
  const auth = createAdminAuth(store, initialAdminToken);
  const { cookieName, cookieToken, hasSession, sessionDigest } = auth;
  const isAdmin = (req) => req.adminAuthenticated === true;
  const app = express();
  const rooms = createRoomRegistry(store);
  const clients = new Set();
  app.disable("x-powered-by");
  // Validate only the optional QR origin hint; API access uses explicit credentials.
  function allowedOrigin(req, origin) {
    return (
      typeof origin === "string" &&
      [
        `${req.protocol}://${req.get("host")}`,
        `https://${req.get("host")}`,
        get("publicUrl", "").replace(/\/$/, ""),
      ]
        .filter(Boolean)
        .includes(origin)
    );
  }
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });
  if (store.readOnlyMedia)
    app.use("/api", (req, res, next) => {
      const writable =
        /^\/(login|tv-pairing|queue|playback|control|player|room|reactions)(\/|$)/.test(
          req.path,
        );
      const readOnlyLyricsSearch =
        req.method === "POST" && req.path === "/admin/find-lyrics";
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        !writable &&
        !readOnlyLyricsSearch
      )
        return res.status(403).json({
          error:
            "本地预览使用 NAS 媒体只读副本；请在正式管理端执行整理和资源修改。",
        });
      next();
    });
  const token = (req) =>
    req.get("authorization")?.replace(/^Bearer /, "") || req.query.token;
  const admin = (req, res, next) =>
    isAdmin(req) ? next() : next(fail(401, "请输入正确的管理密码"));
  const member = (req, res, next) => {
    const room = rooms.byToken(token(req));
    if (!room && !isAdmin(req))
      return next(fail(401, "请登录 NAS 或扫描歌房二维码"));
    req.roomId = room?.id || LEGACY_ROOM;
    next();
  };
  app.use("/api", async (req, res, next) => {
    try {
      req.adminAuthenticated = await auth.authenticate(
        req,
        token(req),
        !!rooms.byToken(token(req)),
      );
      next();
    } catch (error) {
      if (error.status === 429) res.set("Retry-After", "60");
      next(error);
    }
  });
  app.use(
    "/api",
    requestLimits({
      authenticated: (req) => !!rooms.byToken(token(req)) || isAdmin(req),
    }),
  );
  const events = liveEvents(clients, (roomId) => snapshot(roomId));
  const emit = events.emit;
  const { snapshot, enqueue, isPlaying, revokePlayers } = createRoom({
    app,
    member,
    store,
    rooms,
    cache,
    emit,
    addJob: (...args) => addJob(...args),
  });
  const scheduler = createScheduler(
    {
      db,
      get,
      set,
      store,
      dir,
      roots,
      downloads,
      cache,
      legacyCache,
      posterOptions: options.posterOptions,
      emit,
      enqueue,
      isPlaying,
      fail,
    },
    {
      enabled: options.worker !== false && !store.readOnlyMedia,
      onIdle: () => db.close(),
    },
  );
  const { addJob, work, deleteJob } = scheduler;
  const discovery = startDiscovery({
    store,
    work,
    emit,
    enabled:
      !store.readOnlyMedia &&
      (options.discovery ??
        (process.env.KTV_DISCOVERY_ENABLED === "1" &&
          process.env.KTV_LOCAL_ONLY !== "1")),
  });
  function revokeMemberSessions() {
    db.exec("BEGIN IMMEDIATE");
    try {
      set("roomToken", randomBytes(24).toString("hex"));
      for (const room of db.prepare("SELECT id FROM rooms").all())
        db.prepare("UPDATE rooms SET token=? WHERE id=?").run(
          randomBytes(24).toString("hex"),
          room.id,
        );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    clearPairings();
    revokePlayers();
    for (const client of clients) client.end();
    clients.clear();
  }
  const routeContext = {
    rooms,
    isPlaying,
    deleteJob,
    discovery,
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
    enqueue,
    snapshot,
    allowedOrigin,
    async changeAdminPassword(current, next, revoke = true) {
      await auth.changePassword(current, next);
      if (revoke) revokeMemberSessions();
    },
    revokeMemberSessions,
  };
  const resolveReview = reviewsApi(routeContext);
  roomRegistryApi(routeContext);
  const clearPairings = tvPairingApi(routeContext);
  libraryApi({ ...routeContext, resolveReview });
  favoriteBundlesApi(routeContext);
  libraryDeleteApi(routeContext);
  const posterCatalog = posterApi({
    ...routeContext,
    posterOptions: options.posterOptions,
  });
  const artistProfiles = artistApi({
    ...routeContext,
    posterCatalog,
    artistOptions: options.artistOptions,
    enabled: options.worker !== false && !store.readOnlyMedia,
  });
  libraryPreviewApi(routeContext);
  backgroundApi(routeContext);
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.get("/api/server-info", (req, res) => res.json(serverIdentity));
  app.get("/api/login", admin, (req, res) =>
    res.json({ token: get("roomToken") }),
  );
  app.post("/api/login", admin, (req, res) => {
    const value = randomBytes(32).toString("hex");
    const sessions = get("adminSessions", [])
      .filter((session) => session.expires > Date.now())
      .slice(-19);
    sessions.push({
      digest: sessionDigest(value),
      expires: Date.now() + 7 * 86400000,
    });
    set("adminSessions", sessions);
    res.cookie(cookieName, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure || req.get("x-forwarded-proto") === "https",
      maxAge: 7 * 86400000,
      path: "/",
    });
    res.json({ token: get("roomToken") });
  });
  app.post("/api/logout", (req, res) => {
    if (hasSession(req))
      set(
        "adminSessions",
        get("adminSessions", []).filter(
          (session) => !equal(session.digest, sessionDigest(cookieToken(req))),
        ),
      );
    res.clearCookie(cookieName, { path: "/" });
    res.json({ ok: true });
  });
  app.get("/api/events", member, (req, res) => {
    if (clients.size >= 40) throw fail(429, "连接数过多");
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    clients.add(res);
    res.roomId = req.roomId;
    res.write(
      `event: state\ndata: ${JSON.stringify(snapshot(req.roomId))}\n\n`,
    );
    req.on("close", () => clients.delete(res));
  });
  publicLibraryApi(routeContext);
  mediaApi(routeContext);
  onlineApi(routeContext);
  settingsApi(routeContext);
  separationApi(routeContext);
  pcApi(routeContext);
  legacyLibraryApi(routeContext);
  app.get("/", (req, res) => res.redirect(302, "/admin"));
  app.use(express.static(path.resolve("dist")));
  app.get(
    ["/", "/tv", "/play", "/mobile", "/control", "/admin", "/pc", "/pc/"],
    (req, res) =>
      existsSync(path.resolve("dist/index.html"))
        ? res.sendFile(path.resolve("dist/index.html"))
        : res.status(503).send("请先运行 npm run build，或访问 Vite 开发服务"),
  );
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 400).json({
      error: err.message || "请求失败",
      code: err.code,
      currentRevision: err.currentRevision,
    });
  });
  const backgroundTasks = startBackgroundTasks({
    store,
    roots,
    downloads,
    cache,
    legacyCache,
    isPlaying,
    addJob,
    enabled: options.worker !== false && !store.readOnlyMedia,
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
  }, 20000);
  heartbeat.unref();
  setImmediate(work);
  return {
    app,
    store,
    addJob,
    close: async () => {
      clearInterval(heartbeat);
      events.close();
      discovery.stop();
      await backgroundTasks.stop();
      clients.forEach((c) => c.end());
      await artistProfiles.stop();
      return scheduler.stop();
    },
  };
}
