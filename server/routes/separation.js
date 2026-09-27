import { checkProvider } from "../separation/protocol.js";
import {
  providerCandidates,
  cpuConfig,
  npuConfig,
  embeddedSeparation,
  managedSeparation,
} from "../separation/providers.js";
import { fail } from "../http-utils.js";

export function separationApi({ app, admin, get, set, db, work, discovery }) {
  let cached,
    pending,
    revision = 0;
  const configuration = () => {
    const c = get("ai", {});
    return {
      enabled: !!c.enabled,
      pcEnabled: c.pcEnabled !== false,
      npuEnabled: npuConfig(c).enabled,
      cpuEnabled: cpuConfig(c).enabled,
      autoDiscover: c.autoDiscover !== false,
      embedded: embeddedSeparation(),
      managed: managedSeparation(),
    };
  };
  const probe = async () => {
    const config = get("ai", {});
    const candidates = providerCandidates({
      ...config,
      pcEnabled: true,
      npuEnabled: true,
      cpuEnabled: true,
    });
    const providers = await Promise.all(
      ["pc", "npu", "cpu"].map(async (kind) => {
        const choices = candidates.filter((c) => c[kind]);
        for (const c of choices) {
          try {
            const health = await checkProvider(c, 2500);
            return {
              kind,
              ready: true,
              busy: health.busy === true,
              pending: Number(health.pending) || 0,
              source: c.embedded
                ? "内置服务"
                : c.managed
                  ? "本机分离容器"
                  : "已有连接",
              device: String(health.device || "").slice(0, 80),
            };
          } catch {
            /* Connection details stay server-side. */
          }
        }
        return {
          kind,
          ready: false,
          busy: false,
          pending: 0,
          source: choices.some((c) => c.embedded)
            ? "内置服务"
            : managedSeparation()
              ? "本机分离容器"
              : "已有连接",
          message:
            kind === "pc"
              ? "尚未连接，请启动同一网络的 PC 整理器"
              : kind === "npu"
                ? "NPU 未就绪或未检测到，将使用 CPU"
                : "CPU 服务未就绪，请检查 separator-cpu 容器状态和日志",
        };
      }),
    );
    return {
      config: configuration(),
      providers,
      discovery: {
        enabled: !!discovery.info().enabled,
        message: discovery.info().message,
      },
    };
  };
  app.get("/api/admin/separation", admin, async (req, res) => {
    if (!cached || Date.now() - cached.at > 4000) {
      if (!pending) {
        const current = revision;
        pending = probe()
          .then((value) => {
            if (current === revision) cached = { at: Date.now(), value };
            return value;
          })
          .finally(() => {
            pending = null;
          });
      }
      const value = await pending;
      return res.json(value);
    }
    res.json(cached.value);
  });
  app.post("/api/admin/separation", admin, (req, res) => {
    const fields = [
      "enabled",
      "pcEnabled",
      "npuEnabled",
      "cpuEnabled",
      "autoDiscover",
    ];
    const patch = {};
    for (const key of fields)
      if (key in req.body) {
        if (typeof req.body[key] !== "boolean")
          throw fail(400, "开关设置格式错误");
        patch[key] = req.body[key];
      }
    // Merge only switches: preserve all legacy credentials, model choices and checkpoints.
    const config = { ...get("ai", {}), ...patch };
    set("ai", config);
    revision++;
    cached = null;
    if (patch.autoDiscover === true) discovery.scan();
    if (
      config.enabled &&
      Object.entries(patch).some(
        ([key, value]) => key !== "autoDiscover" && value,
      )
    ) {
      db.prepare(
        "UPDATE jobs SET status='queued',stage='',error='' WHERE status='waiting-worker'",
      ).run();
      work();
    }
    res.json({ ok: true, config: configuration() });
  });
}
