import { fail } from "./http-utils.js";
// Ownership belongs to a page instance. Only its first claim may displace a peer;
// ordinary heartbeats and delayed claim retries can never reclaim a revoked page.
export function createPlayerLease({
  now = Date.now,
  lifetime = 15000,
  preferTv = true,
} = {}) {
  let owner = null,
    revision = 0;
  const pages = new Map();
  const online = () => !!owner && now() - owner.seen < lifetime;
  const snapshot = () =>
    online() ? { id: owner.id, type: owner.type, revision } : null;
  function heartbeat({ id, type, claim }) {
    const time = now();
    for (const [key, page] of pages)
      if (key !== owner?.id && time - page.seen > 3600000) pages.delete(key);
    const known = pages.get(id),
      freshClaim = claim === true && !known;
    if (known?.revoked)
      throw Object.assign(
        fail(
          409,
          "此页面已被新播放终端接管，已停止出声；重新打开播放页可申请接管。",
        ),
        { code: "PLAYER_REPLACED" },
      );
    const kind = known?.type || (type === "tv" ? "tv" : "web");
    pages.set(id, { ...known, type: kind, seen: time });
    if (online() && owner.id !== id) {
      if (preferTv && owner.type === "tv" && kind !== "tv")
        throw Object.assign(
          fail(409, "TV 正在播放，此页面仅用于点歌和控制。"),
          { code: "PLAYER_TV_PRIORITY" },
        );
      if (!freshClaim)
        throw Object.assign(
          fail(409, "另一播放终端正在使用歌房，此页面等待播放权。"),
          { code: "PLAYER_BUSY" },
        );
      pages.set(owner.id, {
        ...pages.get(owner.id),
        seen: time,
        revoked: true,
      });
    }
    const changed = owner?.id !== id || !online();
    if (changed) revision++;
    owner = { id, type: kind, seen: time };
    return { changed, freshClaim, owner: snapshot() };
  }
  return {
    heartbeat,
    snapshot,
    owns: (id) => online() && owner.id === id,
    revoke() {
      for (const page of pages.values()) page.revoked = true;
      owner = null;
      revision++;
    },
  };
}
