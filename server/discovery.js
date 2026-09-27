import dgram from "node:dgram";
import os from "node:os";
import { randomUUID, createHmac } from "node:crypto";
import { equal } from "./http-utils.js";

export const privateIPv4 = (ip) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) &&
  ip.split(".").length === 4 &&
  ip.split(".").every((n) => /^\d+$/.test(n) && +n <= 255);
export function broadcastAddresses(interfaces = os.networkInterfaces()) {
  const values = new Set(["255.255.255.255"]);
  for (const rows of Object.values(interfaces))
    for (const row of rows || []) {
      if (row.internal || row.family !== "IPv4" || !privateIPv4(row.address))
        continue;
      const mask = row.netmask.split(".").map(Number);
      values.add(
        row.address
          .split(".")
          .map((n, i) => +n | (~mask[i] & 255))
          .join("."),
      );
    }
  return [...values];
}
export function startDiscovery(
  { store, work, emit, enabled = false },
  { createSocket = dgram.createSocket, fetcher = fetch } = {},
) {
  const initial = store.get("ai", {});
  if (enabled && initial.autoDiscover !== false && initial.pcEndpoint) {
    try {
      if (
        ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(initial.pcEndpoint).hostname,
        )
      )
        store.set("ai", { ...initial, pcEndpoint: "" });
    } catch {}
  }
  let socket,
    timer,
    stopped = false,
    nonce = "",
    busy = false;
  let state = {
    enabled,
    status: enabled ? "searching" : "disabled",
    message: enabled
      ? "正在寻找局域网 PC"
      : "自动发现未启动；Docker 请使用统一 host 配置",
  };
  const info = () => ({ ...state, worker: store.get("pc-worker", null) });
  async function accept(data, remote) {
    if (
      stopped ||
      !nonce ||
      data.length > 2048 ||
      busy ||
      !privateIPv4(remote.address) ||
      store.get("ai", {}).autoDiscover === false
    )
      return;
    let packet;
    try {
      packet = JSON.parse(data);
    } catch {
      return;
    }
    if (
      !packet ||
      typeof packet !== "object" ||
      Array.isArray(packet) ||
      packet.protocol !== "haohaochang-lan-v1" ||
      packet.nonce !== nonce ||
      !/^[\w-]{16,100}$/.test(packet.challenge || "") ||
      !/^[\w-]{8,100}$/.test(packet.id || "") ||
      !Number.isInteger(packet.port) ||
      packet.port < 1 ||
      packet.port > 65535
    )
      return;
    busy = true;
    try {
      if (packet.securePairing !== 2)
        throw new Error("请更新 PC 整理器后在本机确认首次配对");
      const configured = store.get("ai", {});
      const clientId = store.get("pc-client-id") || randomUUID();
      store.set("pc-client-id", clientId);
      const key = configured.pcApiKey;
      if (
        key &&
        !equal(
          packet.proof,
          createHmac("sha256", key)
            .update(packet.nonce + "\n" + packet.challenge + "\n" + packet.id)
            .digest("hex"),
        )
      )
        throw new Error(
          "PC 身份校验失败；如已撤销连接，请清除旧 PC 密钥并重新确认配对",
        );
      const endpoint = `http://${remote.address}:${packet.port}`;
      const result = await fetcher(endpoint + "/lan/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge: packet.challenge,
          clientId,
          ...(key
            ? {
                proof: createHmac("sha256", key)
                  .update(packet.challenge + "\n" + clientId)
                  .digest("hex"),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!result.ok) {
        const detail = await result.json().catch(() => ({}));
        throw new Error(
          String(detail.detail || "PC 配对暂未完成").slice(0, 160),
        );
      }
      const paired = await result.json();
      if (stopped) return;
      if (
        !paired ||
        paired.id !== packet.id ||
        typeof paired.key !== "string" ||
        paired.key.length < 16 ||
        paired.key.length > 200
      )
        throw new Error("PC 配对响应无效");
      const old = store.get("ai", {});
      if (old.autoDiscover === false) return;
      // Keep the selected live worker stable on networks with several PCs.
      const known = store.get("pc-worker", {}) || {};
      if (
        known.id &&
        known.id !== packet.id &&
        Date.now() - known.lastSeen < 45000
      )
        return;
      store.set("ai", {
        ...old,
        enabled: old.enabled ?? true,
        autoDiscover: true,
        pcEndpoint: endpoint,
        pcApiKey: paired.key,
        pcModel: old.pcModel || "htdemucs",
      });
      store.set("pc-worker", {
        id: packet.id,
        name: String(packet.name || "PC").slice(0, 100),
        endpoint,
        lastSeen: Date.now(),
      });
      state = { enabled, status: "connected", message: "PC 已自动连接" };
      store.db
        .prepare(
          "UPDATE jobs SET status='queued',error='' WHERE status='waiting-worker'",
        )
        .run();
      work();
      emit("library", {});
    } catch (error) {
      if (!stopped)
        state = { enabled, status: "searching", message: error.message };
    } finally {
      busy = false;
    }
  }
  function scan() {
    if (!socket || stopped) return;
    if (store.get("ai", {}).autoDiscover === false) {
      state.status = "manual";
      return;
    }
    if (Date.now() - (store.get("pc-worker", {})?.lastSeen || 0) > 45000)
      state = {
        enabled,
        status: "searching",
        message: "等待局域网 PC 整理器上线",
      };
    nonce = randomUUID();
    const body = Buffer.from(
      JSON.stringify({ protocol: "haohaochang-lan-v1", nonce }),
    );
    for (const target of broadcastAddresses())
      socket.send(body, 43211, target, () => {});
  }
  if (enabled) {
    socket = createSocket("udp4");
    socket.on("message", accept);
    socket.on("error", () => {
      state = {
        enabled,
        status: "error",
        message: "自动发现网络不可用，请检查 host 网络配置",
      };
    });
    socket.bind(0, "0.0.0.0", () => {
      if (stopped) return;
      socket.setBroadcast(true);
      scan();
      timer = setInterval(scan, 15000);
      timer.unref();
    });
    socket.unref();
  }
  return {
    info,
    scan,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
    },
  };
}
