// 對應架構文件「三、角色與權限｜小編／管理員」
// 管理指令（進度、排行榜查詢、遊戲結束、確認換隊長、解除綁定、重置遊戲、退回…）僅限這裡列出的 userId 使用。
// 關主的「通過 X組」權限不是靠這個名單控制，而是關主自己傳「我是 XX 關主」登記
// （見 teamService.registerReferee），存在資料庫裡，不需要在這裡手動維護。
function getAdminIds() {
  return (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAdmin(userId) {
  return getAdminIds().includes(userId);
}

module.exports = { getAdminIds, isAdmin };
