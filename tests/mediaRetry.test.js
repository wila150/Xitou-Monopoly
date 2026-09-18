// 影片還在轉檔、第一次沒抓到內容時的處理：先存成「等待下載」讓小編看得到，背景重試，抓到就補上預覽。
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://localhost/line_checkpoint_test";
process.env.PGSSL = "false";
process.env.PUBLIC_BASE_URL = "https://example.com";
process.env.ADMIN_USER_IDS = "Uadmin";
process.env.ADMIN_PANEL_PASSWORD = "pw";
process.env.ADMIN_PANEL_SECRET = "test-secret";
process.env.LINE_CHANNEL_SECRET = "test";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test";

const express = require("express");
const dbModule = require("../src/db");
const configStore = require("../src/config/configStore");
const commandRouter = require("../src/handlers/commandRouter");
const teamService = require("../src/services/teamService");
const submissionStore = require("../src/config/submissionStore");
const mediaRetry = require("../src/mediaRetry");
const lineClient = require("../src/lineClient");

lineClient.push = async () => {};
lineClient.pushToMany = async () => {};
const adminRouter = require("../src/admin/router");

let server;
let base;
let cookie;

test.before(async () => {
  await dbModule.init();
  await configStore.init();
  const app = express();
  app.use("/admin", adminRouter);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/admin`;
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "pw" }),
  });
  cookie = res.headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await dbModule.pool.end();
});

async function api(path, { method = "GET" } = {}) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function resetGame() {
  await commandRouter.route("Uadmin", "重置遊戲 確認");
  await teamService.resetReferees();
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(64)]);

// 第 3 組第一關是 B3（關主關），到第 2 步才有影片關；直接用小編通過推進到一個影片關（E3／E2）
async function teamAtVideoCheckpoint(groupNo, leader) {
  await commandRouter.route(leader, `報到 ${groupNo}組`);
  await commandRouter.route("Uadmin", `出發 ${groupNo}組`);
  const { getRoute } = require("../src/config/teamsRoute");
  const { getCheckpoint } = require("../src/config/checkpoints");
  while (getCheckpoint(getRoute(groupNo)[(await teamService.findTeam(groupNo)).current_index].checkpointId).verifyType !== "video") {
    await commandRouter.route("Uadmin", `通過 ${groupNo}組`);
  }
}

test("影片沒抓到內容：先存成等待下載（小編馬上看得到），通知文字說明稍後會自動出現，並要求呼叫端排程重試", async () => {
  await resetGame();
  await teamAtVideoCheckpoint(1, "Ul1");

  const result = await teamService.submitMedia("Ul1", null, { lineMessageId: "line-msg-1" });
  assert.equal(typeof result.pendingDownloadId, "number");
  assert.match(result.adminNotify[0].messages[0].text, /LINE 還在處理，後台預覽稍後會自動出現/);
  assert.match(result.adminNotify[0].messages[0].text, /通過 1組/);

  const listed = (await api("/submissions")).data;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].hasData, false);

  // 預覽網址說明還在處理中
  const media = await fetch(`${base}/api/submissions/${listed[0].id}/media`, { headers: { Cookie: cookie } });
  assert.equal(media.status, 404);
  assert.match((await media.json()).error, /還在處理中/);

  // 沒有內容也沒有訊息 ID：沒辦法重試，不存
  const none = await teamService.submitMedia("Ul1", null);
  assert.equal(none.pendingDownloadId, null);
  assert.match(none.adminNotify[0].messages[0].text, /後台預覽失敗/);

  // 小編照樣可以直接通過（先到聊天記錄確認），通過後這組的待審紀錄清空
  await commandRouter.route("Uadmin", "通過 1組");
  assert.equal((await api("/submissions")).data.length, 0);
});

test("背景重試：失敗會記下原因與次數並保留紀錄；抓到就補上內容與格式；被處理掉的不再試；內容太大不補", async () => {
  await resetGame();
  await teamAtVideoCheckpoint(1, "Ul1");
  const { pendingDownloadId: id } = await teamService.submitMedia("Ul1", null, { lineMessageId: "msg-A" });

  // 第一次：LINE 還沒準備好
  const notReady = await mediaRetry.attemptDownload(id, async () => {
    throw new Error("影片內容在 10 秒內還沒準備好（status=processing）");
  });
  assert.equal(notReady.status, "pending");
  let row = (await api("/submissions")).data[0];
  assert.equal(row.hasData, false);
  assert.equal(row.downloadAttempts, 1);
  assert.match(row.downloadError, /還沒準備好/);

  // 第二次：抓到了。下載函式收到正確的訊息 ID 與種類（影片）
  let seen;
  const filled = await mediaRetry.attemptDownload(id, async (messageId, kind) => {
    seen = { messageId, kind };
    return { buffer: MP4, mimeType: "video/mp4" };
  });
  assert.equal(filled.status, "filled");
  assert.deepEqual(seen, { messageId: "msg-A", kind: "video" });
  row = (await api("/submissions")).data[0];
  assert.equal(row.hasData, true);
  const media = await fetch(`${base}/api/submissions/${row.id}/media`, { headers: { Cookie: cookie } });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "video/mp4");
  assert.equal((await media.arrayBuffer()).byteLength, MP4.length);

  // 已經有內容：不會再下載、不會覆蓋
  let called = false;
  assert.equal((await mediaRetry.attemptDownload(id, async () => { called = true; return { buffer: Buffer.from("x"), mimeType: "video/mp4" }; })).status, "filled");
  assert.equal(called, false);

  // 已被處理掉（刪除）：回報 gone
  await submissionStore.deleteSubmission(id);
  assert.equal((await mediaRetry.attemptDownload(id, async () => ({ buffer: MP4, mimeType: "video/mp4" }))).status, "gone");

  // 抓到的內容是空的 → failed（不補進去）
  const { pendingDownloadId: id2 } = await teamService.submitMedia("Ul1", null, { lineMessageId: "msg-B" });
  const empty = await mediaRetry.attemptDownload(id2, async () => ({ buffer: Buffer.alloc(0), mimeType: "video/mp4" }));
  assert.equal(empty.status, "failed");
  assert.equal((await api("/submissions")).data.find((r) => r.id === id2).hasData, false);
});

test("排程重試：前幾次失敗、之後成功就補上並停止；一直失敗到用完次數就放棄", async () => {
  await resetGame();
  await teamAtVideoCheckpoint(1, "Ul1");
  const { pendingDownloadId: id } = await teamService.submitMedia("Ul1", null, { lineMessageId: "msg-C" });

  let attempts = 0;
  const finished = await new Promise((resolve) => {
    mediaRetry.scheduleRetries(
      id,
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("還沒好");
        return { buffer: MP4, mimeType: "video/mp4" };
      },
      { delays: [5, 5, 5, 5, 5], onDone: resolve }
    );
  });
  assert.equal(finished.status, "filled");
  assert.equal(attempts, 3, "成功後就停，不會多試");
  assert.equal((await api("/submissions")).data[0].hasData, true);

  await resetGame();
  await teamAtVideoCheckpoint(1, "Ul1");
  const { pendingDownloadId: id2 } = await teamService.submitMedia("Ul1", null, { lineMessageId: "msg-D" });
  let tries = 0;
  const gaveUp = await new Promise((resolve) => {
    mediaRetry.scheduleRetries(id2, async () => { tries++; throw new Error("一直失敗"); }, { delays: [5, 5, 5], onDone: resolve });
  });
  assert.equal(gaveUp.status, "gave-up");
  assert.equal(tries, 3);
  assert.equal((await api("/submissions")).data[0].downloadAttempts, 3);
});

test("後台「重試下載」與重啟後接續：手動重試會立刻再抓一次；重啟時還在等內容的會被接續排程", async () => {
  await resetGame();
  await teamAtVideoCheckpoint(1, "Ul1");
  const { pendingDownloadId: id } = await teamService.submitMedia("Ul1", null, { lineMessageId: "msg-E" });

  // 手動重試：LINE 客戶端用假的（後台路由在呼叫當下才讀 lineClient.getMessageContent）
  const original = lineClient.getMessageContent;
  try {
    lineClient.getMessageContent = async () => { throw new Error("LINE 還沒準備好"); };
    const pending = await api(`/submissions/${id}/retry`, { method: "POST" });
    assert.equal(pending.data.status, "pending");
    assert.match(pending.data.error, /還沒準備好/);

    lineClient.getMessageContent = async () => ({ buffer: MP4, mimeType: "video/mp4" });
    assert.equal((await api(`/submissions/${id}/retry`, { method: "POST" })).data.status, "filled");
    assert.equal((await api(`/submissions/${id}/retry`, { method: "POST" })).data.status, "filled", "重複按不會壞");
    assert.equal((await api("/submissions/999999/retry", { method: "POST" })).data.status, "gone");
  } finally {
    lineClient.getMessageContent = original;
  }

  // 重啟後接續：只挑「還在等內容、有訊息 ID」的
  const { pendingDownloadId: waiting } = await teamService.submitMedia("Ul1", null, { lineMessageId: "msg-F" });
  const ids = await submissionStore.listAwaitingDownload();
  assert.deepEqual(ids, [waiting]);
});
