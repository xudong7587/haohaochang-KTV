import { createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { equal, fail } from "./http-utils.js";

const derive = promisify(scrypt);
export function createAdminAuth(
  store,
  initialPassword,
  { now = Date.now, kdf = derive } = {},
) {
  const { get, set } = store;
  const cookieName = "ktv_admin_session";
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const cookieToken = (req) =>
    req
      .get("cookie")
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) || "";
  const hasSession = (req) => {
    const value = cookieToken(req);
    return (
      !!value &&
      get("adminSessions", []).some(
        (s) => s.expires > now() && equal(s.digest, digest(value)),
      )
    );
  };
  const attempts = new Map(),
    verified = new Map();
  let global = { n: 0, until: 0 },
    active = 0,
    changing = false;
  async function matches(value) {
    if (typeof value !== "string" || !value || value.length > 1024)
      return false;
    const saved = get("adminPasswordHash", null);
    if (!saved) return equal(value, initialPassword);
    const result = (await kdf(value, saved.salt, 64)).toString("hex");
    return (
      get("adminPasswordHash", null)?.hash === saved.hash &&
      equal(result, saved.hash)
    );
  }
  function limited(ip) {
    const time = now();
    for (const [key, value] of attempts)
      if (value.until <= time) attempts.delete(key);
    if (global.until <= time) global = { n: 0, until: time + 60000 };
    const entry = attempts.get(ip) || { n: 0, until: time + 60000 };
    attempts.set(ip, entry);
    if (
      attempts.size > 2000 ||
      ++entry.n > 30 ||
      ++global.n > 120 ||
      active >= 2
    )
      throw fail(429, "密码尝试过多，请一分钟后重试");
  }
  async function authenticate(req, value, knownMember) {
    if (hasSession(req)) return true;
    if (knownMember || !value || typeof value !== "string") return false;
    const saved = get("adminPasswordHash", null);
    const key = digest(value),
      version = saved?.hash || initialPassword;
    const cached = verified.get(key);
    if (cached?.version === version && cached.expires > now()) return true;
    limited(req.ip);
    active++;
    try {
      if (!(await matches(value))) return false;
      if (verified.size >= 20) verified.delete(verified.keys().next().value);
      verified.set(key, { version, expires: now() + 30000 });
      return true;
    } finally {
      active--;
    }
  }
  async function changePassword(current, next) {
    if (changing || active >= 2) throw fail(429, "密码校验繁忙，请稍后重试");
    changing = true;
    active++;
    try {
      if (!(await matches(current))) throw fail(401, "当前管理密码不正确");
      if (typeof next !== "string" || next.length < 6 || next.length > 1024)
        throw fail(400, "新密码需要 6 至 1024 位");
      const salt = randomBytes(16).toString("hex");
      const hash = (await kdf(next, salt, 64)).toString("hex");
      set("adminPasswordHash", { salt, hash });
      set("adminSessions", []);
      verified.clear();
    } finally {
      active--;
      changing = false;
    }
  }
  return {
    cookieName,
    cookieToken,
    hasSession,
    sessionDigest: digest,
    authenticate,
    changePassword,
  };
}
