import React, { useEffect, useState } from "react";
const credentialFields = [
  ["sessdata", "SESSDATA"],
  ["bili_jct", "bili_jct"],
  ["buvid3", "buvid3"],
  ["dedeuserid", "DedeUserID"],
  ["ac_time_value", "ac_time_value"],
];
export function BiliLogin({
  request,
  notify,
  onLogin,
  canLogin = true,
  compact = false,
  title = "B 站登录与高清下载",
  description = "",
  refreshKey,
}) {
  const [account, setAccount] = useState(null),
    [qr, setQr] = useState(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [manual, setManual] = useState({});
  async function check() {
    try {
      setAccount(
        await request(
          canLogin ? "/admin/bilibili/status" : "/online/bilibili/status",
        ),
      );
    } catch (e) {
      setMessage(e.message);
    }
  }
  async function saveCredentials(value) {
    setBusy(true);
    try {
      await request("/admin/bilibili/credentials", value, "POST");
      setManual({});
      setMessage(value.clearCookie ? "已清除登录凭证" : "凭证已保存");
      await check();
      onLogin?.();
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    check();
  }, [refreshKey]);
  useEffect(() => {
    if (!qr) return;
    let stopped = false,
      timer;
    const poll = async () => {
      try {
        const result = await request("/admin/bilibili/qr/" + qr.id, {}, "POST");
        if (stopped) return;
        setMessage(result.message);
        if (result.status === "success") {
          setAccount(result);
          setQr(null);
          onLogin?.();
          return;
        }
        if (result.status === "expired") {
          setQr(null);
          return;
        }
      } catch (e) {
        if (!stopped) setMessage(e.message);
      }
      if (!stopped && Date.now() < qr.expires) timer = setTimeout(poll, 3500);
      else if (!stopped) {
        setQr(null);
        setMessage("二维码已过期，请重新生成");
      }
    };
    timer = setTimeout(poll, 3500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [qr]);
  return (
    <div className="settings-card">
      {!compact && <h3>{title}</h3>}
      <p>
        {account
          ? account.loggedIn
            ? `已登录：${account.name}${account.vip ? " · 大会员" : " · 普通账号"}`
            : "未登录或登录已过期，请扫码或填写下方凭证。"
          : "正在检测已保存的登录凭证…"}
      </p>
      {!compact && (
        <p>
          {description ||
            "在线找歌、预览、在线下载和收藏夹同步都使用这一份登录，只需在这里登录一次。最高画质按账号权限和原视频下载，支持 480p 等老 MV，不设最低 720p 限制；部分超清画质需要大会员，原视频也需要提供该画质。"}
        </p>
      )}
      {canLogin && account?.loggedIn && (
        <p className="muted">
          {account.autoRefresh
            ? "已启用登录凭证自动维护"
            : "当前凭证没有刷新令牌（ac_time_value）；重新扫码可启用自动维护，不填也能继续下载"}
          {["retrying", "confirm-pending"].includes(account.refreshStatus)
            ? "，维护暂未完成，将自动重试，现有登录保留。"
            : "。"}
        </p>
      )}
      <div className="actions">
        {canLogin ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await request("/admin/bilibili/qr", {}, "POST");
                setQr({
                  ...result,
                  expires: Date.now() + result.expiresIn * 1000,
                });
                setMessage("请用哔哩哔哩 App 扫码，并在手机确认");
              } catch (e) {
                notify(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            扫码登录 B 站
          </button>
        ) : (
          !account?.loggedIn && <a href="/admin#online">进入管理端扫码登录</a>
        )}
        <button type="button" onClick={check}>
          检测登录状态
        </button>
      </div>
      {qr && (
        <img src={qr.image} width="220" height="220" alt="B站登录二维码" />
      )}
      {message && <p role="status">{message}</p>}
      {canLogin && (
        <details>
          <summary>
            手动填写 bili-sync 凭证
            {account?.hasCookie === false ? "（当前未保存）" : ""}
          </summary>
          <p>
            可以逐项粘贴 bili-sync 的字段，也可以把一整条 Cookie
            粘在最后。留空的字段保留已保存的值；ac_time_value 现在不必须，留空只影响自动维护。
          </p>
          {credentialFields.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="password"
                autoComplete="new-password"
                value={manual[key] || ""}
                placeholder="留空保留已保存的值"
                onChange={(e) =>
                  setManual({ ...manual, [key]: e.target.value })
                }
              />
            </label>
          ))}
          <label>
            Cookie（可整条粘贴，优先于上面的字段）
            <input
              type="password"
              autoComplete="new-password"
              value={manual.cookie || ""}
              placeholder="SESSDATA=…; bili_jct=…; DedeUserID=…"
              onChange={(e) =>
                setManual({ ...manual, cookie: e.target.value })
              }
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => saveCredentials(manual)}
            >
              保存凭证
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => saveCredentials({ ...manual, clearCookie: true })}
            >
              清除已保存凭证
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
