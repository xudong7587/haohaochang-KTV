import { taskStatus } from "../task-status.js";
import { providerHeaders } from "../separation/protocol.js";
import { connectionError } from "../connection-error.js";

const clipText = (v, max = 240) => String(v ?? "").slice(0, max);
const updateStatus = (v) =>
  v && typeof v === "object"
    ? Object.fromEntries(
        ["phase", "current", "latest", "progress", "error"]
          .filter((k) => k in v)
          .map((k) => [
            k,
            k === "progress"
              ? Math.max(0, Math.min(100, Number(v[k]) || 0))
              : clipText(v[k], 400),
          ]),
      )
    : null;
export function pcApi({ app, admin, store, discovery }) {
  let pending;
  async function status() {
    const config = store.get("ai", {});
    const tasks = taskStatus(store);
    const base = {
      connected: false,
      endpoint: config.pcEndpoint || "",
      checkedAt: Date.now(),
      discovery: discovery.info(),
      tasks,
      resourceCleanup: store.get("resource-cleanup", null),
      downloadCleanup: store.get("download-cleanup", null),
      worker: null,
    };
    if (!config.pcEndpoint)
      return {
        ...base,
        status: "unconfigured",
        message:
          config.autoDiscover !== false && !discovery.info().enabled
            ? "未连接：当前 NAS 没有启用局域网发现。请使用 LAN 部署配置，或直接填写手动 PC 地址。"
            : "未连接：尚未获得 PC 地址。请启动整理器并等待发现，或填写手动 PC 地址。",
      };
    try {
      const response = await fetch(config.pcEndpoint + "/desktop/status", {
        headers: providerHeaders({ apiKey: config.pcApiKey }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok)
        throw Object.assign(new Error("PC 状态暂不可用"), {
          status: response.status,
        });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 512 * 1024) throw new Error("PC 状态响应过大");
        chunks.push(Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(data.jobs) || !data.memory)
        throw Object.assign(new Error("请更新 PC 整理器"), {
          code: "INVALID_PROTOCOL",
        });
      const jobs = data.jobs
        .slice(0, 60)
        .map((j) =>
          Object.fromEntries(
            [
              "id",
              "title",
              "model",
              "status",
              "stage",
              "error",
              "created",
              "updated",
              "elapsed_seconds",
              "model_progress",
              "log",
            ]
              .filter((k) => k in j)
              .map((k) => [
                k,
                typeof j[k] === "number"
                  ? j[k]
                  : clipText(j[k], k === "log" ? 5000 : 300),
              ]),
          ),
        );
      for (const [index, job] of jobs.entries()) {
        const progress = data.jobs[index]?.media_progress;
        if (progress && Number.isFinite(progress.percent))
          job.media_progress = {
            label: clipText(progress.label, 50),
            percent: Math.max(0, Math.min(100, progress.percent)),
          };
      }
      const worker = {
        update: updateStatus(data.update),
        version: clipText(data.version || "旧版（未报告版本）"),
        name: clipText(data.name),
        concurrency: Number(data.concurrency) || 1,
        device: clipText(data.device),
        gpu_name: clipText(data.gpu_name),
        runtime: clipText(data.runtime),
        model: clipText(data.model),
        cpu: Number(data.cpu) || 0,
        uptime: Number(data.uptime) || 0,
        memory: {
          used_gb: Number(data.memory.used_gb) || 0,
          total_gb: Number(data.memory.total_gb) || 0,
          percent: Number(data.memory.percent) || 0,
        },
        gpu: data.gpu
          ? {
              utilization:
                data.gpu.utilization == null
                  ? null
                  : Number(data.gpu.utilization),
              encoder:
                data.gpu.encoder == null ? null : Number(data.gpu.encoder),
              decoder:
                data.gpu.decoder == null ? null : Number(data.gpu.decoder),
              busiest:
                data.gpu.busiest == null ? null : Number(data.gpu.busiest),
              used_mb: Number(data.gpu.used_mb) || 0,
              total_mb: Number(data.gpu.total_mb) || 0,
            }
          : null,
        jobs,
      };
      return {
        ...base,
        connected: true,
        status: "connected",
        message: "PC 已连接，任务自动处理",
        worker,
      };
    } catch (error) {
      return {
        ...base,
        ...connectionError(error),
      };
    }
  }
  app.get("/api/admin/pc/status", admin, async (_req, res) => {
    pending ||= status().finally(() => {
      pending = null;
    });
    res.set("Cache-Control", "no-store").json(await pending);
  });
  app.post("/api/admin/pc/update/:action", admin, async (req, res) => {
    if (!["check", "install", "cancel"].includes(req.params.action))
      return res.status(404).json({ error: "未知更新操作" });
    const config = store.get("ai", {});
    if (!config.pcEndpoint)
      return res.status(409).json({ error: "请先连接 PC 整理器" });
    try {
      const response = await fetch(
        config.pcEndpoint + "/desktop/update/" + req.params.action,
        {
          method: "POST",
          headers: {
            ...providerHeaders({ apiKey: config.pcApiKey }),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ version: clipText(req.body.version, 32) }),
          redirect: "error",
          signal: AbortSignal.timeout(40000),
        },
      );
      if (response.status === 404)
        return res
          .status(409)
          .json({
            error: "旧版整理器没有更新入口，请先手动安装 v0.3.10 或更新版本",
          });
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 16384) throw new Error("更新响应过大");
        chunks.push(Buffer.from(chunk));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res
        .set("Cache-Control", "no-store")
        .status(response.ok ? 200 : 409)
        .json(
          response.ok
            ? updateStatus(value)
            : { error: clipText(value.detail || "更新操作失败", 400) },
        );
    } catch {
      res.status(502).json({ error: "PC 更新服务暂不可用，请稍后重试" });
    }
  });
  app.get("/api/admin/pc/logs", admin, async (_req, res) => {
    const report = await status();
    report.scan = store.get("scan-progress", null);
    const secrets = [
      store.get("favorites", {}).cookie,
      ...Object.values(store.get("favorites", {}).credentials || {}),
      store.get("ai", {}).apiKey,
      store.get("ai", {}).pcApiKey,
      store.get("enrichment", {}).apiKey,
    ].filter(Boolean);
    const output = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        scope:
          "最近 200 条 NAS 任务与最近 40 条 PC 任务；PC 日志每条最多 5000 字符",
        ...report,
      },
      (_key, value) =>
        typeof value === "string"
          ? secrets.reduce(
              (text, secret) => text.split(secret).join("[已隐藏]"),
              value,
            )
          : value,
      2,
    );
    res
      .set("Cache-Control", "no-store")
      .attachment("haohaochang-diagnostics.json")
      .type("json")
      .send(output);
  });
}
