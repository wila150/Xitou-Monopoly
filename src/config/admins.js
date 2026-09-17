// 對應架構文件「三、角色與權限｜小編／管理員」，並延伸出一個更小範圍的「關主」角色。
// - 小編／管理員（ADMIN_USER_IDS）：所有管理指令都能用（進度、排行榜、遊戲結束、
//   確認換隊長、解除綁定、重置遊戲、退回、通過…）
// - 關主／工作人員（STAFF_USER_IDS）：只能用「通過 X組」回報關卡完成，
//   不能用其他管理指令。用在讓現場關主自己回報「這組過關了」，
//   不需要事事都透過小編轉達，但權限比照小編小很多，只開放這一個指令。
function parseIds(envValue) {
  return (envValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getAdminIds() {
  return parseIds(process.env.ADMIN_USER_IDS);
}

function getStaffIds() {
  return parseIds(process.env.STAFF_USER_IDS);
}

function isAdmin(userId) {
  return getAdminIds().includes(userId);
}

function isStaff(userId) {
  return getStaffIds().includes(userId);
}

// 可以使用「通過 X組」的人：小編，或登記在關主名單裡的人
function canApproveCheckpoint(userId) {
  return isAdmin(userId) || isStaff(userId);
}

module.exports = { getAdminIds, getStaffIds, isAdmin, isStaff, canApproveCheckpoint };
