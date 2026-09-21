import React, { useState, useEffect } from "react";
import { BiliLogin } from "./bili-login.jsx";
export function Automation({ request, notify, section }) {
  const [ai, setAI] = useState(null),
    [favorite, setFavorite] = useState(null),
    [reviews, setReviews] = useState([]),
    [favoriteLogin, setFavoriteLogin] = useState(0),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    request("/admin/reviews")
      .then(setReviews)
      .catch((e) => notify(e.message));
  useEffect(() => {
    request("/admin/enrichment")
      .then(setAI)
      .catch((e) => notify(e.message));
    request("/admin/favorites")
      .then(setFavorite)
      .catch((e) => notify(e.message));
    refresh();
  }, []);
  async function save(url, value) {
    setBusy(true);
    try {
      await request(url, value, "POST");
      notify("设置已保存");
      return true;
    } catch (e) {
      notify(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {(!section || section === "online") && (
        <BiliLogin
          request={request}
          notify={notify}
          scope="online"
          title="在线找歌 · B 站登录"
          description="在线搜索、预览和在线下载使用此账号。收藏夹自动下载保存另一份登录，两者分别刷新，互不影响。最高画质按账号权限和原视频下载，支持 480p 等老 MV，不设最低 720p 限制；部分超清画质需要大会员。"
        />
      )}
      {favorite && (!section || section === "online") && (
        <form
          className="settings-card"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await save("/admin/favorites", favorite)) {
              setFavoriteLogin((n) => n + 1);
              setFavorite((c) => ({
                ...c,
                hasCookie: !!c.cookie || c.hasCookie,
                cookie: "",
              }));
            }
          }}
        >
          <h3>B 站收藏夹自动下载</h3>
          <p>
            这里保存的 Cookie
            只用于收藏夹同步和下载，与在线找歌的登录相互独立。在线搜索默认启用；不必开启收藏夹自动下载。
          </p>
          <p>
            直接监控收藏夹，无需另装
            bili-sync。首次同步也会下载已有收藏，每轮最多读取 100
            条并继续分页。每首依次下载、整理和分离，PC GPU
            默认同时处理三首，在线找歌优先派发。
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={favorite.enabled}
              onChange={(e) =>
                setFavorite({ ...favorite, enabled: e.target.checked })
              }
            />
            启用自动同步
          </label>
          <label>
            收藏夹 ID 或链接
            <input
              value={favorite.favoriteId}
              onChange={(e) =>
                setFavorite({ ...favorite, favoriteId: e.target.value })
              }
              placeholder="收藏夹链接中的 fid，不是用户 UID"
            />
          </label>
          <label>
            检查间隔（分钟）
            <input
              type="number"
              min="5"
              max="1440"
              value={favorite.intervalMinutes}
              onChange={(e) =>
                setFavorite({
                  ...favorite,
                  intervalMinutes: Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            B 站 Cookie（可选，用于本人可访问的收藏夹）
            <input
              type="password"
              autoComplete="new-password"
              value={favorite.cookie || ""}
              placeholder={
                favorite.hasCookie ? "已保存，留空保留" : "公开收藏夹可先留空"
              }
              onChange={(e) =>
                setFavorite({ ...favorite, cookie: e.target.value })
              }
            />
          </label>
          <details>
            <summary>按 bili-sync 字段填写凭证</summary>
            <p>
              可从原配置逐项复制。填写这些字段后优先使用字段组；ac_time_value
              用于自动维护登录。建议本应用独立扫码；与 bili-sync
              共用同一组刷新凭证时，一端刷新会让另一端的旧凭证失效。
            </p>
            {[
              ["sessdata", "SESSDATA"],
              ["bili_jct", "bili_jct"],
              ["buvid3", "buvid3"],
              ["dedeuserid", "DedeUserID"],
              ["ac_time_value", "ac_time_value"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={favorite[key] || ""}
                  placeholder="已保存字段留空保留"
                  onChange={(e) =>
                    setFavorite({ ...favorite, [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </details>
          <div className="modal-actions">
            <button className="primary" disabled={busy}>
              保存设置
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => save("/admin/favorites/sync", {})}
            >
              立即同步已保存的收藏夹
            </button>
          </div>
        </form>
      )}
      {favorite && (!section || section === "online") && (
        <BiliLogin
          request={request}
          notify={notify}
          scope="favorites"
          title="收藏夹自动下载 · B 站登录"
          description="用收藏夹所属账号扫码登录；同步和下载使用这份登录，与在线找歌分别保存、分别刷新。收藏夹属于其他账号或公开可见时，也可以只填写上面的 Cookie 或凭证字段。"
          refreshKey={favoriteLogin}
          onLogin={() => {
            setFavoriteLogin((n) => n + 1);
            request("/admin/favorites")
              .then(setFavorite)
              .catch((e) => notify(e.message));
          }}
        />
      )}
      {ai && (!section || section === "metadata") && (
        <form
          className="settings-card"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await save("/admin/enrichment", ai))
              setAI((c) => ({
                ...c,
                hasKey: !!c.apiKey || c.hasKey,
                apiKey: "",
              }));
          }}
        >
          <h3>AI 歌曲信息识别与刮削</h3>
          <p>
            发送歌曲标题和现有资料，识别歌手、歌名及标签。支持 OpenAI Responses
            或 Chat Completions JSON
            接口；这个密钥不用于音频分离。无法确认的结果进入待核对，人工信息优先。
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ai.enabled}
              onChange={(e) => setAI({ ...ai, enabled: e.target.checked })}
            />
            下载后自动 AI 整理
          </label>
          <label>
            接口格式
            <select
              value={ai.protocol || "responses"}
              onChange={(e) =>
                setAI({ ...ai, protocol: e.target.value, webSearch: false })
              }
            >
              <option value="responses">Responses API</option>
              <option value="chat">
                Chat Completions · JSON（国内模型兼容）
              </option>
            </select>
          </label>
          <label>
            API 地址
            <input
              type="url"
              value={ai.endpoint}
              onChange={(e) => setAI({ ...ai, endpoint: e.target.value })}
            />
          </label>
          <label>
            模型
            <input
              value={ai.model}
              placeholder="填写支持所选接口和 JSON 输出的模型"
              onChange={(e) => setAI({ ...ai, model: e.target.value })}
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="new-password"
              value={ai.apiKey || ""}
              placeholder={ai.hasKey ? "已保存，留空保留" : "仅保存在 NAS"}
              onChange={(e) => setAI({ ...ai, apiKey: e.target.value })}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ai.webSearch}
              onChange={(e) => setAI({ ...ai, webSearch: e.target.checked })}
            />
            联网查证并保存参考来源（模型需支持 web_search，会产生 API 费用）
          </label>
          <div className="modal-actions">
            <button className="primary" disabled={busy}>
              保存设置
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => save("/admin/enrichment/test", ai)}
            >
              测试 AI（调用一次）
            </button>
          </div>
        </form>
      )}
      <section
        className="settings-card"
        hidden={!!section && section !== "metadata"}
      >
        <div className="section-heading">
          <h3>待核对 · {reviews.length}</h3>
          <button onClick={refresh}>刷新</button>
        </div>
        <p>在曲库管理核对歌曲资料和画面候选，确认后继续处理。</p>
        {reviews.map((r) => (
          <article key={r.id} className="review-item">
            <p>
              {r.artist} · {r.title}
            </p>
            <p>{r.note}</p>
            <a href="/admin">前往曲库管理核对</a>
          </article>
        ))}
        <details>
          <summary>企业微信 / Telegram / webhook 管理接口</summary>
          <p>
            提供独立凭证，只能读取待核对项目、提交歌手与歌名。机器人可调用此接口；平台专用机器人适配器尚未内置。
          </p>
          <code>GET /api/integrations/reviews</code>
          <br />
          <code>POST /api/integrations/reviews/:id</code>
          <p>使用 Authorization: Bearer 凭证。不要把凭证放入公开消息或链接。</p>
          <button
            onClick={() =>
              request("/admin/integration")
                .then((r) => setToken(r.token))
                .catch((e) => notify(e.message))
            }
          >
            查看集成凭证
          </button>
          {token && (
            <input
              aria-label="管理集成凭证"
              type="password"
              readOnly
              value={token}
              onFocus={(e) => e.target.select()}
            />
          )}
        </details>
      </section>
    </>
  );
}
