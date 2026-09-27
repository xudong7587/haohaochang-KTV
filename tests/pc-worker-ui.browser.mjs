import assert from "node:assert/strict";
import express from "express";
import path from "node:path";
import { chromium } from "playwright";
const app = express(),
  jobs = [
    {
      id: "running",
      title: "正在分离的歌曲",
      status: "running",
      stage: "separating",
      model: "htdemucs",
      model_progress: 42,
      created: Date.now() / 1000,
    },
  ];
for (let i = 0; i < 75; i++)
  jobs.push({
    id: "q" + i,
    title: "排队歌曲 " + i,
    status: "queued",
    created: Date.now() / 1000,
  });
for (let i = 0; i < 80; i++)
  jobs.push({
    id: "d" + i,
    title: "完成歌曲 " + i,
    status: "done",
    created: Date.now() / 1000,
  });
let update = { phase: "idle", current: "0.3.10" };
let rateLimited = false;
let checks = 0;
app.use(express.json());
app.get("/update.js", (q, r) =>
  r.sendFile(path.resolve("pc-worker/ui/update.js")),
);
app.post("/desktop/update/:action", (q, r) => {
  assert.equal(q.headers.authorization, "Bearer fixture-key");
  update =
    q.params.action === "check"
      ? { phase: "available", latest: "0.3.11" }
      : q.params.action === "install"
        ? { phase: "waiting", latest: "0.3.11" }
        : { phase: "cancelled" };
  if (q.params.action === "check") {
    checks++;
    if (rateLimited)
      update = {
        phase: "failed",
        nextCheck: Date.now() / 1000 + 120,
        error: "GitHub 暂时限制更新请求，请稍后重试，或点击“手动下载更新包”。",
      };
  }
  r.json(update);
});
let pendingPairs = [
  { id: "pair-fixture", address: "192.168.1.10", code: "123456" },
];
let approvedPair = "",
  revoked = false,
  statusKey = "";
app.post("/lan/approve", (req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-key");
  approvedPair = req.body.id;
  pendingPairs = [];
  res.json({ ok: true });
});
app.post("/lan/revoke", (req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-key");
  revoked = true;
  res.json({ ok: true, key: "rotated-fixture-key" });
});
app.get("/desktop/status", (req, res) => {
  statusKey = req.headers.authorization;
  res.json({
    version: "0.3.10",
    update,
    jobs,
    device: "cpu",
    cpu: 8,
    memory: { used_gb: 4, total_gb: 32, percent: 12 },
    runtime: "test",
    segment: 7,
    addresses: [],
    lan: { enabled: false, pending: pendingPairs },
  });
});
app.get("/icon.svg", (req, res) =>
  res.type("svg").send('<svg xmlns="http://www.w3.org/2000/svg"/>'),
);
app.get("/", (req, res) =>
  res.sendFile(path.resolve("pc-worker/ui/index.html")),
);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(
    "http://127.0.0.1:" + server.address().port + "/#fixture-key",
  );
  await page.locator(".task-item").waitFor();
  for (const name of ["检查更新", "安装新版", "取消更新"])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).count(),
      0,
    );
  assert.equal(checks, 0);
  update = { phase: "failed", error: "403 Forbidden" };
  await page
    .getByRole("status")
    .filter({ hasText: "应用内更新已暂停" })
    .waitFor();
  assert.equal(
    await page.getByText("403 Forbidden", { exact: true }).count(),
    0,
  );
  assert.equal(await page.locator(".task-item").count(), 1);
  await page.getByRole("button", { name: /排队等待 · 75 项/ }).click();
  assert.equal(await page.locator(".task-item").count(), 11);
  await page
    .getByRole("button", { name: "排队等待下一页", exact: true })
    .click();
  await page.getByText("排队歌曲 10", { exact: true }).waitFor();
  await page.screenshot({ path: "test-results/pc-workbench.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(
    await page.evaluate(() => [
      document.documentElement.scrollWidth,
      innerWidth,
    ]),
    [390, 390],
  );
  await page.screenshot({ path: "test-results/pc-workbench-mobile.png" });
  await page.getByRole("button", { name: /配对码 123456/ }).click();
  assert.equal(approvedPair, "pair-fixture");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#revokePairs").click();
  await page.getByText("旧密钥已撤销，请重新配对", { exact: true }).waitFor();
  await page.waitForFunction(
    () => sessionStorage.getItem("resourceAIKey") === "rotated-fixture-key",
  );
  assert.ok(revoked);
  for (let n = 0; n < 50 && statusKey !== "Bearer rotated-fixture-key"; n++)
    await page.waitForTimeout(100);
  assert.equal(statusKey, "Bearer rotated-fixture-key");
  console.log(
    "PC standalone workspace passed: 156 jobs, grouped collapse, ten-row pagination, mobile width",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
