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

test("關主專用進度查詢：「進度」只顯示跟自己這關有關的組別（在路上／已抵達），不顯示已通過或無關的組別", async () => {
  await resetGame();
  await commandRouter.route("Ub3referee", "我是 B3 關主");
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route(ADMIN, "出發 1組"); // 第1組目前在 D5，B3 是下一關

  const enRoute = await commandRouter.route("Ub3referee", "進度");
  assert.match(textsOf(enRoute)[0], /1組｜🚶 已出發，還在路上/);

  await teamService.submitMedia("Uleader");
  await commandRouter.route(ADMIN, "通過 1組"); // 第1組現在剛好卡在 B3

  const arrived = await commandRouter.route("Ub3referee", "進度");
  assert.match(textsOf(arrived)[0], /1組｜✋ 已抵達，等待確認/);

  await commandRouter.route(ADMIN, "通過 1組"); // 通過 B3 之後跟這一關無關了，不該再出現

  const passed = await commandRouter.route("Ub3referee", "進度");
  assert.match(textsOf(passed)[0], /目前沒有隊伍在路上或抵達/);
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

test("退回：也可以取消誤觸的終點確認，讓該組恢復闖關中繼續計時", async () => {
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
  assert.match(textsOf(refereeProgress)[0], /目前沒有隊伍在路上或抵達/);
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
  assert.match(textsOf(broadcast)[0], /已群發給 2 位小隊長/);
  assert.equal(broadcast.directPushes.length, 2);
  const targets = broadcast.directPushes.map((p) => p.to).sort();
  assert.deepEqual(targets, ["Uleader1", "Uleader2"]);
  assert.match(broadcast.directPushes[0].messages[0].text, /明天集合時間改成早上八點/);
});

test("總領隊自助登記：已經報到綁定隊伍的人不能登記成總領隊；小編不用登記就能直接群發", async () => {
  await resetGame();
  await commandRouter.route("Uleader", "報到 1組");

  const denied = await commandRouter.route("Uleader", "總領綁定");
  assert.match(textsOf(denied)[0], /已經是第 1 組的成員，無法同時登記為總領隊/);

  const broadcast = await commandRouter.route(ADMIN, "群發 測試訊息");
  assert.match(textsOf(broadcast)[0], /已群發給 1 位小隊長/);
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
