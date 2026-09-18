const teamService = require("../services/teamService");
const { isAdmin } = require("../config/admins");

// 把「一」「十」「二十一」這類中文數字轉成阿拉伯數字，支援 1～99，
// 讓隊伍可以直接回覆「第一組」「一組」，不用一定要打阿拉伯數字。
const CHINESE_DIGITS = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function chineseNumeralToInt(text) {
  if (/^[0-9]+$/.test(text)) return Number(text);
  if (text === "十") return 10;
  if (text.includes("十")) {
    const [tenPart, onePart] = text.split("十");
    const tens = tenPart ? CHINESE_DIGITS[tenPart] : 1;
    const ones = onePart ? CHINESE_DIGITS[onePart] : 0;
    if (tens == null || ones == null) return NaN;
    return tens * 10 + ones;
  }
  return text.length === 1 ? CHINESE_DIGITS[text] : NaN;
}

// 組別編號可以用阿拉伯數字或中文數字，前面可以加「第」也可以不加——
// 「1組」「第1組」「一組」「第一組」都算數，所有跟組別有關的指令一致套用這個規則。
const GROUP_TOKEN = "第?\\s*([0-9]{1,2}|[0-9一二三四五六七八九十]{1,3})\\s*組";

// 動詞跟組別編號誰先誰後都可以：「出發1組」「1組出發」、「通過第1組」「第1組通過」都算數。
function verbGroupRegex(verb) {
  return new RegExp(`^(?:${verb}\\s*${GROUP_TOKEN}|${GROUP_TOKEN}\\s*${verb})$`);
}

// 從 verbGroupRegex／CHECKIN_RE 的比對結果取出組別編號：兩種語序各對應一個捕獲群組，
// 命中哪一種語序，該群組就有值、另一個是 undefined，所以用 ?? 挑出有值的那個。
function matchGroupNo(text, re) {
  const m = text.match(re);
  if (!m) return null;
  return chineseNumeralToInt(m[1] ?? m[2]);
}

// 報到比較特別：「報到」兩個字整個可以省略——點圖文選單「報到」按鈕後，
// 之後單獨回覆組別（例如「第一組」）、或組別加「報到」（例如「1組報到」）都算報到。
const CHECKIN_RE = new RegExp(`^(?:報到\\s*${GROUP_TOKEN}|${GROUP_TOKEN}(?:\\s*報到)?)$`);
const DEPART_RE = verbGroupRegex("出發");
const ARRIVE_RE = verbGroupRegex("到站");
const APPROVE_RE = verbGroupRegex("通過");
const REVERT_RE = verbGroupRegex("退回");
const REGISTER_REFEREE_RE = /^我是\s*([A-Za-z]\d)\s*關主$/;
const BROADCAST_RE = /^群發\s+([\s\S]+)$/;
const TRANSFER_REQUEST_RE = verbGroupRegex("接任隊長");
const TRANSFER_CONFIRM_RE = verbGroupRegex("確認換隊長");
const UNBIND_RE = verbGroupRegex("解除綁定");

// 小編手動加分：「加分 1組 5」「加分 第一組 -3 犯規扣分」，理由可省略。分數只接受阿拉伯數字（可負數）。
const BONUS_RE = new RegExp(`^加分\\s*${GROUP_TOKEN}\\s*(-?[0-9]+)(?:\\s+([\\s\\S]+))?$`);

function withReply(reply) {
  return { reply, groupBroadcasts: [], directPushes: [] };
}

function adminOnlyDenied() {
  return withReply([teamService.textMsg("此指令僅限小編使用。")]);
}

function approveOnlyDenied() {
  return withReply([teamService.textMsg("此指令僅限小編或登記過的關主使用。")]);
}

function broadcastOnlyDenied() {
  return withReply([
    teamService.textMsg("此指令僅限小編或登記過的總領隊使用，請先輸入「我是總領隊」進行登記。"),
  ]);
}

// 將 teamService 各函式回傳的訊息，統一整理成
// { reply, groupBroadcasts, directPushes } 供 index.js 送出
async function route(userId, rawText) {
  const text = rawText.trim();

  let m;
  let groupNo;

  if (text === "我的ID" || text === "我的id" || text === "我的Id") {
    // 查詢自己的 LINE userId，方便小編設定 ADMIN_USER_IDS 或關主／總領隊排查問題用，任何人都可以查自己的
    return withReply([teamService.textMsg(`您的 userId：\n${userId}`)]);
  }

  if (text === "報到") {
    // 圖文選單「報到」按鈕會送出這個固定文字（組別編號因人而異，選單按鈕沒辦法直接帶號碼）
    return withReply([
      teamService.textMsg(
        "請回覆您的組別編號完成報到，例如「1組」或「第一組」（第一位報到的人會是隊長）。"
      ),
    ]);
  }

  if ((groupNo = matchGroupNo(text, CHECKIN_RE)) != null) {
    return withReply(await teamService.checkin(groupNo, userId));
  }

  if ((groupNo = matchGroupNo(text, DEPART_RE)) != null) {
    const result = await teamService.depart(groupNo);
    return {
      reply: result.reply,
      groupBroadcasts: result.groupBroadcast ? [result.groupBroadcast] : [],
      directPushes: [],
    };
  }

  if ((groupNo = matchGroupNo(text, ARRIVE_RE)) != null) {
    // B6 終點工作人員觸發：隊伍實際抵達 B6，直接辦理終點確認（不需要隊長輸入任何代碼）
    const result = await teamService.finishAtB6(groupNo);
    return {
      reply: result.reply,
      groupBroadcasts: result.groupBroadcast ? [result.groupBroadcast] : [],
      directPushes: [],
    };
  }

  if ((m = text.match(REGISTER_REFEREE_RE))) {
    // 關主自助登記：「我是 B3 關主」，同一帳號再傳一次會直接覆蓋成新的登記
    const checkpointId = m[1].toUpperCase();
    return withReply(await teamService.registerReferee(userId, checkpointId));
  }

  if (text === "我是總領隊") {
    // 總領隊自助登記：不需要是 ADMIN_USER_IDS，登記後可以用「群發 訊息」對所有小隊長廣播
    return withReply(await teamService.registerBroadcaster(userId));
  }

  if ((m = text.match(BROADCAST_RE))) {
    // 小編或登記過的總領隊：對所有小隊長廣播一則文字訊息
    if (!isAdmin(userId) && !(await teamService.isBroadcaster(userId))) {
      return broadcastOnlyDenied();
    }
    const result = await teamService.broadcastToLeaders(m[1]);
    return { reply: result.reply, groupBroadcasts: [], directPushes: result.directPushes };
  }

  if ((groupNo = matchGroupNo(text, APPROVE_RE)) != null) {
    // 小編：對任何關卡都能直接喊過。登記過的關主：只能核准自己登記的那一關。
    let restrictToCheckpointId = null;
    if (!isAdmin(userId)) {
      restrictToCheckpointId = await teamService.getRefereeCheckpoint(userId);
      if (!restrictToCheckpointId) return approveOnlyDenied();
    }
    const result = await teamService.approveCheckpoint(groupNo, restrictToCheckpointId);
    return {
      reply: result.reply,
      groupBroadcasts: result.groupBroadcast ? [result.groupBroadcast] : [],
      directPushes: [],
    };
  }

  if ((groupNo = matchGroupNo(text, REVERT_RE)) != null) {
    // 小編手滑「通過」/「到站」按錯或按重複時的更正指令：退回一關
    if (!isAdmin(userId)) return adminOnlyDenied();
    const result = await teamService.revertLastCheckpoint(groupNo);
    return {
      reply: result.reply,
      groupBroadcasts: result.groupBroadcast ? [result.groupBroadcast] : [],
      directPushes: [],
    };
  }

  if (text === "完賽") {
    return withReply([
      teamService.textMsg(
        "本活動已改為「終點確認」制：請將隊伍實際帶到 B6，由 B6 終點工作人員為您辦理終點確認，不需要自行輸入「完賽」。"
      ),
    ]);
  }

  if (text === "遊戲結束") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    const { alreadyFrozen, groupNos } = await teamService.freezeProgress();
    const groupBroadcasts = groupNos.map((groupNo) => ({
      groupNo,
      messages: [
        teamService.textMsg(
          "⏰ 小編已提前停止受理新的關卡進度。若尚未抵達 B6，請儘速前往辦理終點確認；已完成的關卡數會保留。"
        ),
      ],
    }));
    const reply = [
      teamService.textMsg(
        alreadyFrozen
          ? "已經是停止受理新關卡進度的狀態了。"
          : `已停止受理新的關卡進度（尚在闖關中的 ${groupNos.length} 組會收到通知）。終點確認功能不受影響。`
      ),
    ];
    return { reply, groupBroadcasts, directPushes: [] };
  }

  if ((groupNo = matchGroupNo(text, TRANSFER_REQUEST_RE)) != null) {
    const result = await teamService.requestLeaderTransfer(groupNo, userId);
    return {
      reply: result.reply,
      groupBroadcasts: [],
      directPushes: result.pushes || [],
    };
  }

  if ((groupNo = matchGroupNo(text, TRANSFER_CONFIRM_RE)) != null) {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.confirmLeaderTransfer(groupNo));
  }

  if ((groupNo = matchGroupNo(text, UNBIND_RE)) != null) {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.unbindGroup(groupNo));
  }

  if ((m = text.match(BONUS_RE))) {
    // 小編任意時機、任意理由幫某組加分／扣分（例如額外任務、表現優異、犯規扣分），會影響排行榜排序
    if (!isAdmin(userId)) return adminOnlyDenied();
    const bonusGroupNo = chineseNumeralToInt(m[1]);
    const points = Number(m[2]);
    const reason = m[3] ? m[3].trim() : null;
    return withReply(await teamService.addBonusPoints(bonusGroupNo, points, reason, userId));
  }

  if (text === "重置遊戲 確認" || text === "重置遊戲確認") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.resetGame());
  }

  if (text === "重置關主") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.resetReferees());
  }

  if (text === "重置總領隊") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.resetBroadcasters());
  }

  if (text === "重置遊戲") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply([
      teamService.textMsg(
        "⚠️ 此操作將清空所有隊伍的報到、進度與紀錄，且無法復原。\n如確定要重置，請輸入「重置遊戲 確認」。"
      ),
    ]);
  }

  if (text === "使用說明") {
    return withReply([
      teamService.textMsg(
        "🌲 森呼吸．永續漫遊｜使用說明\n\n" +
          "1️⃣ 報到：輸入您的組別編號，例如「1組」或「第一組」，第一位報到者是隊長\n" +
          "2️⃣ 出發：關主確認隊伍到齊後會公布第一關\n" +
          "3️⃣ 過關：有關主的關卡輸入關主告知的關鍵字；沒有關主的關卡直接上傳照片或影片，等小編確認\n" +
          "4️⃣ 查詢：「目前關卡」看這一關資訊、「闖關進度」看完成幾關與耗時\n" +
          "5️⃣ 終點：全部關卡（或提前結束）後，帶隊伍到 B6 由工作人員辦理終點確認\n\n" +
          "有問題請直接聯繫現場小編。"
      ),
    ]);
  }

  if (text === "目前關卡") {
    return withReply(await teamService.queryCurrentCheckpoint(userId));
  }

  if (text === "闖關進度") {
    return withReply(await teamService.queryProgress(userId));
  }

  if (text === "進度") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.adminListProgress());
  }

  if (text === "排行榜") {
    if (!isAdmin(userId) && !(await teamService.isRankingPublic())) {
      return withReply([
        teamService.textMsg("排行榜目前僅開放小編查詢，請稍候。"),
      ]);
    }
    return withReply(await teamService.formatRanking());
  }

  if (text === "排行榜開啟") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    await teamService.setRankingPublic(true);
    return withReply([teamService.textMsg("已開啟排行榜公開查詢。")]);
  }

  if (text === "排行榜關閉") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    await teamService.setRankingPublic(false);
    return withReply([teamService.textMsg("已關閉排行榜公開查詢，僅小編可查詢。")]);
  }

  // 以上皆非固定指令 -> 視為關卡關鍵字嘗試（有現場關主的 6 關）
  const reply = await teamService.verifyKeyword(userId, text);
  return withReply(reply);
}

module.exports = { route };
