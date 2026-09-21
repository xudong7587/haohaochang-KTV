import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureBiliCredentials,
  credentialsFromCookie,
  biliCredentialStatus,
  biliCookie,
} from "../server/bili-credentials.js";
import { favoriteConfig } from "../server/favorites.js";
import { requireDownloadFrameRate } from "../server/bili-download.js";

const oldCookie =
  "SESSDATA=old; bili_jct=old-csrf; DedeUserID=1; buvid3=device; extra=keep";
const onlineCookie = "SESSDATA=online; bili_jct=online-csrf; DedeUserID=2";
function fixture() {
  const data = new Map([
    [
      "favorites",
      {
        cookie: oldCookie,
        enabled: true,
        favoriteId: "123",
        credentials: credentialsFromCookie(oldCookie, "refresh-old"),
      },
    ],
    [
      "bili-online",
      {
        cookie: onlineCookie,
        credentials: credentialsFromCookie(onlineCookie, "refresh-online"),
      },
    ],
  ]);
  return {
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    set: (key, value) => data.set(key, value),
  };
}
const response = (body, cookies = []) =>
  new Response(JSON.stringify(body), {
    headers: cookies.map((value) => ["set-cookie", value]),
  });

test("frame interval rounding accepts real Bilibili 4K60/30fps metadata but rejects real frame loss", () => {
  requireDownloadFrameRate(60, 62.5);
  requireDownloadFrameRate(59.94, 62.5);
  requireDownloadFrameRate(30, 30.303);
  requireDownloadFrameRate(29.97, 30.303);
  assert.throws(() => requireDownloadFrameRate(30, 60), /帧率/);
  assert.throws(() => requireDownloadFrameRate(25, 30.303), /帧率/);
  assert.throws(() => requireDownloadFrameRate(0, 30), /帧率/);
});

test("refresh persists credentials, confirms with new CSRF, coalesces requests and exposes no secrets", async () => {
  const store = fixture(),
    calls = [];
  const fetcher = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.redirect, "error");
    if (String(url).endsWith("cookie/info"))
      return response({ code: 0, data: { refresh: true } });
    if (String(url).includes("/correspond/"))
      return new Response('<div id="1-name">refresh-csrf</div>');
    if (String(url).endsWith("cookie/refresh")) {
      assert.equal(options.body.get("refresh_token"), "refresh-old");
      return response({ code: 0, data: { refresh_token: "refresh-new" } }, [
        "SESSDATA=new; Path=/",
        "bili_jct=new-csrf",
        "DedeUserID=1",
      ]);
    }
    assert.match(options.headers.Cookie, /SESSDATA=new/);
    assert.equal(options.body.get("csrf"), "new-csrf");
    assert.equal(options.body.get("refresh_token"), "refresh-old");
    assert.match(store.get("favorites").cookie, /SESSDATA=new/);
    return response({ code: 0 });
  };
  const values = await Promise.all([
    ensureBiliCredentials(store, { fetcher, scope: "favorites" }),
    ensureBiliCredentials(store, { fetcher, scope: "favorites" }),
  ]);
  assert.equal(values[0], values[1]);
  assert.equal(calls.length, 4);
  assert.match(values[0], /extra=keep/);
  assert.match(values[0], /buvid3=device/);
  assert.equal(store.get("favorites").credentials.ac_time_value, "refresh-new");
  assert.equal(store.get("favorites").favoriteId, "123");
  await ensureBiliCredentials(store, { fetcher, scope: "favorites" });
  assert.equal(calls.length, 4);
  assert.equal(
    biliCredentialStatus(store, "favorites").refreshStatus,
    "refreshed",
  );
  assert.doesNotMatch(
    JSON.stringify(biliCredentialStatus(store, "favorites")),
    /refresh-new|refresh-old|SESSDATA/,
  );
});

test("online login and favorite login refresh independently and never overwrite each other", async () => {
  const store = fixture();
  const fetcher = async (url, options) => {
    if (String(url).endsWith("cookie/info"))
      return response({ code: 0, data: { refresh: true } });
    if (String(url).includes("/correspond/"))
      return new Response('<div id="1-name">csrf</div>');
    if (String(url).endsWith("cookie/refresh")) {
      const token = options.body.get("refresh_token"),
        suffix = token === "refresh-old" ? "favorite" : "online";
      return response({ code: 0, data: { refresh_token: "new-" + suffix } }, [
        "SESSDATA=" + suffix,
        "bili_jct=" + suffix + "-csrf",
        "DedeUserID=1",
        "buvid3=" + suffix + "-device",
      ]);
    }
    return response({ code: 0 });
  };
  const [online, favorites] = await Promise.all([
    ensureBiliCredentials(store, { fetcher, scope: "online" }),
    ensureBiliCredentials(store, { fetcher, scope: "favorites" }),
  ]);
  assert.match(online, /SESSDATA=online/);
  assert.match(favorites, /SESSDATA=favorite/);
  assert.equal(store.get("bili-online").credentials.ac_time_value, "new-online");
  assert.equal(
    store.get("favorites").credentials.ac_time_value,
    "new-favorite",
  );
  assert.equal(store.get("bili-online").favoriteId, undefined);
  assert.equal(store.get("favorites").favoriteId, "123");
  assert.equal(biliCookie(store), online);
  assert.equal(biliCookie(store, "favorites"), favorites);
  assert.equal(
    biliCredentialStatus(store, "online").refreshStatus,
    "refreshed",
  );
  assert.equal(
    biliCredentialStatus(store, "favorites").refreshStatus,
    "refreshed",
  );
});

test("maintenance failure preserves usable cookie with retry cooldown; raw-cookie saves don't resurrect stale credentials", async () => {
  const store = fixture();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw new Error("offline");
  };
  assert.equal(
    await ensureBiliCredentials(store, { fetcher, scope: "favorites" }),
    oldCookie,
  );
  await ensureBiliCredentials(store, { fetcher, scope: "favorites" });
  assert.equal(calls, 1);
  assert.equal(
    biliCredentialStatus(store, "favorites").refreshStatus,
    "retrying",
  );
  const updated = favoriteConfig(
    { cookie: "SESSDATA=another", favoriteId: "123" },
    store.get("favorites"),
  );
  assert.equal(updated.credentials.ac_time_value, "");
  assert.equal(
    favoriteConfig({ favoriteId: "123", intervalMinutes: 20 }, updated).cookie,
    "SESSDATA=another",
  );
});

test("manual credential replacement during refresh wins over a delayed response", async () => {
  const store = fixture();
  const fetcher = async () => {
    store.set("favorites", { cookie: "SESSDATA=manual" });
    return response({ code: 0, data: { refresh: true } });
  };
  assert.equal(
    await ensureBiliCredentials(store, { fetcher, scope: "favorites" }),
    "SESSDATA=manual",
  );
  assert.equal(store.get("bili-refresh-state", null), null);
});

test("failed confirmation retains new credentials and resumes after restart without rotating twice", async () => {
  const store = fixture();
  let confirmations = 0,
    refreshes = 0;
  const fetcher = async (url) => {
    if (String(url).endsWith("cookie/info"))
      return response({ code: 0, data: { refresh: refreshes === 0 } });
    if (String(url).includes("/correspond/"))
      return new Response('<div id="1-name">csrf</div>');
    if (String(url).endsWith("cookie/refresh")) {
      refreshes++;
      return response({ code: 0, data: { refresh_token: "new-token" } }, [
        "SESSDATA=new",
        "bili_jct=new-csrf",
        "DedeUserID=1",
      ]);
    }
    if (++confirmations === 1) throw new Error("network");
    return response({ code: 0 });
  };
  await ensureBiliCredentials(store, { fetcher, scope: "favorites" });
  assert.equal(
    biliCredentialStatus(store, "favorites").refreshStatus,
    "confirm-pending",
  );
  assert.match(store.get("favorites").cookie, /SESSDATA=new/);
  await ensureBiliCredentials(
    { ...store },
    { fetcher, force: true, scope: "favorites" },
  );
  assert.equal(refreshes, 1);
  assert.equal(confirmations, 2);
  assert.equal(store.get("bili-refresh-confirm"), null);
});

test("adding a refresh token to a legacy raw cookie preserves that cookie; clear removes every credential", () => {
  const updated = favoriteConfig(
    { ac_time_value: "fresh-token" },
    { cookie: oldCookie },
  );
  assert.equal(updated.cookie, oldCookie);
  assert.equal(updated.credentials.sessdata, "old");
  assert.equal(updated.credentials.ac_time_value, "fresh-token");
  const cleared = favoriteConfig(
    { clearCookie: true, cookie: oldCookie, ac_time_value: "fresh-token" },
    updated,
  );
  assert.equal(cleared.cookie, "");
  assert.equal(cleared.credentials.ac_time_value, "");
});
