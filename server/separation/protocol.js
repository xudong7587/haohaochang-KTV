import {
  taskFetch,
  taskDelay,
  checkTaskCancellation,
} from "../task-cancellation.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { connectionError } from "../connection-error.js";

export const providerHeaders = (config) =>
  config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
export async function checkProvider(config, timeout = 15000) {
  if (!config.endpoint) throw new Error("请先填写分离服务地址");
  const response = await taskFetch(`${config.endpoint}/health`, {
    headers: providerHeaders(config),
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  if (!response.ok)
    throw Object.assign(new Error(`分离服务检测失败 (${response.status})`), {
      status: response.status,
    });
  const data = await response.json();
  if (data.protocol !== "ktv-separation-v1")
    throw Object.assign(
      new Error("服务不是 ktv-separation-v1 协议，请部署适配器"),
      { code: "INVALID_PROTOCOL" },
    );
  if (
    config.cpu &&
    (data.backend !== "demucs" ||
      data.device !== "cpu" ||
      !data.models?.includes("htdemucs"))
  )
    throw new Error("主容器内置 CPU 分离服务未就绪，请检查容器日志");
  if (
    config.npu &&
    (data.backend !== "openvino-npu" ||
      data.ready !== true ||
      !data.models?.includes("htdemucs"))
  )
    throw new Error(
      data.qualification?.message || "NPU 服务未完成设备与模型匹配",
    );
  return data;
}
export async function testProvider(config) {
  if (!config.endpoint)
    throw new Error(
      "尚未填写服务地址，也未发现 PC。请先启动整理器或填写手动地址。",
    );
  try {
    const data = await checkProvider(config);
    return {
      ok: true,
      protocol: data.protocol,
      endpoint: config.endpoint,
      ...(config.npu ? { qualification: data.qualification } : {}),
    };
  } catch (error) {
    if (config.npu)
      throw Object.assign(new Error(error.message), { status: 502 });
    throw Object.assign(new Error(connectionError(error, "服务").message), {
      status: 502,
    });
  }
}
const validId = (id) => /^[a-zA-Z0-9_-]{1,100}$/.test(id || "");
function checkpointName(song, config) {
  const providerId = createHash("sha256")
    .update(config.endpoint + "\n" + config.model)
    .digest("hex")
    .slice(0, 20);
  return `separation:${song.id}:${providerId}`;
}
export function hasProviderCheckpoint(store, song, config) {
  return !!store.get(checkpointName(song, config));
}
export function resumeCandidates(store, song, candidates) {
  // Finish an already submitted job before starting another provider's work.
  const priority = (config) => {
    const checkpoint = store.get(checkpointName(song, config));
    if (
      checkpoint?.result &&
      ["running", "queued", "done"].includes(checkpoint.result.status)
    )
      return 2;
    return checkpoint ? 1 : 0;
  };
  return [...candidates].sort((a, b) => priority(b) - priority(a));
}
async function fingerprint(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    checkTaskCancellation();
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function saveResult(
  value,
  config,
  target,
  { video = false, validation } = {},
) {
  let url;
  try {
    url = new URL(value, config.endpoint + "/");
  } catch {
    throw Object.assign(new Error("分离结果 URL 无效"), { terminal: true });
  }
  if (
    url.origin !== new URL(config.endpoint).origin ||
    url.username ||
    url.password
  )
    throw Object.assign(new Error("分离结果必须由配置的服务同源提供"), {
      terminal: true,
    });
  const response = await taskFetch(url, {
    headers: providerHeaders(config),
    signal: AbortSignal.timeout(300000),
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw Object.assign(new Error(`分离结果下载失败 (${response.status})`), {
      terminal: response.status === 404 || response.status === 410,
    });
  let total = 0;
  const maximum = (video ? 4 : 1) * 1024 ** 3;
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel();
    throw new Error(`${video ? "PC画面" : "分离"}结果超过 ${video ? 4 : 1} GB`);
  }
  const hash = createHash("sha256");
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      hash.update(chunk);
      callback(
        total > maximum
          ? new Error(
              `${video ? "PC画面" : "分离"}结果超过 ${video ? 4 : 1} GB`,
            )
          : null,
        chunk,
      );
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    limit,
    createWriteStream(target),
  );
  const digest = hash.digest("hex");
  if (
    validation?.decoded === true &&
    /^[a-f0-9]{64}$/.test(validation.sha256 || "")
  ) {
    if (validation.sha256 !== digest)
      throw new Error("PC画面传输校验失败，文件与完整解码结果不一致");
    return true;
  }
  return false;
}

export async function runProviderJob(
  store,
  song,
  vocal,
  staging,
  config,
  {
    pollInterval = 3000,
    clip,
    videoOnly = false,
    videoInfo,
    maxVideoBytes = 1024 ** 3,
  } = {},
) {
  const maximum = clip
    ? Math.min(4 * 1024 ** 3, Math.max(1024 ** 3, Number(maxVideoBytes) || 0))
    : 100 * 1024 ** 2;
  if ((await stat(vocal)).size > maximum)
    throw new Error(
      clip
        ? `待处理视频超过整理器的 ${maximum / 1024 ** 3} GB 上限`
        : "待分离音频超过 100 MB",
    );
  const signature = await fingerprint(vocal);
  const checkpointKey = checkpointName(song, config);
  let checkpoint = store.get(checkpointKey);
  if (!checkpoint || checkpoint.signature !== signature) {
    checkpoint = { signature, requestId: randomUUID(), created: Date.now() };
    // Persist before uploading; upgraded v1 adapters deduplicate even a lost POST response.
    store.set(checkpointKey, checkpoint);
  }
  let result = checkpoint.result;
  if (!result) {
    const form = new FormData();
    form.set(
      "file",
      await openAsBlob(vocal, { type: clip ? "video/mp4" : "audio/mp4" }),
      clip ? "input.mp4" : "input.m4a",
    );
    form.set("model", config.model);
    if (clip) {
      if (videoOnly) form.set("video_only", "true");
      if (videoInfo) {
        form.set("video_height", String(videoInfo.height || 1080));
        form.set("video_fps", String(videoInfo.videoFps || 30));
        if (["smpte2084", "arib-std-b67"].includes(videoInfo.colorTransfer))
          form.set("video_transfer", videoInfo.colorTransfer);
      }
      form.set("start", String(clip.start));
      form.set("end", String(clip.end));
    }
    form.set("title", `${song.artist} - ${song.title}`);
    const response = await taskFetch(
      `${config.endpoint}/${clip ? "clip" : "separate"}`,
      {
        method: "POST",
        headers: {
          ...providerHeaders(config),
          "Idempotency-Key": checkpoint.requestId,
        },
        body: form,
        signal: AbortSignal.timeout(120000),
        redirect: "error",
      },
    );
    if (!response.ok)
      throw Object.assign(
        new Error(`AI ${clip ? "裁剪" : "分离"}请求失败 (${response.status})`),
        { retryable: response.status >= 500 || response.status === 429 },
      );
    result = await response.json();
    checkpoint.result = result;
    store.set(checkpointKey, checkpoint);
  }
  const deadline = Date.now() + (config.cpu ? 6 * 60 * 60 * 1000 : 1800000);
  let firstPoll = true;
  while (result.status === "queued" || result.status === "running") {
    if (!validId(result.id)) {
      store.set(checkpointKey, null);
      throw new Error("分离服务返回了无效任务 ID");
    }
    if (Date.now() > deadline)
      throw new Error(
        `${config.cpu ? "NAS CPU 分离超过 6 小时" : "AI 处理超过 30 分钟"}，请在后台重试；将继续查询原任务`,
      );
    if (!firstPoll) await taskDelay(pollInterval);
    firstPoll = false;
    const poll = await taskFetch(`${config.endpoint}/jobs/${result.id}`, {
      headers: providerHeaders(config),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!poll.ok) {
      if (poll.status === 404 || poll.status === 410)
        store.set(checkpointKey, null);
      throw Object.assign(new Error(`任务查询失败 (${poll.status})`), {
        retryable: poll.status >= 500 || poll.status === 429,
      });
    }
    const next = await poll.json();
    if (next.id && next.id !== result.id) {
      store.set(checkpointKey, null);
      throw new Error("分离服务返回了不匹配的任务 ID");
    }
    result = { ...next, id: result.id };
    checkpoint.result = result;
    store.set(checkpointKey, checkpoint);
  }
  const resultUrl = clip ? result.video_url : result.instrumental_url;
  if (result.status !== "done" || !resultUrl) {
    store.set(checkpointKey, null);
    throw new Error(
      "AI 分离失败：" + String(result.error || "缺少伴奏结果").slice(0, 300),
    );
  }
  const file = path.join(staging, clip ? "clip.mp4" : "backing.wav");
  let validated = false;
  try {
    validated = await saveResult(resultUrl, config, file, {
      video: !!clip,
      validation: clip ? result.validation : undefined,
    });
  } catch (error) {
    if (error.terminal) store.set(checkpointKey, null);
    throw error;
  }
  return {
    file,
    checkpointKey,
    async acknowledge() {
      // Best effort, after local validation; old workers retain their original
      // protocol. A failed acknowledgement leaves the full retention window.
      try {
        await taskFetch(`${config.endpoint}/jobs/${result.id}/ack`, {
          method: "POST",
          headers: providerHeaders(config),
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
      } catch {}
    },
    vocalActivity: result.vocal_activity,
    validated,
  };
}
