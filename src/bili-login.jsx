import React, { useEffect, useState } from "react";
export function BiliLogin({
  request,
  notify,
  onLogin,
  canLogin = true,
  compact = false,
  scope = "online",
  title = "B 站登录与高清下载",
  description = "",
  refreshKey,
}) {
  const [account, setAccount] = useState(null),
    [qr, setQr] = useState(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function check() {
    try {
      setAccount(
        await request(
          canLogin
            ? "/admin/bilibili/status?scope=" + scope
            : "/online/bilibili/status",
        ),
      );
    } catch (e) {
      setMessage(e.message);
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
            "在线找歌、预览和在线下载使用此账号；收藏夹自动下载另有独立登录，互不影响。最高画质按账号权限和原视频下载，支持 480p 等老 MV，不设最低 720p 限制。部分超清画质需要大会员，原视频也需要提供该画质。"}
        </p>
      )}
      {canLogin && account?.loggedIn && (
        <p className="muted">
          {account.autoRefresh
            ? "已启用登录凭证自动维护"
            : "当前凭证没有刷新令牌；重新扫码可启用自动维护"}
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
                const result = await request(
                  "/admin/bilibili/qr",
                  { scope },
                  "POST",
                );
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
    </div>
  );
}
