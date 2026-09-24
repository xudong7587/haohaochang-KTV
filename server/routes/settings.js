import { appVersion, githubUrl } from "../version.js";
import { taskStatus } from "../task-status.js";
import { biliLoginApi } from "../bili-login.js";
import { enrichmentConfig, enrichSong } from "../enrichment.js";
import { favoriteConfig } from "../favorites.js";
import { providerConfig, testProvider } from "../separation.js";
import {
  npuConfig,
  cpuConfig,
  embeddedSeparation,
} from "../separation/providers.js";

import { fail, clean } from "../http-utils.js";

export function settingsApi({
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
  changeAdminPassword,
}) {
  biliLoginApi({ app, admin, store });
  app.get("/api/admin/tasks", admin, (req, res) => res.json(taskStatus(store)));
  app.get("/api/admin", admin, (req, res) =>
    res.json({
      version: appVersion,
      githubUrl,
      readOnlyMedia: !!store.readOnlyMedia,
      roots,
      downloads,
      cache,
      autoImport: get("autoImport", true),
      configPath: store.configPath,
      publicUrl: get("publicUrl", ""),
      onlineEnabled: get("onlineEnabled", true),
      scanProgress: get("scan-progress", null),
      songs: db.prepare("SELECT COUNT(*) AS n FROM songs").get().n,
      ready: db
        .prepare("SELECT COUNT(*) AS n FROM songs WHERE status='ready'")
        .get().n,
      jobs: taskStatus(store),
    }),
  );
  app.post("/api/admin/settings", admin, (req, res) => {
    const value =
      req.body.publicUrl === undefined
        ? get("publicUrl", "")
        : clean(req.body.publicUrl, 200);
    if (value) {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw fail(400, "请输入 NAS 的完整访问地址，不要包含路径");
    }
    set("publicUrl", value);
    if (typeof req.body.onlineEnabled === "boolean")
      set("onlineEnabled", req.body.onlineEnabled);
    res.json({ ok: true });
  });
  app.post("/api/admin/password", admin, (req, res) => {
    changeAdminPassword(req.body.currentPassword, req.body.newPassword);
    res.json({ ok: true });
  });
  app.get("/api/admin/ai", admin, (req, res) => {
    const config = get("ai", {});
    res.json({
      enabled: !!config.enabled,
      autoDiscover: config.autoDiscover !== false,
      discovery: discovery.info(),
      endpoint: config.endpoint || "",
      model: config.model || "",
      hasKey: !!config.apiKey,
      pcEndpoint: config.pcEndpoint || "",
      pcModel: config.pcModel || "htdemucs",
      hasPcKey: !!config.pcApiKey,
      embeddedSeparation: embeddedSeparation(),
      cpuEnabled: cpuConfig(config).enabled,
      cpuAvailable: !!cpuConfig(config).endpoint,
      npuEnabled: npuConfig(config).enabled,
      npuEndpoint: npuConfig(config).endpoint,
      hasNpuKey: !!npuConfig(config).apiKey,
    });
  });
  app.post("/api/admin/ai/discover", admin, (req, res) => {
    discovery.scan();
    res.json(discovery.info());
  });
  app.post("/api/admin/ai", admin, (req, res) => {
    set("ai", providerConfig(req.body, get("ai", {})));
    res.json({ ok: true });
  });
  for (const kind of ["pc", "npu", "cpu", "cloud"]) {
    const configFor = (input) => {
      const old = get("ai", {});
      const fields =
        kind === "pc"
          ? [
              "enabled",
              "autoDiscover",
              "pcEndpoint",
              "pcModel",
              "pcApiKey",
              "clearPcKey",
            ]
          : kind === "npu"
            ? ["npuEnabled", "npuEndpoint", "npuApiKey", "clearNpuKey"]
            : kind === "cpu"
              ? ["cpuEnabled"]
              : ["enabled", "endpoint", "model", "apiKey", "clearKey"];
      const patch = Object.fromEntries(
        fields.filter((k) => k in input).map((k) => [k, input[k]]),
      );
      if (
        (kind === "npu" && patch.npuEnabled === true) ||
        (kind === "cpu" && patch.cpuEnabled === true)
      )
        patch.enabled = true;
      return providerConfig({ ...old, ...patch }, old);
    };
    app.post("/api/admin/ai/" + kind, admin, (req, res) => {
      set("ai", configFor(req.body));
      if (kind === "pc") discovery.scan();
      if (
        ["cpu", "npu"].includes(kind) &&
        get("ai", {})[kind + "Enabled"] === true
      ) {
        db.prepare(
          "UPDATE jobs SET status='queued',stage='',error='' WHERE status='waiting-worker'",
        ).run();
        work();
      }
      res.json({ ok: true });
    });
    app.post("/api/admin/ai/" + kind + "/test", admin, async (req, res) => {
      const c = configFor(req.body);
      const target =
        kind === "pc"
          ? { endpoint: c.pcEndpoint, model: c.pcModel, apiKey: c.pcApiKey }
          : kind === "npu"
            ? npuConfig(c)
            : kind === "cpu"
              ? cpuConfig(c)
              : c;
      if (!target.endpoint)
        throw fail(
          400,
          kind === "pc"
            ? "尚未发现 PC，请启动整理器或填写手动地址。"
            : "未配置备用 AI；仅使用 PC 时无需检测此项。",
        );
      res.json(await testProvider(target));
    });
  }
  app.post("/api/admin/ai/test", admin, async (req, res) =>
    res.json(
      await testProvider(
        (() => {
          const c = providerConfig(req.body, get("ai", {}));
          return c.pcEndpoint
            ? { endpoint: c.pcEndpoint, model: c.pcModel, apiKey: c.pcApiKey }
            : npuConfig(c).enabled
              ? npuConfig(c)
              : cpuConfig(c).enabled && cpuConfig(c).endpoint
                ? cpuConfig(c)
                : c;
        })(),
      ),
    ),
  );
  app.post("/api/admin/enrich", admin, (req, res) => {
    if (!get("enrichment", {}).enabled)
      throw fail(400, "请先配置并启用信息 AI");
    if (!Array.isArray(req.body.ids) || req.body.ids.length > 500)
      throw fail(400, "每次最多 500 首");
    res.json({
      jobs: req.body.ids.map((existingId) => addJob("enrich", { existingId })),
    });
  });
  app.get("/api/admin/enrichment", admin, (req, res) => {
    const c = get("enrichment", {});
    res.json({
      enabled: !!c.enabled,
      endpoint: c.endpoint || "https://api.openai.com/v1",
      model: c.model || "",
      protocol: c.protocol || "responses",
      webSearch: !!c.webSearch,
      hasKey: !!c.apiKey,
    });
  });
  app.post("/api/admin/enrichment", admin, (req, res) => {
    set("enrichment", enrichmentConfig(req.body, get("enrichment", {})));
    res.json({ ok: true });
  });
  app.post("/api/admin/enrichment/test", admin, async (req, res) =>
    res.json(
      await enrichSong(enrichmentConfig(req.body, get("enrichment", {})), {
        title: "测试标题，请返回低置信度并说明无法确认，不要编造",
      }),
    ),
  );
  app.get("/api/admin/favorites", admin, (req, res) => {
    const c = get("favorites", {});
    res.json({
      enabled: !!c.enabled,
      favoriteId: c.favoriteId || "",
      intervalMinutes: c.intervalMinutes || 10,
      hasCookie: !!c.cookie,
      lastSync: get("favorite-last", null),
    });
  });
  app.post("/api/admin/favorites", admin, (req, res) => {
    set("favorites", favoriteConfig(req.body, get("favorites", {})));
    res.json({ ok: true });
  });
  app.post("/api/admin/favorites/sync", admin, (req, res) =>
    res.json({ id: addJob("favorite-sync", {}) }),
  );
}
