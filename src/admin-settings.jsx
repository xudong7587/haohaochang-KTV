import { TaskList } from "./task-list.jsx";
import { TaskActions } from "./task-actions.jsx";
import React, { useState, useEffect, useRef } from "react";
import { BackgroundSettings } from "./background-settings.jsx";
import { HardDrive, Check, RefreshCw } from "lucide-react";
import { api, setAdminToken, acceptLogin } from "./api.js";
import { LyricsSettings } from "./library-manager.jsx";
import { Automation } from "./automation.jsx";
import { Organize } from "./organize.jsx";
export function Settings({ admin, attempt, refresh }) {
  const [url, setUrl] = useState(admin.publicUrl),
    [online, setOnline] = useState(admin.onlineEnabled);
  const [section, setSection] = useState("tasks");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const timer = setInterval(() => refreshRef.current(), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>设置与任务</h1>
          <p>查看处理进度，按功能管理你的歌房。</p>
        </div>
      </div>
      <div className="stats">
        <div>
          <HardDrive />
          <strong>{admin.songs}</strong>
          <span>已收录歌曲</span>
        </div>
        <div>
          <Check />
          <strong>{admin.ready}</strong>
          <span>可立即点播</span>
        </div>
        <div>
          <RefreshCw />
          <strong>
            {
              admin.jobs.filter((j) =>
                ["queued", "running", "waiting-worker"].includes(j.status),
              ).length
            }
          </strong>
          <span>后台任务</span>
        </div>
      </div>
      <nav className="settings-nav" aria-label="设置功能板块">
        {[
          ["tasks", "后台任务"],
          ["media", "媒体与导入"],
          ["online", "在线资源"],
          ["metadata", "资料与歌词"],
          ["display", "播放画面"],
          ["connection", "连接地址"],
          ["security", "管理密码"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={section === id ? "active" : ""}
            aria-pressed={section === id}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div hidden={section !== "security"}>
        <form
          className="settings-card"
          onSubmit={async (event) => {
            event.preventDefault();
            if (newPassword.length < 6) return;
            const changed = await attempt(() =>
              api(
                "/admin/password",
                { currentPassword, newPassword },
                "POST",
                true,
              ),
            );
            if (!changed) return;
            setAdminToken(newPassword);
            const login = await attempt(() => api("/login", {}, "POST", true));
            if (login) acceptLogin(login.token);
            setCurrentPassword("");
            setNewPassword("");
            if (login) attempt(() => Promise.resolve(), "管理密码已更新");
          }}
        >
          <h3>修改管理密码</h3>
          <label>
            当前密码
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </label>
          <label>
            新密码（至少 6 位）
            <input
              type="password"
              autoComplete="new-password"
              minLength={6}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>
          <button className="primary">保存新密码</button>
        </form>
      </div>
      <div hidden={section !== "media"}>
        <section className="settings-card">
          <h3>NAS 媒体目录</h3>
          {admin.scanProgress && (
            <p>
              最近扫描：{admin.scanProgress.running ? "扫描中" : "已结束"}
              ，已检查 {admin.scanProgress.checked} 个媒体，新增{" "}
              {admin.scanProgress.added} 首，读取失败{" "}
              {admin.scanProgress.errors.length} 个。
            </p>
          )}
          {admin.roots.map((r) => (
            <code key={r}>{r}</code>
          ))}
          <p>
            正式曲库需要写入权限以保存整理后的文件，成功的播放版本长期保存在正式曲库的「好好唱播放资源」。页面设置会自动保存为
            settings.json，重启后继续生效。
          </p>
          <button
            onClick={() =>
              attempt(
                () => api("/admin/scan", {}, "POST", true),
                "扫描已加入任务",
              )
            }
          >
            <RefreshCw size={17} />
            扫描曲库
          </button>
        </section>
      </div>
      <div hidden={section !== "display"}>
        <BackgroundSettings
          request={(url, body, method) => api(url, body, method, true)}
          notify={(text) => attempt(() => Promise.resolve(), text)}
        />
      </div>
      <div hidden={section !== "metadata"}>
        <LyricsSettings
          request={(url, body, method) => api(url, body, method, true)}
          notify={(text) => attempt(() => Promise.resolve(), text)}
        />
      </div>
      <div hidden={!["online", "metadata"].includes(section)}>
        <Automation
          section={section}
          request={(url, body, method) => api(url, body, method, true)}
          notify={(text) => attempt(() => Promise.resolve(), text)}
        />
      </div>
      <div hidden={section !== "media"}>
        <Organize
          request={(url, body, method) => api(url, body, method, true)}
          notify={(text) => attempt(() => Promise.resolve(), text)}
          refresh={refresh}
          downloads={admin.downloads}
          autoImport={admin.autoImport}
        />
      </div>
      <div hidden={!["online", "connection"].includes(section)}>
        <form
          className="settings-card"
          onSubmit={async (e) => {
            e.preventDefault();
            await attempt(
              () =>
                api(
                  "/admin/settings",
                  section === "online"
                    ? { onlineEnabled: online }
                    : { publicUrl: url },
                  "POST",
                  true,
                ),
              section === "online"
                ? "在线搜索设置已保存"
                : "连接地址已保存，重新打开电视以更新二维码",
            );
            refresh();
          }}
        >
          <h3>{section === "online" ? "在线搜索" : "连接地址"}</h3>
          <div hidden={section !== "connection"}>
            <label>
              NAS 访问地址（内网或 HTTPS 反代）
              <input
                placeholder="https://ktv.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={section !== "connection"}
                type="url"
              />
            </label>
            <p>
              可填写 http://NAS-IP:3210 或
              https://ktv.example.com；留空时二维码跟随当前页面地址。使用独立域名，不要附加
              /admin、/tv 等路径。TV APK 填写同一地址，使用管理密码登录。
            </p>
          </div>
          <div hidden={section !== "online"}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={online}
                onChange={(e) => setOnline(e.target.checked)}
              />
              启用 Bilibili / YouTube 在线搜索与入库
            </label>
            <p>
              仅导入你有权保存和使用的资源。平台限制或网络问题会显示在任务记录中。
            </p>
          </div>
          <button className="primary">保存设置</button>
        </form>
      </div>
      <div hidden={section !== "tasks"}>
        <section className="settings-card">
          <div className="section-heading">
            <h3>后台任务</h3>
            <button aria-label="刷新任务" onClick={refresh}>
              <RefreshCw size={17} />
            </button>
          </div>
          <TaskList
            jobs={admin.jobs}
            label="后台任务"
            actions={(job) => (
              <TaskActions
                job={job}
                request={(url, body, method) => api(url, body, method, true)}
                refresh={refresh}
              />
            )}
          />
        </section>
      </div>
    </>
  );
}
