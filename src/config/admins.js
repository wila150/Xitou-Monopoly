// 對應架構文件「三、角色與權限｜小編／管理員」
// 管理指令（進度、排行榜查詢、遊戲結束、確認換隊長、解除綁定…）僅限這裡列出的 userId 使用
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
