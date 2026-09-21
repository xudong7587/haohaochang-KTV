import { constants, createHash, publicEncrypt } from "node:crypto";

// Protocol reference: bili-sync's bilibili/credential.rs (MIT).
const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;
const passport = "https://passport.bilibili.com/x/passport-login/web/";
const names = {
  sessdata: "SESSDATA",
  bili_jct: "bili_jct",
  buvid3: "buvid3",
  dedeuserid: "DedeUserID",
};
// 在线找歌／下载和收藏夹自动下载各保存一份登录。B站刷新会轮换 refresh_token，
// 同一份凭证被两处同时维护时，一端轮换就会让另一端失效，因此两处必须独立。
const scopes = {
  online: {
    record: "bili-online",
    state: "bili-online-refresh-state",
    confirm: "bili-online-refresh-confirm",
  },
  favorites: {
    record: "favorites",
    state: "bili-refresh-state",
    confirm: "bili-refresh-confirm",
  },
};
export const biliScopes = Object.keys(scopes);
export function biliScope(scope = "online") {
  const target = scopes[scope];
  if (!target) throw new Error("未知的 B 站登录用途");
  return target;
}
export function biliCookie(store, scope = "online") {
  return store.get(biliScope(scope).record, {}).cookie || "";
}
export function saveBiliLogin(store, scope, { cookie, credentials }) {
  const { record } = biliScope(scope);
  store.set(record, { ...store.get(record, {}), cookie, credentials });
}
const pending = new WeakMap();
const fingerprint = (cookie) =>
  createHash("sha256").update(cookie).digest("hex");

export function credentialsFromCookie(cookie = "", refreshToken = "") {
  const values = Object.fromEntries(
    cookie
      .split(";")
      .map((part) => {
        const i = part.indexOf("=");
        return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
      })
      .filter(([key]) => key),
  );
  return {
    ...Object.fromEntries(
      Object.entries(names).map(([key, name]) => [key, values[name] || ""]),
    ),
    ac_time_value: refreshToken,
  };
}

async function request(url, cookie, fetcher, form) {
  const response = await fetcher(url, {
    method: form ? "POST" : "GET",
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.bilibili.com/",
      Cookie: cookie,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("B站凭证维护暂不可用");
  return response;
}
async function json(response) {
  const body = await response.json();
  if (body.code !== 0) throw new Error("B站凭证维护未完成，请检测登录状态");
  return body;
}

export async function ensureBiliCredentials(
  store,
  { fetcher = fetch, now = Date.now, force = false, scope = "online" } = {},
) {
  biliScope(scope);
  if (store.readOnlyMedia) return biliCookie(store, scope);
  const operations = pending.get(store) || new Map();
  pending.set(store, operations);
  if (operations.has(scope)) return operations.get(scope);
  const operation = maintain(store, { fetcher, now, force, scope });
  operations.set(scope, operation);
  try {
    return await operation;
  } finally {
    operations.delete(scope);
  }
}

async function maintain(store, { fetcher, now, force, scope }) {
  const target = biliScope(scope),
    config = store.get(target.record, {}),
    cookie = config.cookie || "";
  if (!cookie) return "";
  const refreshToken = config.credentials?.ac_time_value || "";
  if (!refreshToken) return cookie; // Legacy/raw cookies remain usable; never invent a token.
  const hash = fingerprint(cookie),
    previous = store.get(target.state, {});
  if (!force && previous.cookieHash === hash && previous.nextCheck > now())
    return cookie;
  const current = () => store.get(target.record, {});
  const unchanged = () =>
    current().cookie === cookie &&
    current().credentials?.ac_time_value === refreshToken;
  const state = (patch, currentCookie = cookie) =>
    store.set(target.state, {
      cookieHash: fingerprint(currentCookie),
      checkedAt: now(),
      nextCheck: now() + 24 * 3600000,
      ...patch,
    });
  try {
    const waiting = store.get(target.confirm, null);
    if (waiting?.cookieHash === hash) {
      await json(
        await request(passport + "confirm/refresh", cookie, fetcher, {
          csrf: credentialsFromCookie(cookie).bili_jct,
          refresh_token: waiting.oldToken,
        }),
      );
      if (!unchanged()) return current().cookie || "";
      store.set(target.confirm, null);
    }
    const info = await json(
      await request(passport + "cookie/info", cookie, fetcher),
    );
    if (!unchanged()) return current().cookie || "";
    if (typeof info.data?.refresh !== "boolean")
      throw new Error("B站凭证状态不完整");
    if (info.data.refresh !== true) {
      state({ status: "valid" });
      return cookie;
    }
    const encrypted = publicEncrypt(
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(`refresh_${now() - 20000}`),
    ).toString("hex");
    const page = await request(
      `https://www.bilibili.com/correspond/1/${encrypted}`,
      cookie,
      fetcher,
    );
    const csrf = (await page.text()).match(
      /<div\s+id=["']1-name["']>([^<]+)<\/div>/,
    )?.[1];
    if (!csrf) throw new Error("B站凭证刷新校验未完成");
    if (!unchanged()) return current().cookie || "";
    const response = await request(
      passport + "cookie/refresh",
      cookie,
      fetcher,
      {
        csrf: credentialsFromCookie(cookie).bili_jct,
        refresh_csrf: csrf,
        refresh_token: refreshToken,
        source: "main_web",
      },
    );
    const body = await json(response);
    const updates = credentialsFromCookie(
      response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
      body.data?.refresh_token || "",
    );
    if (
      ![
        updates.sessdata,
        updates.bili_jct,
        updates.dedeuserid,
        updates.ac_time_value,
      ].every(Boolean)
    )
      throw new Error("B站返回的刷新凭证不完整");
    if (!unchanged()) return current().cookie || "";
    updates.buvid3 ||= credentialsFromCookie(cookie).buvid3;
    // Preserve other cookie fields; refresh only the account fields returned by Bilibili.
    const accountNames = new Set(Object.values(names));
    const extras = cookie
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v && !accountNames.has(v.split("=")[0]));
    const nextCookie = [
      ...extras,
      ...Object.entries(names).map(([key, name]) => `${name}=${updates[key]}`),
    ].join("; ");
    // Persist the new usable credentials before invalidating the old refresh token.
    store.set(target.record, {
      ...current(),
      cookie: nextCookie,
      credentials: updates,
    });
    store.set(target.confirm, {
      cookieHash: fingerprint(nextCookie),
      oldToken: refreshToken,
    });
    try {
      await json(
        await request(passport + "confirm/refresh", nextCookie, fetcher, {
          csrf: updates.bili_jct,
          refresh_token: refreshToken,
        }),
      );
      if (current().cookie === nextCookie) {
        store.set(target.confirm, null);
        state({ status: "refreshed", refreshedAt: now() }, nextCookie);
      }
    } catch {
      if (current().cookie === nextCookie)
        state(
          { status: "confirm-pending", nextCheck: now() + 15 * 60000 },
          nextCookie,
        );
    }
    return current().cookie || "";
  } catch {
    if (unchanged())
      state({ status: "retrying", nextCheck: now() + 15 * 60000 });
    // A transient maintenance failure must not clear a working login or stop a download.
    return current().cookie || "";
  }
}

export function biliCredentialStatus(store, scope = "online") {
  const target = biliScope(scope),
    config = store.get(target.record, {}),
    saved = store.get(target.state, {});
  const relevant = saved.cookieHash === fingerprint(config.cookie || "");
  return {
    autoRefresh: !!config.credentials?.ac_time_value,
    refreshStatus: relevant ? saved.status : "unchecked",
    lastChecked: relevant ? saved.checkedAt : null,
  };
}
