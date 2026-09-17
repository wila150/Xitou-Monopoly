const teamService = require("../services/teamService");
const { isAdmin } = require("../config/admins");

const CHECKIN_RE = /^報到\s*(\d{1,2})\s*組$/;
const DEPART_RE = /^出發\s*(\d{1,2})\s*組$/;
const ARRIVE_RE = /^到站\s*(\d{1,2})\s*組$/;
const APPROVE_RE = /^通過\s*(\d{1,2})\s*組$/;
const REVERT_RE = /^退回\s*(\d{1,2})\s*組$/;
const TRANSFER_REQUEST_RE = /^接任隊長\s*(\d{1,2})\s*組$/;
const TRANSFER_CONFIRM_RE = /^確認換隊長\s*(\d{1,2})\s*組$/;
const UNBIND_RE = /^解除綁定\s*(\d{1,2})\s*組$/;

function withReply(reply) {
  return { reply, groupBroadcasts: [], directPushes: [] };
}

function adminOnlyDenied() {
  return withReply([teamService.textMsg("此指令僅限小編使用。")]);
}

// 將 teamService 各函式回傳的訊息，統一整理成
// { reply, groupBroadcasts, directPushes } 供 index.js 送出
async function route(userId, rawText) {
  const text = rawText.trim();

  let m;

  if ((m = text.match(CHECKIN_RE))) {
    return withReply(await teamService.checkin(Number(m[1]), userId));
  }

  if ((m = text.match(DEPART_RE))) {
    const groupNo = Number(m[1]);
    const result = await teamService.depart(groupNo);
    return {
      reply: result.reply,
      groupBroadcasts: result.groupBroadcast ? [result.groupBroadcast] : [],
      directPushes: [],
    };
  }

  if ((m = text.match(ARRIVE_RE))) {
    // B6 終點工作人員觸發：隊伍實際抵達 B6，直接辦理終點確認（不需要隊長輸入任何代碼）
    const groupNo = Number(m[1]);
    const result = await teamService.finishAtB6(groupNo);
    return {
      reply: result.reply,
      groupBroadcasts: result.groupBroadcast ? [result.groupBroadcast] : [],
      directPushes: [],
    };
  }

  if ((m = text.match(APPROVE_RE))) {
    // 小編確認目前這關已完成，解鎖下一關（不限關卡類型：關主關卡或照片／影片皆可用）
    if (!isAdmin(userId)) return adminOnlyDenied();
    const groupNo = Number(m[1]);
    const result = await teamService.approveCheckpoint(groupNo);
    return {
      reply: result.reply,
      groupBroadcasts: result.groupBroadcast ? [result.groupBroadcast] : [],
      directPushes: [],
    };
  }

  if ((m = text.match(REVERT_RE))) {
    // 小編手滑「通過」/「到站」按錯或按重複時的更正指令：退回一關
    if (!isAdmin(userId)) return adminOnlyDenied();
    const groupNo = Number(m[1]);
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

  if ((m = text.match(TRANSFER_REQUEST_RE))) {
    const result = await teamService.requestLeaderTransfer(Number(m[1]), userId);
    return {
      reply: result.reply,
      groupBroadcasts: [],
      directPushes: result.pushes || [],
    };
  }

  if ((m = text.match(TRANSFER_CONFIRM_RE))) {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.confirmLeaderTransfer(Number(m[1])));
  }

  if ((m = text.match(UNBIND_RE))) {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.unbindGroup(Number(m[1])));
  }

  if (text === "重置遊戲 確認" || text === "重置遊戲確認") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply(await teamService.resetGame());
  }

  if (text === "重置遊戲") {
    if (!isAdmin(userId)) return adminOnlyDenied();
    return withReply([
      teamService.textMsg(
        "⚠️ 此操作將清空所有隊伍的報到、進度與紀錄，且無法復原。\n如確定要重置，請輸入「重置遊戲 確認」。"
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
