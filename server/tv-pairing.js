import { randomBytes, randomInt } from "node:crypto";
import QRCode from "qrcode";
import { equal, fail } from "./http-utils.js";

// The phone's approval capability cannot collect the TV's room token.
export function tvPairingApi({
  app,
  member,
  get,
  allowedOrigin,
  now = Date.now,
}) {
  const sessions = new Map();
  const secret = () => randomBytes(24).toString("hex");
  function session(id) {
    const item = sessions.get(id);
    if (!item || item.expires <= now()) {
      sessions.delete(id);
      throw fail(410, "二维码已过期，请在电视上刷新");
    }
    return item;
  }
  app.post("/api/tv-pairing", async (req, res) => {
    for (const [id, item] of sessions)
      if (item.expires <= now()) sessions.delete(id);
    if (sessions.size >= 40) throw fail(429, "连接请求较多，请稍后再试");
    const origin =
      get("publicUrl", "").replace(/\/$/, "") ||
      (allowedOrigin(req, req.body.origin)
        ? req.body.origin
        : `${req.protocol}://${req.get("host")}`);
    const id = secret(),
      pollKey = secret(),
      approvalKey = secret();
    const item = {
      pollKey,
      approvalKey,
      code: String(randomInt(100000, 1000000)),
      expires: now() + 180000,
    };
    sessions.set(id, item);
    const url = `${origin}/mobile#pair=${id}.${approvalKey}`;
    res.set("Cache-Control", "no-store").json({
      id,
      pollKey,
      code: item.code,
      expiresIn: 180,
      qr: await QRCode.toDataURL(url, { width: 280, margin: 2 }),
    });
  });
  app.post("/api/tv-pairing/:id/check", (req, res) => {
    const item = session(req.params.id);
    if (!equal(req.body.pollKey, item.pollKey)) throw fail(403, "连接凭据无效");
    res.set("Cache-Control", "no-store");
    if (!item.approved) return res.json({ status: "waiting" });
    sessions.delete(req.params.id);
    res.json({ status: "approved", token: get("roomToken") });
  });
  app.post("/api/tv-pairing/:id/info", member, (req, res) => {
    const item = session(req.params.id);
    if (!equal(req.body.approvalKey, item.approvalKey))
      throw fail(403, "二维码无效");
    res.set("Cache-Control", "no-store").json({ code: item.code });
  });
  app.post("/api/tv-pairing/:id/approve", member, (req, res) => {
    const item = session(req.params.id);
    if (!equal(req.body.approvalKey, item.approvalKey))
      throw fail(403, "二维码无效");
    item.approved = true;
    res.json({ ok: true });
  });
  return () => sessions.clear();
}
