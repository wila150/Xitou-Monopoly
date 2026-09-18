const test = require("node:test");
const assert = require("node:assert/strict");

// 必須在 require 任何 src 模組之前設定（跟 commandRouter.test.js 一樣，需要可連線的 Postgres）
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
const lineClient = require("../src/lineClient");

// 不要真的呼叫 LINE：把推播換成記錄用的假函式（後台路由是在呼叫當下才讀 lineClient.push，所以這樣換得掉）
const pushed = [];
lineClient.push = async (to, messages) => {
  pushed.push({ to, messages });
};
lineClient.pushToMany = async (ids, messages) => {
  for (const to of ids) pushed.push({ to, messages });
};

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

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function resetGame() {
  await commandRouter.route("Uadmin", "重置遊戲 確認");
  await teamService.resetReferees();
  await teamService.resetBroadcasters();
  pushed.length = 0;
}

test("後台需要登入：沒帶 cookie 的請求被擋下", async () => {
  const res = await fetch(`${base}/api/progress`);
  assert.equal(res.status, 401);
  const noCookie = await fetch(`${base}/api/depart`, { method: "POST" });
  assert.equal(noCookie.status, 401);
});

test("後台出發：勾選多組一起出發，記錄出發時間、推播第一關給隊長", async () => {
  await resetGame();
  for (const g of [1, 2, 3]) await commandRouter.route(`Ul${g}`, `報到 ${g}組`);

  const before = Date.now();
  const { status, data } = await api("/depart", { method: "POST", body: { groupNos: [1, 2] } });
  assert.equal(status, 200);
  assert.equal(data.results.length, 2);
  assert.ok(data.results.every((r) => r.done && !r.notifyFailed));

  for (const g of [1, 2]) {
    const team = await teamService.findTeam(g);
    assert.equal(team.status, "IN_PROGRESS");
    assert.equal(team.current_index, 0);
    assert.ok(new Date(team.start_time).getTime() >= before - 1000, "出發時間是按下去的當下");
  }
  assert.equal((await teamService.findTeam(3)).status, "CHECKED_IN", "沒勾選的組別不受影響");

  // 第一關公告推給各組隊長（預設只推隊長）
  const toLeaders = pushed.filter((p) => ["Ul1", "Ul2"].includes(p.to));
  assert.equal(toLeaders.length, 2);
  assert.equal(pushed.filter((p) => p.to === "Ul3").length, 0);

  // 即時進度會回傳出發時間
  const progress = (await api("/progress")).data;
  assert.ok(progress.find((r) => r.groupNo === 1).startTime);
  assert.equal(progress.find((r) => r.groupNo === 3).startTime, null);
});

test("後台出發：可補登實際出發時間，耗時從補登時間起算", async () => {
  await resetGame();
  await commandRouter.route("Ul1", "報到 1組");
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { status, data } = await api("/depart", {
    method: "POST",
    body: { groupNos: [1], startedAt: tenMinutesAgo },
  });
  assert.equal(status, 200);
  assert.match(data.results[0].message, /出發時間 \d{2}:\d{2}/);
  assert.equal((await teamService.findTeam(1)).start_time, tenMinutesAgo);

  const progress = (await api("/progress")).data.find((r) => r.groupNo === 1);
  assert.match(progress.elapsed, /^00:(09|10):\d{2}$/, "經過時間約 10 分鐘");
});

test("後台出發：補登時間不合理會被拒絕（未來、超過 24 小時前、格式錯誤），也不會出發", async () => {
  await resetGame();
  await commandRouter.route("Ul1", "報到 1組");

  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const tooOld = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  for (const [startedAt, pattern] of [
    [future, /未來/],
    [tooOld, /24 小時/],
    ["不是時間", /格式/],
  ]) {
    const { status, data } = await api("/depart", { method: "POST", body: { groupNos: [1], startedAt } });
    assert.equal(status, 400);
    assert.match(data.error, pattern);
  }
  assert.equal((await teamService.findTeam(1)).status, "CHECKED_IN");
});

test("後台出發：沒選組別、組別編號不合法會被拒絕；已出發或未報到的組別不會重複出發", async () => {
  await resetGame();
  await commandRouter.route("Ul1", "報到 1組");
  await commandRouter.route("Uadmin", "出發 1組");
  const startBefore = (await teamService.findTeam(1)).start_time;

  assert.equal((await api("/depart", { method: "POST", body: { groupNos: [] } })).status, 400);
  assert.equal((await api("/depart", { method: "POST", body: {} })).status, 400);
  assert.equal((await api("/depart", { method: "POST", body: { groupNos: [0] } })).status, 400);
  assert.equal((await api("/depart", { method: "POST", body: { groupNos: ["abc"] } })).status, 400);

  pushed.length = 0;
  const { data } = await api("/depart", { method: "POST", body: { groupNos: [1, 1, 5] } });
  assert.equal(data.results.length, 2, "重複的組別編號只處理一次");
  const r1 = data.results.find((r) => r.groupNo === 1);
  const r5 = data.results.find((r) => r.groupNo === 5);
  assert.equal(r1.done, false);
  assert.match(r1.message, /已經出發過了/);
  assert.equal(r5.done, false);
  assert.match(r5.message, /尚未有任何成員報到/);
  assert.equal((await teamService.findTeam(1)).start_time, startBefore, "已出發的組別出發時間不會被覆蓋");
  assert.equal(pushed.length, 0, "沒出發成功就不推播");
});

test("後台出發：第一關有登記關主時，出發會通知該關關主", async () => {
  await resetGame();
  await commandRouter.route("Ureferee", "我是 D5 關主");
  await commandRouter.route("Ul1", "報到 1組"); // 第 1 組第一關是 D5
  pushed.length = 0;
  await api("/depart", { method: "POST", body: { groupNos: [1] } });
  const toReferee = pushed.find((p) => p.to === "Ureferee");
  assert.ok(toReferee);
  assert.match(toReferee.messages[0].text, /第 1 組正往您這關/);
});

test("後台緊急聯絡 API：列出未處理事件，按已處理會通知回報者與其他小編", async () => {
  await resetGame();
  await commandRouter.route("Ustranger", "緊急聯絡 迷路了");
  const list = (await api("/emergencies")).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "OPEN");
  assert.equal(list[0].detail, "迷路了");

  pushed.length = 0;
  const handled = await api(`/emergencies/${list[0].id}/handle`, { method: "POST" });
  assert.equal(handled.status, 200);
  assert.ok(pushed.find((p) => p.to === "Ustranger"), "回報者收到處理中通知");
  assert.equal((await api("/emergencies")).data[0].status, "HANDLED");
});

test("後台到站：多組一起到站，可補登到站時間；到站時間不能早於出發時間、不能是未來；已到站的不會重複", async () => {
  await resetGame();
  for (const g of [1, 2, 3]) await commandRouter.route(`Ul${g}`, `報到 ${g}組`);
  const startedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await api("/depart", { method: "POST", body: { groupNos: [1, 2], startedAt } });
  pushed.length = 0;

  // 一次到站兩組（現在）
  const both = await api("/finish", { method: "POST", body: { groupNos: [1, 2] } });
  assert.equal(both.status, 200);
  assert.ok(both.data.results.every((r) => r.done && !r.notifyFailed));
  for (const g of [1, 2]) {
    const team = await teamService.findTeam(g);
    assert.equal(team.status, "FINISHED");
    assert.ok(team.finish_time);
    assert.equal(team.is_late, 0, "30 分鐘內到站是準時");
  }
  assert.ok(pushed.find((p) => p.to === "Ul1" && /終點確認成功/.test(p.messages[0].text)));

  // 已到站的組別、還沒出發的組別都不會被重複處理
  const again = await api("/finish", { method: "POST", body: { groupNos: [1, 3] } });
  assert.equal(again.data.results.find((r) => r.groupNo === 1).done, false);
  assert.match(again.data.results.find((r) => r.groupNo === 1).message, /已經辦理過終點確認/);
  assert.equal(again.data.results.find((r) => r.groupNo === 3).done, false);
  assert.match(again.data.results.find((r) => r.groupNo === 3).message, /尚未出發/);

  // 進度資料回傳到站時間
  const progress = (await api("/progress")).data.find((r) => r.groupNo === 1);
  assert.ok(progress.finishTime);
  assert.equal(progress.isLate, false);
});

test("後台到站：補登時間驗證，且補登的到站時間決定是否逾時", async () => {
  await resetGame();
  await commandRouter.route("Ul1", "報到 1組");
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await api("/depart", { method: "POST", body: { groupNos: [1], startedAt: threeHoursAgo } });

  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const r1 = await api("/finish", { method: "POST", body: { groupNos: [1], finishedAt: future } });
  assert.equal(r1.status, 400);
  assert.match(r1.data.error, /到站時間不能是未來/);
  const r2 = await api("/finish", { method: "POST", body: { groupNos: [1], finishedAt: "亂填" } });
  assert.match(r2.data.error, /到站時間格式/);

  // 早於出發時間：不會到站
  const beforeStart = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const r3 = await api("/finish", { method: "POST", body: { groupNos: [1], finishedAt: beforeStart } });
  assert.equal(r3.data.results[0].done, false);
  assert.match(r3.data.results[0].message, /不能早於.*出發時間/);
  assert.equal((await teamService.findTeam(1)).status, "IN_PROGRESS");

  // 補登「出發後 1 小時」到站：準時；補登「出發後 2.5 小時」：逾時
  const onTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 出發 3 小時前 → 1 小時後到站
  const ok = await api("/finish", { method: "POST", body: { groupNos: [1], finishedAt: onTime } });
  assert.equal(ok.data.results[0].done, true);
  assert.match(ok.data.results[0].message, /到站時間 \d{2}:\d{2}/);
  let team = await teamService.findTeam(1);
  assert.equal(team.finish_time, onTime);
  assert.equal(team.is_late, 0);

  await commandRouter.route("Uadmin", "取消到站 1組");
  const late = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 出發後約 2 小時 55 分 → 逾時
  await api("/finish", { method: "POST", body: { groupNos: [1], finishedAt: late } });
  team = await teamService.findTeam(1);
  assert.equal(team.is_late, 1, "補登的到站時間超過 2 小時 → 逾時");
});
