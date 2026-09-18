const test = require("node:test");
const assert = require("node:assert/strict");

// 必須在 require 任何 src 模組之前設定
// 跑測試需要一個可連線的 Postgres（本機開發：createdb line_checkpoint_test）
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://localhost/line_checkpoint_test";
process.env.PGSSL = "false";
process.env.PUBLIC_BASE_URL = "https://example.com";
process.env.ADMIN_USER_IDS = "Uadmin";

const dbModule = require("../src/db");
const configStore = require("../src/config/configStore");
const commandRouter = require("../src/handlers/commandRouter");
const teamService = require("../src/services/teamService");
const { getRoute } = require("../src/config/teamsRoute");
const { getCheckpoint } = require("../src/config/checkpoints");

const ADMIN = "Uadmin";
const STAFF = "Ustaff"; // 一般（非小編）測試帳號，用來測關主自助登記

test.before(async () => {
  await dbModule.init();
  await configStore.init();
});

test.after(async () => {
  await dbModule.pool.end();
});

// production 的「重置遊戲」刻意不會清掉關主／總領隊登記（見 README），
// 但測試需要每個 test 都從完全乾淨的狀態開始，避免前一個 test 留下的登記影響到後面，
// 所以這裡額外把這兩張表也清掉，跟 production 行為不同、僅供測試隔離用。
async function resetGame() {
  await commandRouter.route(ADMIN, "重置遊戲 確認");
  await teamService.resetReferees();
  await teamService.resetBroadcasters();
  commandRouter.resetPendingBroadcasts();
}

function textsOf(result) {
  return (result.reply || []).filter((m) => m.type === "text").map((m) => m.text);
}

// 過關公告（checkpointAnnouncement）改用 Flex 卡片後，文字內容跑進 flex.contents 的節點裡，
// 遞迴撈出所有 text 節點的內容，方便測試斷言卡片裡有沒有出現特定字樣。
function flattenFlexText(node, out) {
  if (!node || typeof node !== "object") return;
  if (node.type === "text" && typeof node.text === "string") out.push(node.text);
  if (Array.isArray(node.contents)) node.contents.forEach((c) => flattenFlexText(c, out));
  for (const key of ["hero", "body", "header", "footer"]) {
    if (node[key]) flattenFlexText(node[key], out);
  }
}

function allTexts(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.type === "text") out.push(m.text);
    if (m.type === "flex") flattenFlexText(m.contents, out);
  }
  return out;
}

// 模擬「隊伍上傳照片／影片 -> 小編輸入通過 X組」完整流程，回傳隊伍實際收到的過關訊息
async function passMediaCheckpoint(userId, groupNo) {
  await teamService.submitMedia(userId);
  const result = await commandRouter.route(ADMIN, `通過 ${groupNo}組`);
  assert.equal(result.groupBroadcasts.length, 1);
  return result.groupBroadcasts[0].messages
    .filter((m) => m.type === "text")
    .map((m) => m.text);
}

test("報到：第一位成為隊長，之後成為組員", async () => {
  await resetGame();
  const leaderResult = await commandRouter.route("Uleader", "報到 1組");
  assert.match(textsOf(leaderResult)[0], /隊長/);

  const memberResult = await commandRouter.route("Umember", "報到 1組");
  assert.match(textsOf(memberResult)[0], /組員/);

  const leaderMembership = await teamService.findMembership("Uleader");
  const memberMembership = await teamService.findMembership("Umember");
  assert.equal(leaderMembership.role, "LEADER");
  assert.equal(memberMembership.role, "MEMBER");
});

test("報到：重複報到同組為冪等提示，跨組報到被拒絕", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");

  const again = await commandRouter.route("Uleader", "報到 1組");
  assert.match(textsOf(again)[0], /已完成第 1 組報到/);

  const crossGroup = await commandRouter.route("Uleader", "報到 2組");
  assert.match(textsOf(crossGroup)[0], /先前已綁定為第 1 組/);
});

test("報到：點圖文選單「報到」按鈕後會提示回覆組別，之後單獨回覆「X組」或中文數字都算報到", async () => {
  await resetGame();
  const prompt = await commandRouter.route("Uleader", "報到");
  assert.match(textsOf(prompt)[0], /請回覆您的組別編號/);

  const bareArabic = await commandRouter.route("Uleader", "1組");
  assert.match(textsOf(bareArabic)[0], /隊長/);
  assert.equal((await teamService.findMembership("Uleader")).group_no, 1);

  const chineseWithDi = await commandRouter.route("Umember", "第一組");
  assert.match(textsOf(chineseWithDi)[0], /組員/);
  assert.equal((await teamService.findMembership("Umember")).group_no, 1);

  const chineseNoDi = await commandRouter.route("Umember2", "十組");
  assert.match(textsOf(chineseNoDi)[0], /隊長/);
  assert.equal((await teamService.findMembership("Umember2")).group_no, 10);
});

test("我的ID：任何人都能查自己的 userId，不需要報到或任何身分", async () => {
  await resetGame();
  const result = await commandRouter.route("UsomeRandomPerson", "我的ID");
  assert.match(textsOf(result)[0], /UsomeRandomPerson/);
});

test("登記／報到成功後，會主動附上該身分自己可用的指令說明（不含小編專用指令）", async () => {
  await resetGame();
  const leader = await commandRouter.route("Uleader", "報到 1組");
  assert.match(textsOf(leader)[1], /隊伍可用指令/);
  assert.match(textsOf(leader)[1], /您是隊長/);

  const member = await commandRouter.route("Umember", "報到 1組");
  assert.match(textsOf(member)[1], /接任隊長 X組/);
  assert.match(textsOf(member)[1], /關卡公告只會推播給隊長/);

  const referee = await commandRouter.route("Ureferee", "關主報到");
  assert.match(textsOf(referee)[0], /請回覆您負責的關卡/);
  const registered = await commandRouter.route("Ureferee", "B3");
  assert.match(textsOf(registered)[0], /已登記為「救救菜英文」（B3）的關主/);
  assert.match(textsOf(registered)[1], /關主可用指令/);
  assert.match(textsOf(registered)[1], /進度/);
  assert.match(textsOf(registered)[1], /通過 X組/);

  const broadcaster = await commandRouter.route(STAFF, "總領綁定");
  assert.match(textsOf(broadcaster)[0], /已登記為總領隊/);
  assert.match(textsOf(broadcaster)[1], /總領隊可用指令/);
  assert.match(textsOf(broadcaster)[1], /推播 隊長 訊息內容/);

  // 隊伍與關主的說明都不該洩漏小編專用指令
  for (const text of [textsOf(leader)[1], textsOf(member)[1], textsOf(registered)[1], textsOf(broadcaster)[1]]) {
    assert.doesNotMatch(text, /重置遊戲|解除綁定|加分 X組|確認換隊長/);
  }
});

test("登記入口說法很彈性：關主報到／關主綁定／報到 關主，總領綁定／總領報到／總領隊綁定都可以", async () => {
  await resetGame();
  for (const phrase of ["關主報到", "關主綁定", "報到 關主", "報到關主", "綁定 關主"]) {
    const r = await commandRouter.route(STAFF, phrase);
    assert.match(textsOf(r)[0], /請回覆您負責的關卡代號或名稱完成登記/, phrase);
  }
  for (const [i, phrase] of ["總領綁定", "總領報到", "總領隊綁定", "報到 總領", "綁定總領隊"].entries()) {
    await teamService.resetBroadcasters();
    const r = await commandRouter.route(`Ubc${i}`, phrase);
    assert.match(textsOf(r)[0], /已登記為總領隊/, phrase);
  }
  // 一般的「報到」還是隊伍報到，不受影響
  const team = await commandRouter.route("Uplain", "報到");
  assert.match(textsOf(team)[0], /請回覆您的組別編號/);
});

test("使用說明：依身分回覆不同內容，多重身分一併列出，小編指令只給小編看", async () => {
  await resetGame();
  // 還沒有任何身分：一般說明，只教報到流程，不出現關主／總領隊／小編指令
  const general = textsOf(await commandRouter.route("Ustranger", "使用說明"));
  assert.equal(general.length, 1);
  assert.match(general[0], /1️⃣ 報到/);
  assert.doesNotMatch(general[0], /推播|通過 X組|重置遊戲|關主報到/);

  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route("Umember", "報到 1組");
  const leader = textsOf(await commandRouter.route("Uleader", "使用說明"));
  assert.match(leader[0], /第 1 組隊長/);
  assert.match(leader[0], /目前關卡/);
  const member = textsOf(await commandRouter.route("Umember", "使用說明"));
  assert.match(member[0], /第 1 組組員/);
  assert.match(member[0], /接任隊長 X組/);

  await commandRouter.route("Ureferee", "我是 B3 關主");
  const referee = textsOf(await commandRouter.route("Ureferee", "使用說明"));
  assert.equal(referee.length, 1);
  assert.match(referee[0], /B3「救救菜英文」關主/);
  assert.match(referee[0], /通過 X組/);

  // 關主兼總領隊：兩份說明一起給
  await commandRouter.route("Ureferee", "總領綁定");
  const both = textsOf(await commandRouter.route("Ureferee", "使用說明"));
  assert.equal(both.length, 2);
  assert.match(both[1], /使用說明｜總領隊/);

  const admin = textsOf(await commandRouter.route(ADMIN, "使用說明"));
  assert.match(admin[0], /使用說明｜小編/);
  assert.match(admin[0], /重置遊戲/);

  // 隊伍、關主的說明不洩漏小編專用指令
  for (const text of [leader[0], member[0], referee[0]]) {
    assert.doesNotMatch(text, /重置遊戲|解除綁定|加分 X組|確認換隊長/);
  }
});

test("出發：未報到組別無法出發，成功後廣播第一關", async () => {
  await resetGame();
  const noTeam = await commandRouter.route(ADMIN, "出發 9組");
  assert.match(textsOf(noTeam)[0], /尚未有任何成員報到/);

  await commandRouter.route("Uleader", "報到 1組");
  const depart = await commandRouter.route(ADMIN, "出發 1組");
  assert.equal(depart.groupBroadcasts.length, 1);
  assert.equal(depart.groupBroadcasts[0].groupNo, 1);
  // 過關公告改用 Flex 卡片，「地點／過關方式」文字跑進卡片節點裡，用 allTexts 遞迴撈出來檢查
  const broadcastTexts = allTexts(depart.groupBroadcasts[0].messages);
  assert.ok(depart.groupBroadcasts[0].messages.some((m) => m.type === "flex"));
  assert.ok(broadcastTexts.some((t) => t.includes("出發")));
  assert.ok(broadcastTexts.some((t) => t.includes("請先移動到")));
  assert.ok(broadcastTexts.some((t) => t.includes("地點")));
  assert.ok(broadcastTexts.some((t) => t.includes("過關方式")));

  const again = await commandRouter.route(ADMIN, "出發 1組");
  assert.match(textsOf(again)[0], /已經出發過了/);
});

test("關主主動通知：出發跟過關時，登記在下一關的關主會收到「隊伍正往你這關來」的推播", async () => {
  await resetGame();
  // 第1組路線：D5（第一關）-> B3（第二關）
  await commandRouter.route("Ud5referee", "我是 D5 關主");
  await commandRouter.route("Ub3referee", "我是 B3 關主");
  await commandRouter.route("Uleader", "報到 1組");

  const depart = await commandRouter.route(ADMIN, "出發 1組");
  assert.equal(depart.directPushes.length, 1);
  assert.equal(depart.directPushes[0].to, "Ud5referee");
  assert.match(depart.directPushes[0].messages[0].text, /第 1 組正往您這關（D5/);

  // D5 是 photo 類型，走「上傳 -> 小編通過」流程過關，過關後應該通知 B3 的關主
  await teamService.submitMedia("Uleader");
  const approve = await commandRouter.route(ADMIN, "通過 1組");
  assert.equal(approve.directPushes.length, 1);
  assert.equal(approve.directPushes[0].to, "Ub3referee");
  assert.match(approve.directPushes[0].messages[0].text, /第 1 組正往您這關（B3/);
});

test("關主專用進度查詢：「進度」依路線預定順序列出這關的組別，每組標上實際進度（在路上／已抵達／已通過）", async () => {
  await resetGame();
  await commandRouter.route("Ub3referee", "我是 B3 關主");
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組"); // 第1組目前在 D5，B3 是下一關

  const enRoute = await commandRouter.route("Ub3referee", "進度");
  assert.match(textsOf(enRoute)[0], /1組（第 2 關）｜🚶 已出發，還在路上/);

  await teamService.submitMedia("Uleader");
  await commandRouter.route(ADMIN, "通過 1組"); // 第1組現在剛好卡在 B3

  const arrived = await commandRouter.route("Ub3referee", "進度");
  assert.match(textsOf(arrived)[0], /1組（第 2 關）｜✋ 已抵達，等待確認/);
  assert.match(textsOf(arrived)[0], /現在等您確認：1組/);

  await commandRouter.route(ADMIN, "通過 1組"); // 通過 B3 之後歸到「已通過」，不再是等待確認

  const passed = await commandRouter.route("Ub3referee", "進度");
  assert.match(textsOf(passed)[0], /1組（第 2 關）｜✅ 已通過（\d{2}:\d{2}）/);
  assert.doesNotMatch(textsOf(passed)[0], /現在等您確認/);
});

test("關主看預定來訪順序：照路線設定排（第幾關、組別號碼），每組標上實際進度；「順序」等同「進度」；小編用「順序 B3」；無關身分被拒絕", async () => {
  await resetGame();
  await commandRouter.route("Ub3referee", "我是 B3 關主");

  // 還沒有任何隊伍報到：預定順序照樣列出，全部是尚未報到
  const empty = textsOf(await commandRouter.route("Ub3referee", "進度"))[0];
  assert.match(empty, /B3.*預定來訪順序/);

  // 預期順序＝依「B3 是各組路線的第幾關」排，同一關再依組別號碼
  const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    .map((g) => ({ g, idx: getRoute(g).findIndex((s) => s.checkpointId === "B3") }))
    .filter((x) => x.idx !== -1)
    .sort((a, b) => a.idx - b.idx || a.g - b.g)
    .map((x) => x.g);
  const groupsInText = [...empty.matchAll(/[①-⑳] (\d+)組/g)].map((m) => Number(m[1]));
  assert.deepEqual(groupsInText, expected);
  assert.match(empty, /1組（第 \d+ 關）｜⏳ 尚未報到/);

  // 第 1 組報到出發、走到 B3 並通過；第 2 組報到出發，還在路上
  await commandRouter.route("Ul1", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  const idx1 = getRoute(1).findIndex((s) => s.checkpointId === "B3");
  for (let i = 0; i < idx1; i++) await commandRouter.route(ADMIN, "通過 1組");
  await commandRouter.route("Ul2", "報到 2組");
  await commandRouter.route(ADMIN, "出發 2組");
  await commandRouter.route("Ul3", "報到 3組"); // 報到了但還沒出發

  const mid = textsOf(await commandRouter.route("Ub3referee", "順序"))[0];
  assert.match(mid, /現在等您確認：1組/);
  assert.match(mid, /1組（第 \d+ 關）｜✋ 已抵達，等待確認/);
  assert.match(mid, /2組（第 \d+ 關）｜🚶 已出發，還在路上（還差 \d+ 關）/);
  assert.match(mid, /3組（第 \d+ 關）｜⏳ 尚未出發/);

  await commandRouter.route(ADMIN, "通過 1組");
  const after = textsOf(await commandRouter.route("Ub3referee", "組別順序"))[0];
  assert.match(after, /1組（第 \d+ 關）｜✅ 已通過（\d{2}:\d{2}）/);
  assert.doesNotMatch(after, /現在等您確認/);

  // 小編指定關卡（代號或名稱）；沒指定要提示；沒身分的人被拒絕
  assert.match(textsOf(await commandRouter.route(ADMIN, "順序 b3"))[0], /B3.*預定來訪順序/);
  assert.match(textsOf(await commandRouter.route(ADMIN, "順序 救救菜英文"))[0], /B3.*預定來訪順序/);
  assert.match(textsOf(await commandRouter.route(ADMIN, "順序"))[0], /請指定關卡/);
  assert.match(textsOf(await commandRouter.route("Unobody", "順序"))[0], /僅限小編或登記過的關主使用/);
});

test("關卡公告推播範圍：預設只推隊長，切成 all 之後改推全組成員，可以隨時切回來", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組"); // 第一位報到者是隊長
  await commandRouter.route("Umember", "報到 1組");

  assert.equal(configStore.getBroadcastScope(), "leader");
  const leaderOnly = await teamService.getGroupBroadcastRecipientIds(1);
  assert.deepEqual(leaderOnly, ["Uleader"]);

  await configStore.setBroadcastScope("all");
  const allMembers = await teamService.getGroupBroadcastRecipientIds(1);
  assert.deepEqual(new Set(allMembers), new Set(["Uleader", "Umember"]));

  await configStore.setBroadcastScope("leader");
  assert.deepEqual(await teamService.getGroupBroadcastRecipientIds(1), ["Uleader"]);
});

test("關鍵字：答錯提示錯誤、答對晉級、全破後提示前往B6", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");

  const route = getRoute(1);
  const firstKeywordIndex = route.findIndex(
    (s) => getCheckpoint(s.checkpointId).verifyType === "keyword"
  );
  for (let i = 0; i < firstKeywordIndex; i++) {
    await passMediaCheckpoint("Uleader", 1);
  }
  const wrong = await commandRouter.route("Uleader", "亂打的關鍵字");
  assert.match(textsOf(wrong)[0], /不正確/);
  for (let i = firstKeywordIndex; i < route.length - 1; i++) {
    const step = route[i];
    const cp = getCheckpoint(step.checkpointId);
    if (cp.verifyType === "keyword") {
      const result = await commandRouter.route("Uleader", step.keyword);
      assert.match(textsOf(result)[0], /✅ 通關/);
    } else {
      const msgs = await passMediaCheckpoint("Uleader", 1);
      assert.match(msgs[0], /✅ 通關/);
    }
  }
  const last = route[route.length - 1];
  const lastCp = getCheckpoint(last.checkpointId);
  let lastReply;
  if (lastCp.verifyType === "keyword") {
    lastReply = textsOf(await commandRouter.route("Uleader", last.keyword));
  } else {
    lastReply = await passMediaCheckpoint("Uleader", 1);
  }
  assert.ok(lastReply.some((t) => t.includes("請儘速前往 B6 辦理終點確認")));

  const team = await teamService.findTeam(1);
  assert.equal(team.current_index, route.length);
});

test("照片／影片審核：上傳後不會自動過關，小編通過才解鎖下一關", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  // 第1組路線第一關是 D5（無關主，photo）

  const submit = await teamService.submitMedia("Uleader");
  assert.match(textsOf({ reply: submit.reply })[0], /請等待小編確認/);
  assert.equal(submit.adminNotify.length, 1);
  assert.equal(submit.adminNotify[0].to, ADMIN);
  assert.match(submit.adminNotify[0].messages[0].text, /上傳了照片/);

  // 還沒被小編通過，關卡進度不應前進
  const teamBefore = await teamService.findTeam(1);
  assert.equal(teamBefore.current_index, 0);

  // 非小編、非登記關主不能通過審核
  const deniedApprove = await commandRouter.route("Uleader", "通過 1組");
  assert.match(textsOf(deniedApprove)[0], /僅限小編或登記過的關主使用/);

  const approve = await commandRouter.route(ADMIN, "通過 1組");
  assert.match(textsOf(approve)[0], /已為第 1 組確認/);
  assert.equal(approve.groupBroadcasts.length, 1);
  const teamMsgs = approve.groupBroadcasts[0].messages
    .filter((m) => m.type === "text")
    .map((m) => m.text);
  assert.ok(teamMsgs.some((t) => t.includes("✅ 通關")));

  const teamAfter = await teamService.findTeam(1);
  assert.equal(teamAfter.current_index, 1);
});

test("照片／影片審核佇列：後台網頁可以看到待審核媒體，按通過會過關並清空佇列", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  // 第1組路線第一關是 D5（無關主，photo）

  const submit = await teamService.submitMedia("Uleader", {
    buffer: Buffer.from("fake-jpeg-bytes"),
    mimeType: "image/jpeg",
  });
  assert.match(submit.adminNotify[0].messages[0].text, /照片／影片審核」分頁直接預覽/);
  // 通知底下附「一鍵通過」快速回覆按鈕，小編點一下就等同輸入「通過 1組」
  const quick = submit.adminNotify[0].messages[0].quickReply.items[0].action;
  assert.equal(quick.type, "message");
  assert.equal(quick.text, "通過 1組");
  assert.match(submit.adminNotify[0].messages[0].text, /example\.com\/admin#submissions/);

  const pending = await teamService.listPendingSubmissions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].groupNo, 1);
  assert.equal(pending[0].mediaType, "photo");

  const approved = await teamService.approveSubmissionById(pending[0].id);
  assert.match(approved.reply[0].text, /已為第 1 組確認/);
  assert.equal(approved.groupBroadcast.groupNo, 1);

  // 通過後審核佇列應該被清空（該組所有待審核紀錄都失效了）
  assert.equal((await teamService.listPendingSubmissions()).length, 0);
  assert.equal((await teamService.findTeam(1)).current_index, 1);
});

test("關卡型態不符：關主關卡上傳照片、無關主關卡輸入文字，都會提示正確方式", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  // 第1組路線第一關是 D5（無關主，photo）
  const wrongMode1 = await commandRouter.route("Uleader", "隨便打字");
  assert.match(textsOf(wrongMode1)[0], /直接上傳/);

  // 走到下一個關主(keyword)關卡前
  const route = getRoute(1);
  const keywordIndex = route.findIndex(
    (s) => getCheckpoint(s.checkpointId).verifyType === "keyword"
  );
  for (let i = 0; i < keywordIndex; i++) {
    await passMediaCheckpoint("Uleader", 1);
  }
  const mediaOnKeyword = await teamService.submitMedia("Uleader");
  assert.match(textsOf({ reply: mediaOnKeyword.reply })[0], /需要向關主取得關鍵字/);
  assert.equal(mediaOnKeyword.adminNotify.length, 0);
});

test("通過指令不限關卡類型：小編也可以對關主關卡直接喊過，當作手動捷徑", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");

  // 走到第一個關主(keyword)關卡
  const route = getRoute(1);
  const keywordIndex = route.findIndex(
    (s) => getCheckpoint(s.checkpointId).verifyType === "keyword"
  );
  for (let i = 0; i < keywordIndex; i++) {
    await passMediaCheckpoint("Uleader", 1);
  }

  const approveOnKeyword = await commandRouter.route(ADMIN, "通過 1組");
  assert.match(textsOf(approveOnKeyword)[0], /已為第 1 組確認/);
  assert.equal(approveOnKeyword.groupBroadcasts.length, 1);

  const team = await teamService.findTeam(1);
  assert.equal(team.current_index, keywordIndex + 1);
});

test("組別編號指令（出發／通過等）都支援「第X組」跟中文數字，不是只有阿拉伯數字", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");

  const depart = await commandRouter.route(ADMIN, "出發第一組");
  assert.match(textsOf(depart)[0], /出發/);
  assert.equal((await teamService.findTeam(1)).status, "IN_PROGRESS");

  const approve = await commandRouter.route(ADMIN, "通過 第1組");
  assert.match(textsOf(approve)[0], /已為第 1 組確認/);
  assert.equal((await teamService.findTeam(1)).current_index, 1);

  const approveChinese = await commandRouter.route(ADMIN, "通過一組");
  assert.match(textsOf(approveChinese)[0], /已為第 1 組確認/);
  assert.equal((await teamService.findTeam(1)).current_index, 2);
});

test("組別編號指令：動詞跟組別誰先誰後都可以，「1組出發」跟「出發1組」等價", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "1組報到");
  assert.equal((await teamService.findTeam(1)).status, "CHECKED_IN");

  const depart = await commandRouter.route(ADMIN, "1組出發");
  assert.match(textsOf(depart)[0], /出發/);
  assert.equal((await teamService.findTeam(1)).status, "IN_PROGRESS");

  const approve = await commandRouter.route(ADMIN, "第1組通過");
  assert.match(textsOf(approve)[0], /已為第 1 組確認/);
  assert.equal((await teamService.findTeam(1)).current_index, 1);
});

test("到站：B6工作人員觸發終點確認，完賽指令改為提示訊息", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route("Umember", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  await commandRouter.route("Ub6staff", "我是 B6 關主"); // 終點工作人員要先登記在 B6

  const oldFinish = await commandRouter.route("Uleader", "完賽");
  assert.match(textsOf(oldFinish)[0], /終點確認」制/);

  const arrive = await commandRouter.route("Ub6staff", "到站 1組");
  assert.match(textsOf(arrive)[0], /已為第 1 組辦理終點確認/);
  assert.equal(arrive.groupBroadcasts.length, 1);
  const teamMsgs = arrive.groupBroadcasts[0].messages
    .filter((m) => m.type === "text")
    .map((m) => m.text);
  assert.ok(teamMsgs.some((t) => t.includes("🏁 終點確認成功")));

  const team = await teamService.findTeam(1);
  assert.equal(team.status, "FINISHED");

  // 已終點確認後，關卡訊息不再有回應
  const strayText = await commandRouter.route("Uleader", "隨便打的字");
  assert.equal(strayText.reply, null);
});

test("到站：尚未出發或尚未報到都會被拒絕，重複到站為冪等", async () => {
  await resetGame();
  const noTeam = await commandRouter.route(ADMIN, "到站 8組");
  assert.match(textsOf(noTeam)[0], /尚未有任何成員報到/);

  await commandRouter.route("Uleader", "報到 8組");
  const notDeparted = await commandRouter.route(ADMIN, "到站 8組");
  assert.match(textsOf(notDeparted)[0], /尚未出發/);

  await commandRouter.route(ADMIN, "出發 8組");
  await commandRouter.route(ADMIN, "到站 8組");
  const again = await commandRouter.route(ADMIN, "到站 8組");
  assert.match(textsOf(again)[0], /已經辦理過終點確認/);
});

test("管理指令：非小編一律被拒絕", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");

  const denied = await Promise.all([
    commandRouter.route("Uleader", "遊戲結束"),
    commandRouter.route("Uleader", "排行榜開啟"),
    commandRouter.route("Uleader", "解除綁定 1組"),
    commandRouter.route("Uleader", "確認換隊長 1組"),
    commandRouter.route("Uleader", "重置遊戲"),
  ]);
  for (const r of denied) {
    assert.match(textsOf(r)[0], /僅限小編使用/);
  }

  // 「進度」比較特別：非小編、也非登記關主才會被拒絕（登記過的關主可以查詢，見後面的關主專用進度測試）
  const progressDenied = await commandRouter.route("Uleader", "進度");
  assert.match(textsOf(progressDenied)[0], /僅限小編或登記過的關主使用/);
});

test("遊戲結束：只凍結關卡進度，不會產生終點確認，之後仍可到站", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");

  const result = await commandRouter.route(ADMIN, "遊戲結束");
  assert.match(textsOf(result)[0], /已停止受理新的關卡進度/);
  assert.equal(result.groupBroadcasts.length, 1);

  // 凍結後嘗試過關會被拒絕
  const route = getRoute(1);
  const firstKeywordStep = route.find(
    (s) => getCheckpoint(s.checkpointId).verifyType === "keyword"
  );
  const frozenAttempt = await commandRouter.route("Uleader", firstKeywordStep.keyword);
  assert.match(textsOf(frozenAttempt)[0], /已停止受理新的關卡進度/);

  // 到站仍然有效
  const arrive = await commandRouter.route(ADMIN, "到站 1組");
  assert.match(textsOf(arrive)[0], /已為第 1 組辦理終點確認/);

  const again = await commandRouter.route(ADMIN, "遊戲結束");
  assert.match(textsOf(again)[0], /已經是停止受理新關卡進度的狀態了/);
});

test("換隊長：組員申請、小編核准後角色互換", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route("Umember", "報到 1組");

  const requestResult = await commandRouter.route("Umember", "接任隊長 1組");
  assert.match(textsOf(requestResult)[0], /已送出接任隊長申請/);
  assert.equal(requestResult.directPushes.length, 1);
  assert.equal(requestResult.directPushes[0].to, ADMIN);

  const confirmResult = await commandRouter.route(ADMIN, "確認換隊長 1組");
  assert.match(textsOf(confirmResult)[0], /更換完成/);

  assert.equal((await teamService.findMembership("Umember")).role, "LEADER");
  assert.equal((await teamService.findMembership("Uleader")).role, "MEMBER");
});

test("解除綁定：清空後可重新報到", async () => {
  await resetGame();
  await commandRouter.route("Uwrong", "報到 3組");
  assert.ok(await teamService.findMembership("Uwrong"));

  await commandRouter.route(ADMIN, "解除綁定 3組");
  assert.equal(await teamService.findMembership("Uwrong"), undefined);
  assert.equal(await teamService.findTeam(3), undefined);

  const rebind = await commandRouter.route("Uwrong", "報到 5組");
  assert.match(textsOf(rebind)[0], /第 5 組隊長/);
});

test("排行榜：預設不公開，開啟後任何人可查詢；準時到站排在未歸隊前面", async () => {
  await resetGame();
  await commandRouter.route("Uleader1", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  await commandRouter.route(ADMIN, "到站 1組");

  await commandRouter.route("Uleader2", "報到 2組");
  await commandRouter.route(ADMIN, "出發 2組");

  const closed = await commandRouter.route("Uleader1", "排行榜");
  assert.match(textsOf(closed)[0], /僅開放小編查詢/);

  await commandRouter.route(ADMIN, "排行榜開啟");
  const open = await commandRouter.route("Uleader1", "排行榜");
  const text = textsOf(open)[0];
  assert.match(text, /排行榜/);
  assert.doesNotMatch(text, /僅開放小編查詢/);
  assert.ok(text.indexOf("1組") < text.indexOf("2組"), "已到站的1組應排在未歸隊的2組前面");
});

test("加分：小編可以任意時機幫某組加分／扣分，會影響排行榜排序且非小編不能用", async () => {
  await resetGame();
  await commandRouter.route("Uleader1", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  await commandRouter.route("Uleader2", "報到 2組");
  await commandRouter.route(ADMIN, "出發 2組");

  const denied = await commandRouter.route(STAFF, "加分 1組 5");
  assert.match(textsOf(denied)[0], /僅限小編使用/);

  // 2組目前跟1組進度一樣（都還沒過任何關），加5分後應該排到1組前面
  const bonus = await commandRouter.route(ADMIN, "加分 第2組 5 完成指定任務");
  assert.match(textsOf(bonus)[0], /已為第 2 組加分 5 分（理由：完成指定任務），目前累計加分：5/);

  await commandRouter.route(ADMIN, "排行榜開啟");
  const ranking = textsOf(await commandRouter.route(ADMIN, "排行榜"))[0];
  assert.ok(ranking.indexOf("2組") < ranking.indexOf("1組"), "加分後2組應排在1組前面");
  assert.match(ranking, /加分 \+5/);

  // 扣分：負數也支援，且可以用中文數字＋不加「第」的組別格式
  const penalty = await commandRouter.route(ADMIN, "加分 二組 -8 犯規扣分");
  assert.match(textsOf(penalty)[0], /已為第 2 組扣分 8 分（理由：犯規扣分），目前累計加分：-3/);

  // 後台網頁「加分紀錄」分頁：每一筆加分／扣分都留有明細，最新的排最前面
  const log = await teamService.listBonusLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].points, -8);
  assert.equal(log[0].reason, "犯規扣分");
  assert.equal(log[1].points, 5);
  assert.equal(log[1].reason, "完成指定任務");
});

test("加分：對尚未報到的組別加分會被拒絕", async () => {
  await resetGame();
  const result = await commandRouter.route(ADMIN, "加分 5組 10");
  assert.match(textsOf(result)[0], /尚未有任何成員報到，無法加分/);
});

test("重置遊戲：需兩步驟確認", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");

  const warn = await commandRouter.route(ADMIN, "重置遊戲");
  assert.match(textsOf(warn)[0], /請輸入「重置遊戲 確認」/);
  assert.ok(await teamService.findMembership("Uleader"));

  await commandRouter.route(ADMIN, "重置遊戲 確認");
  assert.equal(await teamService.findMembership("Uleader"), undefined);
});

test("報到：不存在的組別編號會被拒絕，不會建立幽靈隊伍", async () => {
  await resetGame();
  const result = await commandRouter.route("Uleader", "報到 99組");
  assert.match(textsOf(result)[0], /第 99 組不存在/);
  assert.equal(await teamService.findMembership("Uleader"), undefined);
  assert.equal(await teamService.findTeam(99), undefined);

  // 確保沒有殘留的幽靈隊伍讓「出發」之類的指令壞掉
  const depart = await commandRouter.route(ADMIN, "出發 99組");
  assert.match(textsOf(depart)[0], /尚未有任何成員報到/);
});

test("凍結進度後，「通過」也不能再讓關卡前進（跟關鍵字比對一致）", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  await commandRouter.route(ADMIN, "遊戲結束");

  await teamService.submitMedia("Uleader"); // 第1組第一關 D5 是 photo
  const approveAfterFreeze = await commandRouter.route(ADMIN, "通過 1組");
  assert.match(textsOf(approveAfterFreeze)[0], /已停止受理新的關卡進度/);

  const team = await teamService.findTeam(1);
  assert.equal(team.current_index, 0);
});

test("退回：小編手滑連按兩次「通過」造成跳關，可以用「退回」更正", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");

  // 模擬手滑連按兩次「通過」，跳過了本來該做的第二關任務
  await commandRouter.route(ADMIN, "通過 1組");
  await commandRouter.route(ADMIN, "通過 1組");
  let team = await teamService.findTeam(1);
  assert.equal(team.current_index, 2);

  const revert = await commandRouter.route(ADMIN, "退回 1組");
  assert.match(textsOf(revert)[0], /已將第 1 組退回到/);
  assert.equal(revert.groupBroadcasts.length, 1);
  assert.match(revert.groupBroadcasts[0].messages[0].text, /重新視為未完成/);

  team = await teamService.findTeam(1);
  assert.equal(team.current_index, 1, "退回後應該回到只完成一關");

  // 沒有進度可退回時的提示
  await commandRouter.route(ADMIN, "退回 1組");
  const noMore = await commandRouter.route(ADMIN, "退回 1組");
  assert.match(textsOf(noMore)[0], /沒有可以退回的關卡進度/);
});

test("退回：還沒完成任何關卡就被終點確認時，沒有關卡可退，只取消終點確認", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  await commandRouter.route(ADMIN, "到站 1組");

  let team = await teamService.findTeam(1);
  assert.equal(team.status, "FINISHED");

  const revert = await commandRouter.route(ADMIN, "退回 1組");
  assert.match(textsOf(revert)[0], /已取消第 1 組的終點確認/);

  team = await teamService.findTeam(1);
  assert.equal(team.status, "IN_PROGRESS");
  assert.equal(team.finish_time, null);
  assert.equal(team.current_index, 0);
});

test("退回：已完成 12 關並到站的組別，退回會真的退一關（12→11）並取消終點確認、清掉結束時間與逾時，排行榜與查詢同步更新", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route("Ureferee", "我是 A2 關主"); // 用來驗證退回後關主會被通知
  await teamService.depart(1, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()); // 出發 3 小時前，到站會逾時
  for (let i = 0; i < 12; i++) await commandRouter.route(ADMIN, "通過 1組");
  await commandRouter.route(ADMIN, "到站 1組");

  let team = await teamService.findTeam(1);
  assert.equal(team.status, "FINISHED");
  assert.equal(team.current_index, 12);
  assert.equal(team.is_late, 1);
  const lastCheckpointId = getRoute(1)[11].checkpointId;

  const revert = await commandRouter.route(ADMIN, "退回 1組");
  assert.match(textsOf(revert)[0], /退回到「.*」（11\/12 關）.*一併取消終點確認/);
  assert.match(revert.groupBroadcasts[0].messages[0].text, /終點確認也已取消/);

  team = await teamService.findTeam(1);
  assert.equal(team.current_index, 11, "完成關卡數真的 -1");
  assert.equal(team.status, "IN_PROGRESS");
  assert.equal(team.finish_time, null, "結束時間清掉");
  assert.equal(team.is_late, 0, "逾時標記清掉，之後真的到站再重新判斷");

  // 隊伍查詢：回到第 12 關（目前關卡）、闖關進度 11/12
  const current = allTexts((await commandRouter.route("Uleader", "目前關卡")).reply).join("\n");
  assert.match(current, new RegExp(getCheckpoint(lastCheckpointId).name));
  assert.match(textsOf(await commandRouter.route("Uleader", "闖關進度"))[0], /已完成 11\/12 關/);

  // 排行榜與小編總覽：11/12、未歸隊，不再是 12/12 準時／逾時
  await commandRouter.route(ADMIN, "排行榜開啟");
  const ranking = textsOf(await commandRouter.route(ADMIN, "排行榜"))[0];
  assert.match(ranking, /1組｜11\/12｜目前耗時 .*（未歸隊）/);
  assert.doesNotMatch(ranking, /12\/12/);
  assert.match(textsOf(await commandRouter.route(ADMIN, "進度"))[0], /1組｜闖關中｜11\/12/);

  // 該關的通過紀錄被刪掉：可以再通過一次，重新到站後照新的時間判斷
  const logRows = await dbModule.db.all("SELECT * FROM checkpoint_log WHERE group_no = 1");
  assert.equal(logRows.length, 11);
  await commandRouter.route(ADMIN, "通過 1組");
  assert.equal((await teamService.findTeam(1)).current_index, 12);
});

test("取消到站：只取消誤按的終點確認，完成關卡數不變；非小編不能用；沒有終點確認時提示", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");
  for (let i = 0; i < 12; i++) await commandRouter.route(ADMIN, "通過 1組");
  await commandRouter.route(ADMIN, "到站 1組");

  assert.match(textsOf(await commandRouter.route("Uleader", "取消到站 1組"))[0], /僅限小編使用/);
  assert.equal((await teamService.findTeam("1")).status, "FINISHED");

  const cancel = await commandRouter.route(ADMIN, "取消到站 1組");
  assert.match(textsOf(cancel)[0], /已取消第 1 組的終點確認（完成關卡數維持 12\/12）/);
  const team = await teamService.findTeam(1);
  assert.equal(team.status, "IN_PROGRESS");
  assert.equal(team.current_index, 12, "完成關卡數不變");
  assert.equal(team.finish_time, null);

  assert.match(textsOf(await commandRouter.route(ADMIN, "取消到站 1組"))[0], /沒有終點確認可以取消/);
  assert.match(textsOf(await commandRouter.route(ADMIN, "取消到站 8組"))[0], /尚未有任何成員報到/);

  // 重新到站後恢復正常
  assert.match(textsOf(await commandRouter.route(ADMIN, "到站 1組"))[0], /已為第 1 組辦理終點確認/);
});

test("出發／到站權限：隊伍成員與陌生人不能替任何一組出發或到站；出發＝小編／關主／總領隊，到站＝小編／登記在 B6 的關主", async () => {
  await resetGame();
  await commandRouter.route("Ulead1", "報到 1組");
  await commandRouter.route("Ulead2", "報到 2組");
  await commandRouter.route("Ub3ref", "我是 B3 關主");
  await commandRouter.route("Ub6ref", "我是 B6 關主");
  await commandRouter.route("Ubroadcaster", "總領綁定");

  // 隊長替別組出發、陌生人替任何組出發：被擋，計時不會被動到
  for (const who of ["Ulead1", "Ustranger"]) {
    for (const target of ["1組", "2組"]) {
      const r = await commandRouter.route(who, `出發 ${target}`);
      assert.match(textsOf(r)[0], /「出發」僅限小編或登記過的關主／總領隊/);
      assert.equal(r.groupBroadcasts.length, 0);
    }
  }
  assert.equal((await teamService.findTeam(1)).status, "CHECKED_IN");
  assert.equal((await teamService.findTeam(2)).status, "CHECKED_IN");

  // 可以出發的身分：小編、任一位關主、總領隊
  assert.match(textsOf(await commandRouter.route(ADMIN, "出發 1組"))[0], /已將第 1 組標記為出發/);
  assert.match(textsOf(await commandRouter.route("Ub3ref", "出發 2組"))[0], /已將第 2 組標記為出發/);
  await commandRouter.route("Ulead3", "報到 3組");
  assert.match(textsOf(await commandRouter.route("Ubroadcaster", "出發 3組"))[0], /已將第 3 組標記為出發/);

  // 到站：隊長自己、陌生人、其他關卡的關主、總領隊都不行，沒有終點確認也沒有動到計時
  for (const who of ["Ulead1", "Ustranger", "Ub3ref", "Ubroadcaster"]) {
    const r = await commandRouter.route(who, "到站 1組");
    assert.match(textsOf(r)[0], /「到站」僅限小編或登記在 B6 的關主/, `${who} 不能到站`);
    assert.match(textsOf(r)[0], /我是 B6 關主/);
  }
  const still = await teamService.findTeam(1);
  assert.equal(still.status, "IN_PROGRESS");
  assert.equal(still.finish_time, null);

  // 小編、登記在 B6 的關主可以
  assert.match(textsOf(await commandRouter.route("Ub6ref", "到站 1組"))[0], /已為第 1 組辦理終點確認/);
  assert.match(textsOf(await commandRouter.route(ADMIN, "到站 2組"))[0], /已為第 2 組辦理終點確認/);
});

test("逾時判斷是看「出發後經過多久」，不是比對當天固定時刻", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");

  // 立刻到站：不管現在實際時間是幾點，都應該算準時（出發到到站沒幾毫秒）
  const arrive = await commandRouter.route(ADMIN, "到站 1組");
  const teamMsgs = arrive.groupBroadcasts[0].messages.map((m) => m.text).join("");
  assert.doesNotMatch(teamMsgs, /逾時/);
  assert.equal((await teamService.findTeam(1)).is_late, 0);

  // 模擬「出發後已經過了 3 小時」：直接把 start_time 往前調，驗證超過 2 小時會被標記逾時
  await commandRouter.route("Uleader2", "報到 2組");
  await commandRouter.route(ADMIN, "出發 2組");
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await dbModule.db.run("UPDATE teams SET start_time = ? WHERE group_no = ?", [
    threeHoursAgo,
    2,
  ]);
  const lateArrive = await commandRouter.route(ADMIN, "到站 2組");
  const lateTeamMsgs = lateArrive.groupBroadcasts[0].messages.map((m) => m.text).join("");
  assert.match(lateTeamMsgs, /逾時/);
  assert.equal((await teamService.findTeam(2)).is_late, 1);
});

test("關主報到流程：輸入「關主報到」提示後，單獨回覆關卡代號或名稱都能完成登記", async () => {
  await resetGame();
  const prompt = await commandRouter.route(STAFF, "關主報到");
  assert.match(textsOf(prompt)[0], /請回覆您負責的關卡代號或名稱/);

  const byCode = await commandRouter.route(STAFF, "b3");
  assert.match(textsOf(byCode)[0], /已登記為「救救菜英文」（B3）的關主/);
  assert.equal(await teamService.getRefereeCheckpoint(STAFF), "B3");

  const byName = await commandRouter.route("Uother", "救救菜英文");
  assert.match(textsOf(byName)[0], /已登記為「救救菜英文」（B3）的關主/);
  assert.equal(await teamService.getRefereeCheckpoint("Uother"), "B3");
});

test("關主報到流程：已經報到綁定隊伍的帳號不受影響，單獨打出跟關卡同名的字仍走關鍵字比對", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");

  // 第1組目前在 D5（photo 類型），這個帳號已經是隊伍成員，打「B3」應該繼續走原本的關卡型態提示，
  // 不會被誤判成要登記關主
  const result = await commandRouter.route("Uleader", "B3");
  assert.match(textsOf(result)[0], /請直接上傳/);
  assert.equal(await teamService.getRefereeCheckpoint("Uleader"), null);
});

test("關主自助登記：「我是 B3 關主」後可以用通過，但只對自己登記的那一關生效", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");

  const register = await commandRouter.route(STAFF, "我是B3關主");
  assert.match(textsOf(register)[0], /已登記為「救救菜英文」（B3）的關主/);

  // 第1組路線第一關是 D5，不是 B3，登記為 B3 關主的人現在核准不了
  const wrongScope = await commandRouter.route(STAFF, "通過 1組");
  assert.match(textsOf(wrongScope)[0], /不是您登記的關卡/);
  assert.equal((await teamService.findTeam(1)).current_index, 0);

  // 先讓第1組過第1關（D5，用小編身分）
  await commandRouter.route(ADMIN, "通過 1組");
  assert.equal((await teamService.findTeam(1)).current_index, 1);

  // 現在第1組在 B3，登記為 B3 關主的人可以核准了
  const rightScope = await commandRouter.route(STAFF, "通過 1組");
  assert.match(textsOf(rightScope)[0], /已為第 1 組確認/);
  assert.equal((await teamService.findTeam(1)).current_index, 2);

  // 關主現在也能查「進度」，但只看得到跟自己這關有關的組別——第1組已經通過 B3 了，不該再出現
  const refereeProgress = await commandRouter.route(STAFF, "進度");
  assert.match(textsOf(refereeProgress)[0], /1組（第 2 關）｜✅ 已通過/);
});

test("關主自助登記：同一帳號重新登記會覆蓋成新的關卡", async () => {
  await resetGame();
  await commandRouter.route(STAFF, "我是B3關主");
  assert.equal(await teamService.getRefereeCheckpoint(STAFF), "B3");

  await commandRouter.route(STAFF, "我是B4關主");
  assert.equal(await teamService.getRefereeCheckpoint(STAFF), "B4");
});

test("關主自助登記：已經報到綁定隊伍的人不能登記成關主（防止自己核准自己）", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");

  const denied = await commandRouter.route("Uleader", "我是B3關主");
  assert.match(textsOf(denied)[0], /已經是第 1 組的成員，無法同時登記為關主/);
  assert.equal(await teamService.getRefereeCheckpoint("Uleader"), null);
});

test("重置關主：小編可以清空所有關主登記，非小編不能用", async () => {
  await resetGame();
  await commandRouter.route(STAFF, "我是B3關主");
  assert.equal(await teamService.getRefereeCheckpoint(STAFF), "B3");

  const denied = await commandRouter.route(STAFF, "重置關主");
  assert.match(textsOf(denied)[0], /僅限小編使用/);

  const reset = await commandRouter.route(ADMIN, "重置關主");
  assert.match(textsOf(reset)[0], /已清空所有關主登記/);
  assert.equal(await teamService.getRefereeCheckpoint(STAFF), null);
});

test("總領隊自助登記：登記後可以用「群發」對所有小隊長廣播；非小編非總領隊不能用", async () => {
  await resetGame();
  await commandRouter.route("Uleader1", "報到 1組");
  await commandRouter.route("Uleader2", "報到 2組");

  const denied = await commandRouter.route(STAFF, "群發 明天集合時間改成早上八點");
  assert.match(textsOf(denied)[0], /僅限小編或登記過的總領隊使用/);

  const register = await commandRouter.route(STAFF, "總領綁定");
  assert.match(textsOf(register)[0], /已登記為總領隊/);

  // 後台網頁「總領隊名單」分頁：登記後應該看得到這個人
  const list = await teamService.listBroadcasters();
  assert.equal(list.length, 1);
  assert.equal(list[0].userIdSuffix, STAFF.slice(-6));

  const broadcast = await commandRouter.route(STAFF, "群發 明天集合時間改成早上八點");
  assert.match(textsOf(broadcast)[0], /已推播給 2 位小隊長/);
  assert.equal(broadcast.directPushes.length, 2);
  const targets = broadcast.directPushes.map((p) => p.to).sort();
  assert.deepEqual(targets, ["Uleader1", "Uleader2"]);
  assert.match(broadcast.directPushes[0].messages[0].text, /明天集合時間改成早上八點/);
});

test("推播：一行打完「推播 對象 內容」，對象可以是隊長、關主、所有人", async () => {
  await resetGame();
  await commandRouter.route("Uleader1", "報到 1組");
  await commandRouter.route("Umember1", "報到 1組");
  await commandRouter.route("Uleader2", "報到 2組");
  await commandRouter.route("Ureferee", "我是 B3 關主");
  await commandRouter.route(STAFF, "總領綁定");

  const toLeaders = await commandRouter.route(STAFF, "推播 隊長 集合時間改到九點");
  assert.match(textsOf(toLeaders)[0], /已推播給 2 位小隊長/);
  assert.deepEqual(toLeaders.directPushes.map((p) => p.to).sort(), ["Uleader1", "Uleader2"]);
  assert.match(toLeaders.directPushes[0].messages[0].text, /集合時間改到九點/);

  const toReferees = await commandRouter.route(STAFF, "推播 關主 請提早就位");
  assert.match(textsOf(toReferees)[0], /已推播給 1 位關主/);
  assert.deepEqual(toReferees.directPushes.map((p) => p.to), ["Ureferee"]);

  const toAll = await commandRouter.route(STAFF, "推播 所有人 午餐提前");
  assert.match(textsOf(toAll)[0], /已推播給所有人（共 4 位）/);
  assert.deepEqual(
    toAll.directPushes.map((p) => p.to).sort(),
    ["Ureferee", "Uleader1", "Uleader2", "Umember1"].sort()
  );
});

test("推播：先打「推播 隊長」，下一則訊息就是內容；也可以只打「推播」再依序輸入對象與內容", async () => {
  await resetGame();
  await commandRouter.route("Uleader1", "報到 1組");
  await commandRouter.route("Ureferee", "我是 B3 關主");
  await commandRouter.route(STAFF, "總領綁定");

  const ask = await commandRouter.route(STAFF, "推播 隊長");
  assert.match(textsOf(ask)[0], /請輸入要推播給「小隊長」的訊息內容/);
  const sent = await commandRouter.route(STAFF, "下午三點在大門口集合");
  assert.match(textsOf(sent)[0], /已推播給 1 位小隊長/);
  assert.match(sent.directPushes[0].messages[0].text, /下午三點在大門口集合/);

  // 送出後狀態清除：下一則訊息回到一般指令流程，不會再被當成推播內容
  const after = await commandRouter.route(STAFF, "我的ID");
  assert.match(textsOf(after)[0], /userId/);

  const askTarget = await commandRouter.route(STAFF, "推播");
  assert.match(textsOf(askTarget)[0], /請輸入推播對象：隊長、關主、所有人/);
  const badTarget = await commandRouter.route(STAFF, "隊員");
  assert.match(textsOf(badTarget)[0], /看不懂這個對象/);
  const askContent = await commandRouter.route(STAFF, "關主");
  assert.match(textsOf(askContent)[0], /請輸入要推播給「關主」的訊息內容/);
  const sentToReferee = await commandRouter.route(STAFF, "請到現場集合");
  assert.match(textsOf(sentToReferee)[0], /已推播給 1 位關主/);
  assert.equal(sentToReferee.directPushes[0].to, "Ureferee");
});

test("推播：輸入「取消」可以放棄；沒有權限的人不能開始推播流程", async () => {
  await resetGame();
  await commandRouter.route(STAFF, "總領綁定");
  await commandRouter.route(STAFF, "推播 所有人");
  const cancelled = await commandRouter.route(STAFF, "取消");
  assert.match(textsOf(cancelled)[0], /已取消推播/);
  const next = await commandRouter.route(STAFF, "我的ID");
  assert.match(textsOf(next)[0], /userId/);

  const denied = await commandRouter.route("Unobody", "推播 所有人 測試");
  assert.match(textsOf(denied)[0], /僅限小編或登記過的總領隊使用/);
  const deniedStart = await commandRouter.route("Unobody", "推播");
  assert.match(textsOf(deniedStart)[0], /僅限小編或登記過的總領隊使用/);
});

test("總領隊自助登記：已經報到綁定隊伍的人不能登記成總領隊；小編不用登記就能直接群發", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");

  const denied = await commandRouter.route("Uleader", "總領綁定");
  assert.match(textsOf(denied)[0], /已經是第 1 組的成員，無法同時登記為總領隊/);

  const broadcast = await commandRouter.route(ADMIN, "群發 測試訊息");
  assert.match(textsOf(broadcast)[0], /已推播給 1 位小隊長/);
});

test("重置總領隊：小編可以清空所有總領隊登記，非小編不能用", async () => {
  await resetGame();
  await commandRouter.route(STAFF, "總領綁定");
  assert.equal(await teamService.isBroadcaster(STAFF), true);

  const denied = await commandRouter.route(STAFF, "重置總領隊");
  assert.match(textsOf(denied)[0], /僅限小編使用/);

  const reset = await commandRouter.route(ADMIN, "重置總領隊");
  assert.match(textsOf(reset)[0], /已清空所有總領隊登記/);
  assert.equal(await teamService.isBroadcaster(STAFF), false);
});

test("同一帳號可以同時是關主又是總領隊，兩種登記互不影響", async () => {
  await resetGame();
  await commandRouter.route(STAFF, "我是B3關主");
  await commandRouter.route(STAFF, "總領綁定");

  assert.equal(await teamService.getRefereeCheckpoint(STAFF), "B3");
  assert.equal(await teamService.isBroadcaster(STAFF), true);
});

test("關主直接喊過制（B3/B4/D6/C4）：隊伍打密語或傳照片都沒用，只能靠小編通過指令", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組");

  // 第1組路線第2關是 B3（現在是 referee 制，不再是密語制）
  await commandRouter.route(ADMIN, "通過 1組"); // 先過第1關 D5（photo）
  assert.equal((await teamService.findTeam(1)).current_index, 1);

  const wrongKeyword = await commandRouter.route("Uleader", "B3");
  assert.match(textsOf(wrongKeyword)[0], /由關主現場確認完成/);

  const wrongMedia = await teamService.submitMedia("Uleader");
  assert.match(textsOf({ reply: wrongMedia.reply })[0], /由關主現場確認完成/);
  assert.equal(wrongMedia.adminNotify.length, 0);

  // 進度應該還在原地，沒有因為上面兩次錯誤嘗試而前進
  assert.equal((await teamService.findTeam(1)).current_index, 1);

  const approve = await commandRouter.route(ADMIN, "通過 1組");
  assert.match(textsOf(approve)[0], /已為第 1 組確認「救救菜英文」通過/);
  assert.equal((await teamService.findTeam(1)).current_index, 2);
});

test("密語比對：自動忽略頭尾空白與大小寫，支援用「｜」分隔多個都算對的答案", async () => {
  await resetGame();
  // 用一個沒人用過的組別編號（99），順便也驗證了 setTeamRoute 能新增全新的組別
  await configStore.setTeamRoute(99, [{ checkpointId: "A3", keyword: "紅檜｜紅檜木" }]);
  await commandRouter.route("Uleader", "報到 99組");
  await commandRouter.route(ADMIN, "出發 99組");

  const wrong = await commandRouter.route("Uleader", "香杉");
  assert.match(textsOf(wrong)[0], /不正確/);

  const withSpacesAndCase = await commandRouter.route("Uleader", "  紅檜木  ");
  assert.match(textsOf(withSpacesAndCase)[0], /✅ 通關/);

  // 測完清掉臨時組別，避免留在共用測試資料庫裡影響之後的測試
  await configStore.deleteTeamRoute(99);
});

// ---- 緊急聯絡 ----

test("緊急聯絡：隊員傳送後小編立刻收到警報（含組別、關卡、一鍵接手），回報者收到安心訊息", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 3組");
  await commandRouter.route(ADMIN, "出發 3組");

  const result = await commandRouter.route("Uleader", "緊急聯絡");
  assert.match(textsOf(result)[0], /已通知小編/);
  assert.match(textsOf(result)[0], /緊急聯絡 說明內容/);

  assert.equal(result.directPushes.length, 1);
  assert.equal(result.directPushes[0].to, ADMIN);
  const alert = result.directPushes[0].messages[0];
  assert.match(alert.text, /🚨.*緊急聯絡 #\d+/);
  assert.match(alert.text, /第 3 組隊長/);
  assert.match(alert.text, /目前關卡：.*「/);
  assert.match(alert.text, /https:\/\/example\.com\/admin#emergencies/);
  const quick = alert.quickReply.items[0].action;
  assert.match(quick.text, /^處理緊急 \d+$/);
  assert.match(quick.label, /我來處理/);
});

test("緊急聯絡：附說明、關主與尚未報到的帳號也能用，說明文字會轉給小編", async () => {
  await resetGame();
  await commandRouter.route(STAFF, "我是B3關主");

  const withDetail = await commandRouter.route(STAFF, "緊急聯絡 有人扭傷腳踝，在B3附近");
  assert.match(withDetail.directPushes[0].messages[0].text, /關主/);
  assert.match(withDetail.directPushes[0].messages[0].text, /有人扭傷腳踝，在B3附近/);
  assert.match(textsOf(withDetail)[0], /補充的說明已一併轉給小編/);

  // 完全沒身分的帳號也要能求救
  const stranger = await commandRouter.route("Ustranger", "緊急求助：迷路了");
  assert.equal(stranger.directPushes.length, 1);
  assert.match(stranger.directPushes[0].messages[0].text, /尚未報到的帳號/);
  assert.match(stranger.directPushes[0].messages[0].text, /迷路了/);
});

test("緊急聯絡：60 秒內重複按不洗版；之後補充說明併入同一件，不會開新的一筆", async () => {
  await resetGame();
  const first = await commandRouter.route("Ua", "緊急聯絡");
  assert.equal(first.directPushes.length, 1);

  const repeat = await commandRouter.route("Ua", "緊急聯絡");
  assert.equal(repeat.directPushes.length, 0);
  assert.match(textsOf(repeat)[0], /剛剛已送出/);

  const supplement = await commandRouter.route("Ua", "緊急聯絡 位置在神木步道入口");
  assert.equal(supplement.directPushes.length, 1);
  assert.match(supplement.directPushes[0].messages[0].text, /補充說明/);

  const list = await teamService.listEmergencies();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "OPEN");
  assert.equal(list[0].detail, "位置在神木步道入口");
});

test("緊急聯絡：小編按「處理緊急 N」接手，通知回報者與其他小編；非小編不能用；重複接手不會重複通知", async () => {
  await resetGame();
  const report = await commandRouter.route("Ua", "緊急聯絡 肚子痛");
  const id = (report.directPushes[0].messages[0].text.match(/#(\d+)/) || [])[1];

  const denied = await commandRouter.route("Ua", `處理緊急 ${id}`);
  assert.match(textsOf(denied)[0], /僅限小編/);

  const handled = await commandRouter.route(ADMIN, `處理緊急 ${id}`);
  assert.match(textsOf(handled)[0], /已標記緊急聯絡/);
  const toReporter = handled.directPushes.find((p) => p.to === "Ua");
  assert.match(toReporter.messages[0].text, /小編已收到您的緊急聯絡/);

  const again = await commandRouter.route(ADMIN, `處理緊急 #${id}`);
  assert.match(textsOf(again)[0], /已經有人接手/);
  assert.equal(again.directPushes.length, 0);

  const missing = await commandRouter.route(ADMIN, "處理緊急 99999");
  assert.match(textsOf(missing)[0], /找不到/);

  assert.equal(await teamService.countOpenEmergencies(), 0);
  // 已處理之後再求助，視為新的一件
  const next = await commandRouter.route("Ua", "緊急聯絡");
  assert.equal(next.directPushes.length, 1);
  assert.equal(await teamService.countOpenEmergencies(), 1);
});

test("緊急聯絡：正在推播兩步驟對話中也能立刻送出；重置遊戲會清空紀錄", async () => {
  await resetGame();
  await commandRouter.route(ADMIN, "推播");
  const result = await commandRouter.route(ADMIN, "緊急聯絡");
  assert.equal(result.directPushes.length, 1);

  await commandRouter.route(ADMIN, "重置遊戲 確認");
  assert.equal((await teamService.listEmergencies()).length, 0);
});

test("緊急聯絡：各身分的使用說明都列出這個指令，小編說明多一條處理緊急，別人看不到", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");
  const leaderGuide = allTexts((await commandRouter.route("Uleader", "使用說明")).reply).join("\n");
  assert.match(leaderGuide, /緊急聯絡/);
  assert.doesNotMatch(leaderGuide, /處理緊急/);

  const general = allTexts((await commandRouter.route("Unobody", "使用說明")).reply).join("\n");
  assert.match(general, /緊急聯絡/);

  const adminGuide = allTexts((await commandRouter.route(ADMIN, "使用說明")).reply).join("\n");
  assert.match(adminGuide, /處理緊急/);
});

test("一鍵通過按鈕：隊伍上傳照片時登記在該關的關主也會收到通知＋按鈕；關主「進度」對等待確認的組別附按鈕；按鈕只對登記的那一關有效", async () => {
  await resetGame();
  await commandRouter.route("Ub3ref", "我是 B3 關主");
  await commandRouter.route("Ud5ref", "我是 D5 關主");
  await commandRouter.route("Ul1", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組"); // 第 1 組第一關是 D5（照片關）
  assert.equal(getRoute(1)[0].checkpointId, "D5");

  // 隊伍在 D5 上傳：小編＋登記在 D5 的關主都收到通知與按鈕，B3 的關主不會收到
  const submit = await teamService.submitMedia("Ul1");
  const byTarget = Object.fromEntries(submit.adminNotify.map((n) => [n.to, n.messages[0]]));
  assert.ok(byTarget[ADMIN] && byTarget.Ud5ref);
  assert.equal(byTarget.Ub3ref, undefined, "別關的關主不通知");
  assert.equal(byTarget.Ud5ref.quickReply.items[0].action.text, "通過 1組");
  assert.match(byTarget.Ud5ref.text, /在您這關/);
  assert.doesNotMatch(byTarget.Ud5ref.text, /後台/, "關主看不到後台，不附後台連結");
  assert.match(byTarget[ADMIN].text, /後台/);
  assert.match(submit.reply[0].text, /小編或關主/);

  // 同時是小編又登記成關主的人，只會收到一份
  await teamService.registerReferee(ADMIN, "D5");
  const dup = await teamService.submitMedia("Ul1");
  assert.equal(dup.adminNotify.filter((n) => n.to === ADMIN).length, 1);

  // 關主按按鈕（＝送出「通過 1組」）通過 D5；之後第 1 組輪到 B3，B3 關主的「進度」出現按鈕
  assert.match(textsOf(await commandRouter.route("Ud5ref", byTarget.Ud5ref.quickReply.items[0].action.text))[0], /已為第 1 組確認/);
  const progress = await commandRouter.route("Ub3ref", "進度");
  const items = progress.reply[0].quickReply.items;
  assert.deepEqual(items.map((i) => i.action.text), ["通過 1組"]);
  assert.equal(items[0].action.label, "✅ 通過 1組");
  assert.match(textsOf(progress)[0], /現在等您確認：1組/);

  // D5 關主拿同一顆按鈕去通過現在在 B3 的隊伍：不是他登記的關卡，被擋
  assert.match(textsOf(await commandRouter.route("Ud5ref", "通過 1組"))[0], /不是您登記的關卡/);
  assert.equal((await teamService.findTeam(1)).current_index, 1);

  // B3 關主點按鈕通過；之後沒有等待確認的組別，「進度」不再附按鈕
  assert.match(textsOf(await commandRouter.route("Ub3ref", items[0].action.text))[0], /已為第 1 組確認/);
  assert.equal((await commandRouter.route("Ub3ref", "進度")).reply[0].quickReply, undefined);
});

test("小編用 LINE 指令綁定關主／總領隊：指定關主 B3 名字（或 userId 末碼），找不到、重名、隊伍成員、非小編都有清楚提示，可取消", async () => {
  await resetGame();
  const lineUserStore = require("../src/config/lineUserStore");
  await dbModule.db.run("DELETE FROM line_users");
  const seed = async (id, name) => {
    await lineUserStore.touch(id);
    if (name) await lineUserStore.setDisplayName(id, name);
  };
  await seed("Uaaaa111111", "阿美");
  await seed("Ubbbb222222", "小華");
  await seed("Ucccc333333", "小華媽媽");
  await seed("Udddd444444", "Amy Chen");
  await seed("Ueeee555555", "Amy Lin");
  await seed("Unoname66666", null);

  // 用名字指定：成功，回覆確認、推播通知給對方（含關主指令說明），立刻生效
  const assign = await commandRouter.route(ADMIN, "指定關主 B3 阿美");
  assert.match(textsOf(assign)[0], /阿美 …111111 已指定為「.*」（B3）的關主，已通知對方/);
  assert.equal(assign.directPushes[0].to, "Uaaaa111111");
  assert.match(assign.directPushes[0].messages[0].text, /小編已指定您擔任.*B3/);
  assert.equal(await teamService.getRefereeCheckpoint("Uaaaa111111"), "B3");
  assert.match(textsOf(await commandRouter.route("Uaaaa111111", "進度"))[0], /B3.*預定來訪順序/);

  // 關卡代號不分大小寫；名稱可以只打一部分；完全相同優先於部分符合（「小華」不會誤選「小華媽媽」）
  assert.match(textsOf(await commandRouter.route(ADMIN, "指定關主 b4 小華"))[0], /小華 …222222 已指定為.*B4/);
  assert.equal(await teamService.getRefereeCheckpoint("Ubbbb222222"), "B4");

  // 部分名稱只符合一位：成功；用 userId 末碼（6 碼以上）也可以，沒有名稱的人靠這個
  assert.match(textsOf(await commandRouter.route(ADMIN, "指定關主 D6 媽媽"))[0], /小華媽媽 …333333/);
  assert.match(textsOf(await commandRouter.route(ADMIN, "指定關主 C4 noname66666"))[0], /（未取得名稱） …e66666 已指定為.*C4/);
  assert.equal(await teamService.getRefereeCheckpoint("Unoname66666"), "C4");

  // 重名：列出候選、提示改打末碼，不會亂選
  const ambiguous = await commandRouter.route(ADMIN, "指定關主 A2 amy");
  assert.match(textsOf(ambiguous)[0], /符合的人不只一位/);
  assert.match(textsOf(ambiguous)[0], /Amy Chen …444444/);
  assert.match(textsOf(ambiguous)[0], /Amy Lin …555555/);
  assert.equal(ambiguous.directPushes.length, 0);
  assert.match(textsOf(await commandRouter.route(ADMIN, "指定關主 A2 444444"))[0], /Amy Chen …444444 已指定/);

  // 找不到：提示對方要先傳訊息給官方帳號
  const none = await commandRouter.route(ADMIN, "指定關主 B3 不存在的人");
  assert.match(textsOf(none)[0], /找不到「不存在的人」.*先傳任何一句話/);

  // 不存在的關卡、已在隊伍裡的人
  assert.match(textsOf(await commandRouter.route(ADMIN, "指定關主 Z9 阿美"))[0], /找不到關卡代號/);
  await commandRouter.route("Umember1", "報到 1組");
  await lineUserStore.backfill();
  await lineUserStore.setDisplayName("Umember1", "隊員甲");
  assert.match(textsOf(await commandRouter.route(ADMIN, "指定關主 B3 隊員甲"))[0], /已經是第 1 組的成員/);
  assert.match(textsOf(await commandRouter.route(ADMIN, "指定總領隊 隊員甲"))[0], /已經是第 1 組的成員/);

  // 非小編（包含關主、總領隊本人）不能用這些指令
  await commandRouter.route("Ubroadcaster", "總領綁定");
  for (const who of ["Ustranger", "Uaaaa111111", "Ubroadcaster"]) {
    for (const cmd of ["指定關主 B3 小華", "取消關主 阿美", "指定總領隊 小華", "取消總領隊 阿美"]) {
      assert.match(textsOf(await commandRouter.route(who, cmd))[0], /僅限小編使用/, `${who} 執行「${cmd}」`);
    }
  }
  assert.equal(await teamService.getRefereeCheckpoint("Ubbbb222222"), "B4", "被擋下的指令沒有改到任何人");

  // 總領隊：指定後能推播，取消後失效並通知對方
  const boss = await commandRouter.route(ADMIN, "指定總領隊 小華媽媽");
  assert.match(textsOf(boss)[0], /小華媽媽 …333333 已指定為總領隊/);
  assert.match(boss.directPushes[0].messages[0].text, /指定您擔任總領隊/);
  assert.ok(await teamService.isBroadcaster("Ucccc333333"));
  const cancelBoss = await commandRouter.route(ADMIN, "取消總領隊 小華媽媽");
  assert.match(textsOf(cancelBoss)[0], /已取消總領隊/);
  assert.match(cancelBoss.directPushes[0].messages[0].text, /已取消您的總領隊身分/);
  assert.ok(!(await teamService.isBroadcaster("Ucccc333333")));
  assert.match(textsOf(await commandRouter.route(ADMIN, "取消總領隊 小華媽媽"))[0], /目前不是總領隊/);

  // 取消關主：對方收到通知、不再是關主；再取消提示不是關主
  const cancel = await commandRouter.route(ADMIN, "取消關主 阿美");
  assert.match(textsOf(cancel)[0], /阿美 …111111 已取消 B3 關主/);
  assert.match(cancel.directPushes[0].messages[0].text, /已取消您的關主身分/);
  assert.equal(await teamService.getRefereeCheckpoint("Uaaaa111111"), null);
  assert.match(textsOf(await commandRouter.route(ADMIN, "取消關主 阿美"))[0], /目前不是關主/);

  // 小編的說明列出這幾個指令，別人的說明沒有
  assert.match(textsOf(await commandRouter.route(ADMIN, "使用說明")).join("\n"), /指定關主 B3 阿美/);
  assert.doesNotMatch(textsOf(await commandRouter.route("Umember1", "使用說明")).join("\n"), /指定關主/);
  await dbModule.db.run("DELETE FROM line_users");
});
