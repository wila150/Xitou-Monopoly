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
const lineUserStore = require("../src/config/lineUserStore");
const { getRoute } = require("../src/config/teamsRoute");

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
  await dbModule.db.run("DELETE FROM line_users");
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

// ---- 進度表單組操作（通過／退回／取消到站） ----

test("後台進度表：通過目前這一關、退回、取消到站，效果與 LINE 指令相同並通知隊伍", async () => {
  await resetGame();
  await commandRouter.route("Ul1", "報到 1組");
  await api("/depart", { method: "POST", body: { groupNos: [1] } });

  // 進度快照帶有目前關卡，給表格與「通過」按鈕確認用
  let row = (await api("/progress")).data.find((r) => r.groupNo === 1);
  const firstCp = getRoute(1)[0].checkpointId;
  assert.equal(row.currentCheckpointId, firstCp);
  assert.ok(row.currentCheckpointName);

  // 通過：前進一關，推播下一關給隊長
  pushed.length = 0;
  const approve = await api("/teams/1/approve", { method: "POST" });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.done, true);
  assert.match(approve.data.message, /已為第 1 組確認/);
  assert.equal((await teamService.findTeam(1)).current_index, 1);
  assert.ok(pushed.find((p) => p.to === "Ul1"), "隊伍收到下一關公告");

  // 退回：回到第 0 關
  const revert = await api("/teams/1/revert", { method: "POST" });
  assert.equal(revert.data.done, true);
  assert.equal((await teamService.findTeam(1)).current_index, 0);
  assert.equal((await api("/teams/1/revert", { method: "POST" })).data.done, false, "沒有進度可退回");

  // 走完 12 關到站，再用後台退回：12 → 11 並取消到站；取消到站則維持 12
  for (let i = 0; i < 12; i++) await api("/teams/1/approve", { method: "POST" });
  const done = await api("/teams/1/approve", { method: "POST" });
  assert.equal(done.data.done, false, "已走完全部關卡不能再通過");
  await api("/finish", { method: "POST", body: { groupNos: [1] } });
  row = (await api("/progress")).data.find((r) => r.groupNo === 1);
  assert.equal(row.status, "FINISHED");

  const cancel = await api("/teams/1/cancel-finish", { method: "POST" });
  assert.equal(cancel.data.done, true);
  let team = await teamService.findTeam(1);
  assert.equal(team.status, "IN_PROGRESS");
  assert.equal(team.current_index, 12);
  assert.equal((await api("/teams/1/cancel-finish", { method: "POST" })).data.done, false, "沒有終點確認可取消");

  await api("/finish", { method: "POST", body: { groupNos: [1] } });
  await api("/teams/1/revert", { method: "POST" });
  team = await teamService.findTeam(1);
  assert.equal(team.status, "IN_PROGRESS");
  assert.equal(team.current_index, 11);
  assert.equal(team.finish_time, null);

  // 不合法的組別編號
  assert.equal((await api("/teams/abc/approve", { method: "POST" })).status, 400);
});

// ---- 人員清單與角色指定 ----

test("LINE 使用者名單：互動過的人會被記下（名稱只補一次），既有的隊伍成員與關主可補登", async () => {
  await resetGame();
  assert.equal(await lineUserStore.touch("Ua"), true, "第一次出現：還缺名稱");
  await lineUserStore.setDisplayName("Ua", "阿明");
  assert.equal(await lineUserStore.touch("Ua"), false, "已有名稱就不用再問 LINE");

  await commandRouter.route("Ul1", "報到 1組");
  await commandRouter.route("Ureferee", "我是 B3 關主");
  await lineUserStore.backfill();
  const users = (await api("/line-users")).data;
  const byId = Object.fromEntries(users.map((u) => [u.userId, u]));
  assert.equal(byId.Ua.displayName, "阿明");
  assert.equal(byId.Ul1.teamLabel, "第 1 組隊長");
  assert.equal(byId.Ul1.isTeamMember, true);
  assert.equal(byId.Ureferee.refereeCheckpointId, "B3");
  // 補登進來的人還沒有名稱：列在「缺名稱」清單裡，啟動時會在背景補齊；已有名稱的（阿明）不在清單內
  const missing = await lineUserStore.listMissingNames();
  assert.ok(missing.includes("Ul1") && missing.includes("Ureferee"));
  assert.ok(!missing.includes("Ua"));
});

test("後台指定關主：不需要對方自己傳訊息，指定後對方收到通知與指令說明，可以立刻用「通過」；隊伍成員不能指定；可移除", async () => {
  await resetGame();
  await lineUserStore.touch("Ustaff");
  await lineUserStore.setDisplayName("Ustaff", "小華");
  await commandRouter.route("Ul1", "報到 1組");
  await lineUserStore.backfill();

  pushed.length = 0;
  const ok = await api("/referees", { method: "POST", body: { userId: "Ustaff", checkpointId: "b3" } });
  assert.equal(ok.status, 200);
  assert.match(ok.data.message, /B3.*關主/);
  const notice = pushed.find((p) => p.to === "Ustaff");
  assert.match(notice.messages[0].text, /小編已指定您擔任.*B3/);
  assert.match(notice.messages[1].text, /關主可用指令/);
  assert.equal(await teamService.getRefereeCheckpoint("Ustaff"), "B3");

  const listed = (await api("/referees")).data.find((r) => r.userId === "Ustaff");
  assert.equal(listed.displayName, "小華");
  assert.equal(listed.checkpointId, "B3");

  // 指定後直接生效：這個人可以用「進度」
  assert.match((await commandRouter.route("Ustaff", "進度")).reply[0].text, /B3.*預定來訪順序/);

  // 改指定到別關 = 覆蓋
  await api("/referees", { method: "POST", body: { userId: "Ustaff", checkpointId: "B4" } });
  assert.equal(await teamService.getRefereeCheckpoint("Ustaff"), "B4");

  // 錯誤：隊伍成員、不存在的關卡、缺參數
  const member = await api("/referees", { method: "POST", body: { userId: "Ul1", checkpointId: "B3" } });
  assert.equal(member.status, 400);
  assert.match(member.data.error, /已經是第 1 組的成員/);
  assert.match((await api("/referees", { method: "POST", body: { userId: "Ustaff", checkpointId: "Z9" } })).data.error, /找不到關卡/);
  assert.equal((await api("/referees", { method: "POST", body: { userId: "Ustaff" } })).status, 400);

  // 移除：對方收到通知、不再是關主；再移除一次會提示
  pushed.length = 0;
  const removed = await api("/referees/Ustaff", { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.match(pushed.find((p) => p.to === "Ustaff").messages[0].text, /已取消您的關主身分/);
  assert.equal(await teamService.getRefereeCheckpoint("Ustaff"), null);
  assert.equal((await api("/referees/Ustaff", { method: "DELETE" })).status, 400);
});

test("後台指定／移除總領隊：指定後可以用「推播」與「出發」，移除後失效", async () => {
  await resetGame();
  await lineUserStore.touch("Uboss");
  await commandRouter.route("Ul1", "報到 1組");

  const assign = await api("/broadcasters", { method: "POST", body: { userId: "Uboss" } });
  assert.equal(assign.status, 200);
  assert.match(pushed.find((p) => p.to === "Uboss").messages[0].text, /指定您擔任總領隊/);
  assert.match((await commandRouter.route("Uboss", "推播 隊長 集合")).reply[0].text, /已推播給 1 位小隊長/);
  assert.match((await commandRouter.route("Uboss", "出發 1組")).reply[0].text, /已將第 1 組標記為出發/);

  assert.equal((await api("/broadcasters", { method: "POST", body: { userId: "Ul1" } })).status, 400, "隊伍成員不能指定");
  assert.equal((await api("/broadcasters", { method: "POST", body: {} })).status, 400, "沒選人員");

  assert.equal((await api("/broadcasters/Uboss", { method: "DELETE" })).status, 200);
  assert.match((await commandRouter.route("Uboss", "推播 隊長 集合")).reply[0].text, /僅限小編或登記過的總領隊/);
  assert.equal((await api("/broadcasters/Uboss", { method: "DELETE" })).status, 400);
  assert.ok((await api("/broadcasters")).data.every((b) => b.userId !== "Uboss"));
});

test("審核佇列：空檔不會存進去；舊版留下的空檔，預覽網址回 404 並說明原因", async () => {
  await resetGame();
  const submissionStore = require("../src/config/submissionStore");
  const saved = await submissionStore.saveSubmission({
    groupNo: 1, checkpointId: "E3", mediaType: "video", mimeType: "video/mp4", buffer: Buffer.alloc(0), submittedBy: "Ux",
  });
  assert.equal(saved, false, "空的內容不存");

  // 舊版可能已經存進空檔：直接寫一筆模擬
  const row = await dbModule.db.get(
    `INSERT INTO pending_submissions (group_no, checkpoint_id, media_type, mime_type, data, submitted_by, submitted_at)
     VALUES (1, 'E3', 'video', 'video/mp4', ?, 'Ux', ?) RETURNING id`,
    [Buffer.alloc(0), new Date().toISOString()]
  );
  const res = await fetch(`${base}/api/submissions/${row.id}/media`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /檔案是空的/);

  // 正常的檔案照常回傳，且支援 Range（Safari 影片播放需要）
  const good = await submissionStore.saveSubmission({
    groupNo: 2, checkpointId: "E3", mediaType: "video", mimeType: "video/mp4", buffer: Buffer.from("0123456789"), submittedBy: "Ux",
  });
  assert.equal(good, true);
  const goodRow = (await api("/submissions")).data.find((r) => r.groupNo === 2);
  const ranged = await fetch(`${base}/api/submissions/${goodRow.id}/media`, { headers: { Cookie: cookie, Range: "bytes=2-5" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await ranged.text(), "2345");
});
