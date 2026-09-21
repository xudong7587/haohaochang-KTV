import {
  ensureBiliCredentials,
  biliCredentialStatus,
  credentialsFromCookie,
  saveBiliLogin,
  biliScopes,
} from "./bili-credentials.js";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
const headers = {
  "User-Agent": "Mozilla/5.0",
  Referer: "https://www.bilibili.com/",
};
// 在线找歌和收藏夹自动下载各用一份登录；扫码只写入选中的用途。
const scopeOf = (req = {}) => {
  const value = String(req.query?.scope || req.body?.scope || "online");
  if (!biliScopes.includes(value)) throw new Error("未知的 B 站登录用途");
  return value;
};
const loginMessages = {
  online: "已登录，在线找歌和在线下载使用此账号",
  favorites: "已登录，收藏夹自动下载使用此账号，与在线找歌互不影响",
};
async function call(url, cookie, fetcher = fetch) {
  const response = await fetcher(url, {
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`B站连接失败 (${response.status})`);
  const body = await response.json();
  return { response, body };
}
export async function biliLoginStatus(cookie = "", fetcher = fetch) {
  if (!cookie) return { loggedIn: false };
  const { body } = await call(
    "https://api.bilibili.com/x/web-interface/nav",
    cookie,
    fetcher,
  );
  if (body.code === -101) return { loggedIn: false };
  if (body.code !== 0) throw new Error("B站登录检测暂不可用，请稍后重试");
  return {
    loggedIn: body.data?.isLogin === true,
    name: String(body.data?.uname || ""),
    vip: body.data?.vipStatus === 1,
  };
}
export function biliLoginApi({ app, admin, store, fetcher = fetch }) {
  const sessions = new Map();
  app.get("/api/admin/bilibili/status", admin, async (req, res) => {
    const scope = scopeOf(req);
    res.json({
      scope,
      ...(await biliLoginStatus(
        await ensureBiliCredentials(store, { fetcher, scope }),
        fetcher,
      )),
      ...biliCredentialStatus(store, scope),
    });
  });
  app.post("/api/admin/bilibili/qr", admin, async (req, res) => {
    const scope = scopeOf(req);
    for (const [id, value] of sessions)
      if (value.expires < Date.now()) sessions.delete(id);
    if (sessions.size >= 5) throw new Error("已有登录二维码，请稍后重试");
    const { body } = await call(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
      "",
      fetcher,
    );
    const url = new URL(body.data?.url);
    if (
      body.code !== 0 ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !["passport.bilibili.com", "account.bilibili.com"].includes(
        url.hostname,
      ) ||
      !body.data.qrcode_key
    )
      throw new Error("B站未提供有效登录二维码");
    const id = randomUUID();
    sessions.set(id, {
      scope,
      key: body.data.qrcode_key,
      expires: Date.now() + 180000,
      last: 0,
    });
    res.json({
      id,
      scope,
      image: await QRCode.toDataURL(url.href),
      expiresIn: 180,
    });
  });
  app.post("/api/admin/bilibili/qr/:id", admin, async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session || session.expires < Date.now())
      return res.json({
        status: "expired",
        message: "二维码已过期，请重新生成",
      });
    const scope = session.scope;
    if (Date.now() - session.last < 2500)
      return res.json({ status: "pending", message: "等待手机确认" });
    session.last = Date.now();
    const endpoint = new URL(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
    );
    endpoint.searchParams.set("qrcode_key", session.key);
    const { response, body } = await call(endpoint, "", fetcher);
    if (body.code !== 0) throw new Error("B站扫码状态读取失败");
    if (body.data?.code === 0) {
      const names = ["SESSDATA", "bili_jct", "DedeUserID"];
      const cookies = Object.fromEntries(
        response.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .map((v) => {
            const n = v.indexOf("=");
            return [v.slice(0, n), v.slice(n + 1)];
          })
          .filter(([name]) => names.includes(name)),
      );
      if (names.some((name) => !cookies[name]))
        throw new Error("登录凭证不完整，请重新扫码");
      try {
        const { body: device } = await call(
          "https://api.bilibili.com/x/web-frontend/getbuvid",
          "",
          fetcher,
        );
        if (device.code === 0 && device.data?.buvid)
          cookies.buvid3 = device.data.buvid;
      } catch {}
      const cookie = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      const status = await biliLoginStatus(cookie, fetcher);
      if (!status.loggedIn) throw new Error("登录尚未生效，请重新扫码");
      saveBiliLogin(store, scope, {
        cookie,
        credentials: credentialsFromCookie(
          cookie,
          body.data?.refresh_token || "",
        ),
      });
      sessions.delete(req.params.id);
      return res.json({
        status: "success",
        scope,
        ...status,
        ...biliCredentialStatus(store, scope),
        message: loginMessages[scope],
      });
    }
    const code = body.data?.code;
    if (code === 86038) sessions.delete(req.params.id);
    if (![86038, 86090, 86101].includes(code))
      throw new Error("B站返回未知扫码状态，请重试");
    res.json({
      status: code === 86038 ? "expired" : "pending",
      message:
        code === 86038
          ? "二维码已过期"
          : code === 86090
            ? "已扫码，请在手机上确认登录"
            : "请用哔哩哔哩 App 扫码",
    });
  });
}
