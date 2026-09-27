import React, { useEffect, useRef, useState } from "react";
import { CloudSettings } from "./settings.jsx";
import "./separation-settings.css";

async function request(path, body) {
  const response = await fetch("/api/admin/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + sessionStorage.getItem("adminToken"),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "读取分离服务失败");
  return data;
}
const names = { pc: "PC 分离器", npu: "NAS NPU", cpu: "NAS CPU" };
const descriptions = {
  pc: "优先使用已连接的电脑。首次连接需要在 PC 整理器本机确认配对码。",
  npu: "电脑不可用时使用 Intel NPU；设备与模型匹配成功后自动接手。",
  cpu: "前面的服务不可用时，由 NAS 自己处理。速度较慢，可留在后台完成。",
};
export function SeparationSettings() {
  const [data, setData] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let live = true,
      timer;
    async function read() {
      const version = generation.current;
      try {
        const next = await request("separation");
        if (live && version === generation.current) setData(next);
      } catch (e) {
        if (live) setError(e.message);
      }
      if (live) timer = setTimeout(read, 5000);
    }
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  async function change(patch) {
    const previous = data.config;
    setData((old) => ({ ...old, config: { ...old.config, ...patch } }));
    setBusy(true);
    setError("");
    setMessage("");
    generation.current++;
    try {
      const result = await request("separation", patch);
      setData((old) => ({ ...old, config: result.config }));
      setMessage("设置已保存，正在执行的任务会继续完成。");
    } catch (e) {
      setData((old) => ({ ...old, config: previous }));
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="separation-settings">
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p role="status">正在检测分离服务…</p>
      ) : (
        <>
          <section className="settings-card separation-overview">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={data.config.enabled}
                disabled={busy}
                onChange={(e) => change({ enabled: e.target.checked })}
              />
              自动分离伴奏
            </label>
            <p>
              PC → NPU → CPU。前面的服务不可用或处理失败时，自动尝试下一项。
            </p>
            <p className="muted">
              已有连接和模型配置会继续使用。这里的开关影响后续任务。
            </p>
          </section>
          <div className="separation-providers">
            {data.providers.map((provider, index) => (
              <section
                className="settings-card separation-provider"
                key={provider.kind}
              >
                <div className="separation-provider-heading">
                  <span className="separation-order">{index + 1}</span>
                  <h2>{names[provider.kind]}</h2>
                </div>
                <span
                  className={
                    "separation-state " + (provider.ready ? "ready" : "waiting")
                  }
                >
                  {provider.ready
                    ? provider.busy
                      ? `正在处理 · ${provider.pending} 项`
                      : "已就绪"
                    : "未就绪"}
                </span>
                <p>{descriptions[provider.kind]}</p>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={!!data.config[provider.kind + "Enabled"]}
                    disabled={busy}
                    onChange={(e) =>
                      change({ [provider.kind + "Enabled"]: e.target.checked })
                    }
                  />
                  启用{names[provider.kind]}
                </label>
                <small>
                  {provider.ready
                    ? `${provider.source}${provider.device ? " · " + provider.device : ""}`
                    : provider.message}
                </small>
                {provider.kind === "pc" && (
                  <div className="separation-discovery">
                    <p role="status">{data.discovery?.message}</p>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={data.config.autoDiscover}
                        disabled={busy}
                        onChange={(e) =>
                          change({ autoDiscover: e.target.checked })
                        }
                      />
                      自动发现 PC
                    </label>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await request("ai/discover", {});
                          setMessage(
                            "已开始查找 PC，连接成功后会自动更新状态。",
                          );
                        } catch (e) {
                          setError(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      重新查找 PC
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            "清除已记住的 PC 连接？随后需在 PC 本机重新确认配对。",
                          )
                        )
                          return;
                        setBusy(true);
                        setError("");
                        try {
                          await request("ai/pc", {
                            clearPcKey: true,
                            pcEndpoint: "",
                            autoDiscover: true,
                          });
                          setMessage(
                            "请核对这里显示的配对码，并在 PC 整理器本机确认。",
                          );
                        } catch (e) {
                          setError(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      重新配对 PC
                    </button>
                  </div>
                )}
              </section>
            ))}
          </div>
          {message && <p role="status">{message}</p>}
          {!data.config.managed && !data.config.embedded && (
            <p>
              使用 NAS 安装包中的 Compose 启动本机分离容器后，CPU 和 NPU
              会自动连接。
            </p>
          )}
          <details className="settings-card">
            <summary>高级：外部备用 API</summary>
            <CloudSettings />
          </details>
        </>
      )}
    </div>
  );
}
