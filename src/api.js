const fromHash = location.hash.slice(1);
export function tvPairFromHash(hash) {
  return /^pair=[a-f0-9]{48}\.[a-f0-9]{48}$/.test(hash) ? hash.slice(5) : "";
}
export const pendingTvPair = tvPairFromHash(fromHash);
if (
  fromHash &&
  !fromHash.startsWith("pair=") &&
  ["/mobile", "/control"].includes(location.pathname)
) {
  sessionStorage.setItem("controlRoomToken", fromHash);
  history.replaceState(null, "", location.pathname);
}
export let roomToken =
  (["/mobile", "/control"].includes(location.pathname)
    ? sessionStorage.getItem("controlRoomToken")
    : "") ||
  localStorage.getItem("roomToken") ||
  "";
export let adminToken = sessionStorage.getItem("adminToken") || "";
export async function api(
  url,
  body,
  method = "GET",
  isAdmin = false,
  tokenOverride,
) {
  const binary = typeof Blob !== "undefined" && body instanceof Blob;
  const response = await fetch("/api" + url, {
    method,
    headers: {
      "Content-Type": binary
        ? body.type || "application/octet-stream"
        : "application/json",
      Authorization: `Bearer ${tokenOverride ?? (isAdmin ? adminToken : roomToken)}`,
    },
    ...(body !== undefined
      ? { body: binary ? body : JSON.stringify(body) }
      : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || "连接失败"), result, {
      status: response.status,
      retryAfter: Number(response.headers.get("Retry-After")) || 60,
    });
  return result;
}

export function selectRoom(room) {
  roomToken = room.token;
  sessionStorage.setItem("playRoom", JSON.stringify(room));
}

export function setAdminToken(value) {
  adminToken = value;
}
export function acceptLogin(value) {
  roomToken = value;
  localStorage.setItem("roomToken", value);
  sessionStorage.removeItem("adminToken");
  adminToken = "";
}
export async function logout() {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  sessionStorage.removeItem("controlRoomToken");
  sessionStorage.removeItem("playRoom");
  localStorage.removeItem("roomToken");
  sessionStorage.removeItem("adminToken");
  location.reload();
}
