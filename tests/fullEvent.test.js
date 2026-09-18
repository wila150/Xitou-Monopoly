// 群體測試＋各身分測試：模擬整場活動（10 組、12 關、關主、總領隊、小編同時在線），
// 跟 commandRouter.test.js 的單一功能測試互補——這裡驗證「大家一起用」時流程不會互相干擾。
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://localhost/line_checkpoint_test";
process.env.PGSSL = "false";
process.env.PUBLIC_BASE_URL = "https://example.com";
process.env.ADMIN_USER_IDS = "Uadmin";

const dbModule = require("../src/db");
const configStore = require("../src/config/configStore");
const commandRouter = require("../src/handlers/commandRouter");
const teamService = require("../src/services/teamService");
const { getRoute, getAllGroupNos } = require("../src/config/teamsRoute");
const { getCheckpoint } = require("../src/config/checkpoints");

const ADMIN = "Uadmin";
const REFEREE_CHECKPOINTS = ["B3", "B4", "D6", "C4"]; // 關主直接喊過的 4 關

test.before(async () => {
  await dbModule.init();
  await configStore.init();
});

test.after(async () => {
  await dbModule.pool.end();
});

async function resetAll() {
  await commandRouter.route(ADMIN, "重置遊戲 確認");
  await teamService.resetReferees();
  await teamService.resetBroadcasters();
  commandRouter.resetPendingBroadcasts();
}

function textsOf(result) {
  return (result.reply || []).filter((m) => m.type === "text").map((m) => m.text);
}
const firstText = (result) => textsOf(result)[0] || "";

// 關卡公告是 Flex 卡片，文字在 flex.contents 的節點裡，遞迴撈出來方便斷言
function flexTexts(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "text" && typeof node.text === "string") out.push(node.text);
  if (Array.isArray(node.contents)) node.contents.forEach((c) => flexTexts(c, out));
  for (const key of ["hero", "body", "header", "footer"]) if (node[key]) flexTexts(node[key], out);
  return out;
}
function allTexts(result) {
  const out = [];
  for (const m of result.reply || []) {
    if (m.type === "text") out.push(m.text);
    if (m.type === "flex") flexTexts(m.contents, out);
  }
  return out.join("\n");
}

const leaderOf = (g) => `Uleader${g}`;
const memberOf = (g) => `Umember${g}`;
const refereeOf = (cpId) => `Uref-${cpId}`;

// 讓某一組走完目前這一步：依關卡類型用對的人、對的方式過關，回傳做了什麼
async function passCurrentStep(groupNo) {
  const team = await teamService.findTeam(groupNo);
  const step = getRoute(groupNo)[team.current_index];
  const cp = getCheckpoint(step.checkpointId);

  if (cp.verifyType === "keyword") {
    // 密語過關：下一關公告直接回覆給輸入的人（不走推播）
    const result = await commandRouter.route(leaderOf(groupNo), step.keyword);
    assert.ok(result.reply.length >= 1, `${groupNo}組 ${cp.id} 密語正確要回覆結果`);
    assert.equal((await teamService.findTeam(groupNo)).current_index, team.current_index + 1);
    return "keyword";
  }
  if (cp.verifyType === "referee") {
    // 有登記關主的關卡由關主過；隊伍自己輸入沒用
    const wrongTry = await commandRouter.route(leaderOf(groupNo), "隨便亂打");
    assert.doesNotMatch(firstText(wrongTry), /通過|過關成功/);
    const result = await commandRouter.route(refereeOf(cp.id), `通過 ${groupNo}組`);
    assert.match(firstText(result), new RegExp(`已為第 ${groupNo} 組確認`));
    return "referee";
  }
  // 照片／影片：隊伍上傳 → 小編收到通知 → 小編通過
  const submit = await teamService.submitMedia(leaderOf(groupNo), {
    buffer: Buffer.from("fake-media"),
    mimeType: cp.verifyType === "video" ? "video/mp4" : "image/jpeg",
  });
  assert.match(submit.reply[0].text, /已收到您上傳/);
  assert.equal(submit.adminNotify.length, 1);
  assert.equal(submit.adminNotify[0].to, ADMIN);
  const result = await commandRouter.route(ADMIN, `通過 ${groupNo}組`);
  assert.match(firstText(result), new RegExp(`已為第 ${groupNo} 組確認`));
  return cp.verifyType;
}

test("群體測試：10 組同時闖完 12 關（隊長＋組員、4 位關主、總領隊、小編），過程中隨時查詢都一致", async () => {
  await resetAll();
  const groups = getAllGroupNos();
  assert.equal(groups.length, 10);

  // ---- 登記：4 位關主、1 位總領隊 ----
  for (const cpId of REFEREE_CHECKPOINTS) {
    const r = await commandRouter.route(refereeOf(cpId), `我是 ${cpId} 關主`);
    assert.match(textsOf(r).join("\n"), /已登記|登記成功/);
  }
  await commandRouter.route("Ubroadcaster", "總領綁定");
  assert.ok(await teamService.isBroadcaster("Ubroadcaster"));

  // ---- 報到：每組第一位是隊長、第二位是組員 ----
  for (const g of groups) {
    const leader = await commandRouter.route(leaderOf(g), `報到 ${g}組`);
    assert.match(textsOf(leader).join("\n"), /隊長/);
    const member = await commandRouter.route(memberOf(g), `${g}組`);
    assert.match(textsOf(member).join("\n"), /組員/);
  }
  const leaderRows = await teamService.listTeamLeaders();
  assert.equal(leaderRows.length, 10);

  // 出發前：任何人輸入關卡指令都被擋下
  const early = await commandRouter.route(leaderOf(1), "隨便");
  assert.match(firstText(early), /尚未出發/);

  // ---- 公告推播範圍：預設只推隊長；切成 all 推全組成員 ----
  for (const g of groups) {
    assert.deepEqual(await teamService.getGroupBroadcastRecipientIds(g), [leaderOf(g)]);
  }
  await configStore.setBroadcastScope("all");
  for (const g of groups) {
    assert.deepEqual((await teamService.getGroupBroadcastRecipientIds(g)).sort(), [leaderOf(g), memberOf(g)].sort());
  }
  await configStore.setBroadcastScope("leader");

  // ---- 出發：10 組依序出發（每組的出發時間各自記錄）----
  const startTimes = new Set();
  for (const g of groups) {
    const r = await commandRouter.route(ADMIN, `出發 ${g}組`);
    assert.equal(r.groupBroadcasts.length, 1);
    startTimes.add((await teamService.findTeam(g)).start_time);
    // 第一關有登記關主時，會被通知有隊伍正往他那關來
    const firstCp = getRoute(g)[0].checkpointId;
    if (REFEREE_CHECKPOINTS.includes(firstCp)) {
      assert.ok(r.directPushes.some((p) => p.to === refereeOf(firstCp)), `${g}組出發要通知 ${firstCp} 關主`);
    }
  }
  assert.equal(startTimes.size, 10, "每組都有自己的出發時間紀錄");

  // ---- 群體闖關：每一輪 10 組各走一步，每輪結束核對各關關主看到的來訪順序 ----
  const totalSteps = getRoute(1).length;
  assert.equal(totalSteps, 12);
  const passedBy = new Map(); // cpId -> 已通過的組別
  for (let round = 0; round < totalSteps; round++) {
    for (const g of groups) {
      const team = await teamService.findTeam(g);
      const cpId = getRoute(g)[team.current_index].checkpointId;
      await passCurrentStep(g);
      passedBy.set(cpId, [...(passedBy.get(cpId) || []), g]);
    }
    // 每位關主看到的清單：10 組都列出，已通過的數量跟實際一致
    for (const cpId of REFEREE_CHECKPOINTS) {
      const text = firstText(await commandRouter.route(refereeOf(cpId), "進度"));
      assert.equal((text.match(/組（第 \d+ 關）/g) || []).length, 10, `${cpId} 關主看得到 10 組`);
      assert.equal((text.match(/✅ 已通過/g) || []).length, (passedBy.get(cpId) || []).length, `${cpId} 已通過數量`);
    }
    // 小編總覽：10 組都還在闖關中（要到站才算終點確認），進度數字全部一致
    const overview = firstText(await commandRouter.route(ADMIN, "進度"));
    assert.equal((overview.match(new RegExp(`闖關中｜${round + 1}/12`, "g")) || []).length, 10, `第 ${round + 1} 輪後 10 組都是 ${round + 1}/12`);
  }

  // 12 關全部完成後每組 current_index = 12，B3/B4/D6/C4 各有 10 組通過
  for (const g of groups) assert.equal((await teamService.findTeam(g)).current_index, 12);
  for (const cpId of REFEREE_CHECKPOINTS) assert.equal(passedBy.get(cpId).length, 10);

  // 全部通過後再喊通過：提示已完成
  const extra = await commandRouter.route(ADMIN, "通過 1組");
  assert.match(firstText(extra), /已完成全部 12 關/);

  // ---- 緊急聯絡：闖關途中不同身分同時求救，小編都收得到，各自獨立一件 ----
  const e1 = await commandRouter.route(memberOf(4), "緊急聯絡 有人不舒服");
  const e2 = await commandRouter.route(refereeOf("B3"), "緊急聯絡");
  const e3 = await commandRouter.route("Ustranger", "緊急聯絡 找不到集合點");
  for (const e of [e1, e2, e3]) {
    assert.equal(e.directPushes.length, 1);
    assert.equal(e.directPushes[0].to, ADMIN);
  }
  assert.match(e1.directPushes[0].messages[0].text, /第 4 組組員/);
  assert.match(e2.directPushes[0].messages[0].text, /B3.*關主/);
  assert.match(e3.directPushes[0].messages[0].text, /尚未報到的帳號/);
  assert.equal(await teamService.countOpenEmergencies(), 3);
  const openIds = (await teamService.listEmergencies()).map((e) => e.id);
  for (const id of openIds) await commandRouter.route(ADMIN, `處理緊急 ${id}`);
  assert.equal(await teamService.countOpenEmergencies(), 0);

  // ---- 總領隊推播：對象人數正確 ----
  const toLeaders = await commandRouter.route("Ubroadcaster", "推播 隊長 集合時間改十一點");
  assert.match(firstText(toLeaders), /已推播給 10 位小隊長/);
  assert.equal(toLeaders.directPushes.length, 10);
  const toReferees = await commandRouter.route("Ubroadcaster", "推播 關主 請注意天氣");
  assert.equal(toReferees.directPushes.length, 4);
  const toAll = await commandRouter.route("Ubroadcaster", "推播 所有人 午餐開始");
  assert.match(firstText(toAll), /共 24 位/); // 10 隊長 + 10 組員 + 4 關主
  assert.equal(toAll.directPushes.length, 24);

  // ---- 終點：B6 工作人員逐組「到站」，全部 FINISHED ----
  for (const g of groups) {
    const r = await commandRouter.route(ADMIN, `到站 ${g}組`);
    assert.match(firstText(r), new RegExp(`已為第 ${g} 組辦理終點確認`));
    const team = await teamService.findTeam(g);
    assert.equal(team.status, "FINISHED");
    assert.ok(team.finish_time);
  }

  // ---- 排行榜：小編隨時可看；未開放前一般隊伍看不到，開放後 10 組都在 ----
  const locked = await commandRouter.route(leaderOf(1), "排行榜");
  assert.match(firstText(locked), /僅開放小編/);
  await commandRouter.route(ADMIN, "排行榜開啟");
  const ranking = firstText(await commandRouter.route(leaderOf(1), "排行榜"));
  assert.equal((ranking.match(/12\/12/g) || []).length, 10);
  for (const g of groups) assert.match(ranking, new RegExp(`${g}組｜12/12`));

  // ---- 每位隊伍成員都能查到自己的完成狀態 ----
  const status = firstText(await commandRouter.route(memberOf(7), "目前關卡"));
  assert.match(status, /終點確認|完成關卡數/);
});

test("逾時不會被擋：出發超過 2 小時後仍能繼續過關與到站，成績標註逾時（不再有 12:30 自動停止）", async () => {
  await resetAll();
  await commandRouter.route(leaderOf(1), "報到 1組");
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await teamService.depart(1, threeHoursAgo);

  const step1 = await passCurrentStep(1); // 出發已 3 小時，照樣能過關
  assert.ok(step1);
  assert.equal((await teamService.findTeam(1)).current_index, 1);

  // 走完剩下的關卡後到站
  while ((await teamService.findTeam(1)).current_index < 12) {
    await commandRouter.route(refereeOf("B3"), "我是 B3 關主").catch(() => {});
    const team = await teamService.findTeam(1);
    const cpId = getRoute(1)[team.current_index].checkpointId;
    const cp = getCheckpoint(cpId);
    if (cp.verifyType === "keyword") await commandRouter.route(leaderOf(1), getRoute(1)[team.current_index].keyword);
    else await commandRouter.route(ADMIN, "通過 1組");
  }
  const finish = await commandRouter.route(ADMIN, "到站 1組");
  assert.match(firstText(finish), /已為第 1 組辦理終點確認/);
  const team = await teamService.findTeam(1);
  assert.equal(team.is_late, 1, "超過 2 小時標註逾時");
  const progress = firstText(await commandRouter.route(ADMIN, "進度"));
  assert.match(progress, /已終點確認（逾時）/);
});

// ---- 各身分測試：同一批指令，各身分該成功的成功、該被擋的被擋 ----

test("各身分權限矩陣：陌生人／隊長／組員／關主／總領隊／小編，同一批指令的結果符合預期", async () => {
  await resetAll();
  await commandRouter.route("Uleader", "報到 1組");
  await commandRouter.route("Umember", "報到 1組");
  await commandRouter.route("Ureferee", "我是 B3 關主");
  await commandRouter.route("Ubroadcaster", "總領綁定");
  await commandRouter.route(ADMIN, "出發 1組");

  const identities = ["Ustranger", "Uleader", "Umember", "Ureferee", "Ubroadcaster", ADMIN];
  const [STRANGER, LEADER, MEMBER, REFEREE, BROADCASTER, ADMINISTRATOR] = identities;

  // 每列：[指令, 誰可以用（其餘一律被拒絕）, 被拒絕時的訊息]
  const ADMIN_ONLY = /僅限小編使用/;
  const STAFF_ONLY = /僅限小編或登記過的關主使用/;
  const matrix = [
    ["解除綁定 9組", [ADMINISTRATOR], ADMIN_ONLY],
    ["確認換隊長 1組", [ADMINISTRATOR], ADMIN_ONLY],
    ["退回 9組", [ADMINISTRATOR], ADMIN_ONLY],
    ["加分 9組 5", [ADMINISTRATOR], ADMIN_ONLY],
    ["遊戲結束", [ADMINISTRATOR], ADMIN_ONLY],
    ["排行榜開啟", [ADMINISTRATOR], ADMIN_ONLY],
    ["排行榜關閉", [ADMINISTRATOR], ADMIN_ONLY],
    ["重置關主", [ADMINISTRATOR], ADMIN_ONLY],
    ["重置總領隊", [ADMINISTRATOR], ADMIN_ONLY],
    ["重置遊戲", [ADMINISTRATOR], ADMIN_ONLY],
    ["處理緊急 99999", [ADMINISTRATOR], ADMIN_ONLY],
    ["通過 9組", [ADMINISTRATOR, REFEREE], STAFF_ONLY],
    ["進度", [ADMINISTRATOR, REFEREE], STAFF_ONLY],
    ["順序", [ADMINISTRATOR, REFEREE], STAFF_ONLY],
  ];
  // 「遊戲結束」「重置關主」這類會改變狀態的指令，被允許者實際執行會影響後面的判斷，
  // 所以只驗證「被拒絕的身分一律被擋」，被允許的身分只驗證「沒被權限擋下」（最後才由小編實際執行）。
  for (const [command, allowed, denial] of matrix) {
    for (const who of identities) {
      if (allowed.includes(who)) continue;
      const result = await commandRouter.route(who, command);
      assert.match(firstText(result), denial, `${who} 執行「${command}」應該被拒絕`);
    }
  }
  // 被允許的身分：不會收到權限拒絕（用不會改變狀態的指令實測）
  for (const who of [ADMINISTRATOR, REFEREE]) {
    for (const command of ["進度", "順序 B3", "通過 9組"]) {
      const result = await commandRouter.route(who, command);
      assert.doesNotMatch(firstText(result), /僅限小編/, `${who} 執行「${command}」不該被權限擋下`);
    }
  }

  // 推播：只有總領隊與小編可以
  for (const who of [STRANGER, LEADER, MEMBER, REFEREE]) {
    const r = await commandRouter.route(who, "推播 隊長 測試");
    assert.match(firstText(r), /僅限小編或登記過的總領隊使用/, `${who} 不能推播`);
    assert.equal(r.directPushes.length, 0);
  }
  for (const who of [BROADCASTER, ADMINISTRATOR]) {
    const r = await commandRouter.route(who, "推播 隊長 測試");
    assert.match(firstText(r), /已推播給 1 位小隊長/, `${who} 可以推播`);
  }

  // 關主只能通過自己登記的那關：第 1 組目前在 D5，B3 關主不能通過
  const wrongRef = await commandRouter.route(REFEREE, "通過 1組");
  assert.match(firstText(wrongRef), /不是您登記的關卡/);
  assert.equal((await teamService.findTeam(1)).current_index, 0);

  // 隊伍成員（隊長／組員）不能自己通過自己，也不能查全體進度
  for (const who of [LEADER, MEMBER]) {
    assert.match(firstText(await commandRouter.route(who, "通過 1組")), STAFF_ONLY);
    assert.match(firstText(await commandRouter.route(who, "進度")), STAFF_ONLY);
  }

  // 隊長／組員能用的：目前關卡、闖關進度、使用說明；陌生人被要求先報到
  for (const who of [LEADER, MEMBER]) {
    assert.match(allTexts(await commandRouter.route(who, "目前關卡")), /D5|上傳|照片/);
    assert.match(firstText(await commandRouter.route(who, "闖關進度")), /已完成 0\/12 關/);
  }
  assert.match(firstText(await commandRouter.route(STRANGER, "目前關卡")), /請先報到/);
  assert.match(firstText(await commandRouter.route(STRANGER, "闖關進度")), /請先報到/);

  // 組員可以申請接任隊長，隊長不行；陌生人不行
  assert.match(firstText(await commandRouter.route(MEMBER, "接任隊長 1組")), /已送出接任隊長申請/);
  assert.match(firstText(await commandRouter.route(LEADER, "接任隊長 1組")), /已經是本組隊長/);
  assert.match(firstText(await commandRouter.route(STRANGER, "接任隊長 1組")), /並非第 1 組成員/);

  // 所有人都能用：我的ID、緊急聯絡、使用說明（每個身分都有回覆）
  for (const who of identities) {
    assert.match(firstText(await commandRouter.route(who, "我的ID")), new RegExp(who));
    const emergency = await commandRouter.route(who, "緊急聯絡");
    assert.match(firstText(emergency), /已通知小編|剛剛已送出/);
    assert.ok(textsOf(await commandRouter.route(who, "使用說明")).length >= 1);
  }

  // 關主／總領隊登記：已綁定隊伍的人不能登記（防止自己核准自己），沒綁定的可以
  assert.match(firstText(await commandRouter.route(LEADER, "我是 B3 關主")), /不能|已經|隊伍/);
  assert.match(firstText(await commandRouter.route(LEADER, "總領綁定")), /不能|已經|隊伍/);
  assert.ok(!(await teamService.getRefereeCheckpoint(LEADER)));
  assert.ok(!(await teamService.isBroadcaster(LEADER)));

  // 最後由小編實際執行狀態變更類指令
  assert.match(firstText(await commandRouter.route(ADMINISTRATOR, "加分 1組 5")), /已為第 1 組加分 5 分/);
  assert.match(firstText(await commandRouter.route(ADMINISTRATOR, "確認換隊長 1組")), /已核准|隊長/);
});
