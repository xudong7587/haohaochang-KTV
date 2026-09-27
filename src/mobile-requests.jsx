import React, { useEffect, useState } from "react";
import { api } from "./api.js";
const stages = {
  download: "准备下载",
  downloading: "下载视频",
  clipping: "裁剪视频",
  import: "整理入库",
  separate: "分离伴奏",
  separating: "分离伴奏",
  prepare: "转换播放资源",
  "preparing-video": "转换画面",
  "preparing-audio": "转换音轨",
  "waiting-worker": "等待处理设备",
  queued: "等待处理",
  running: "正在处理",
};
export function MobileRequests({ revision = 0 }) {
  const [current, setCurrent] = useState(null);
  const [dismissed, setDismissed] = useState(() => new Set());
  useEffect(() => {
    let live = true,
      timer;
    async function read() {
      try {
        const data = await api("/requests/status");
        if (live)
          setCurrent(
            data.find(
              (row) =>
                [
                  "running",
                  "queued",
                  "waiting-worker",
                  "failed",
                  "review",
                ].includes(row.status) &&
                !dismissed.has(row.id + ":" + row.status),
            ) || null,
          );
      } catch {
        if (live) setCurrent(null);
      } finally {
        if (live) timer = setTimeout(read, 3000);
      }
    }
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [revision, dismissed]);
  if (!current) return null;
  const terminal = ["failed", "review"].includes(current.status);
  const percent = Number.isFinite(current.percent)
    ? current.percent
    : undefined;
  const stage =
    current.message ||
    current.progressLabel ||
    stages[current.stage] ||
    stages[current.status] ||
    "正在处理";
  return (
    <div
      className="online-current-progress"
      role="status"
      aria-label="当前找歌进度"
    >
      <span className="online-progress-song" title={current.title}>
        {current.title}
      </span>
      <span>{stage}</span>
      {!terminal && <progress max="100" value={percent} aria-label={stage} />}
      {!terminal && percent !== undefined && (
        <small>{Math.round(percent)}%</small>
      )}
      {terminal && (
        <button
          aria-label="关闭任务提示"
          onClick={() => {
            setDismissed(
              (previous) =>
                new Set([...previous, current.id + ":" + current.status]),
            );
            setCurrent(null);
          }}
        >
          关闭
        </button>
      )}
    </div>
  );
}
