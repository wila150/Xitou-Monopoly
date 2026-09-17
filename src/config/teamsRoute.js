// 對應架構文件 v2「四、10組正式路線表」與「八、關卡解鎖規則」
// 路線順序完全依照活動方提供的正式路線表，10 組互不相同（第10組特例：第1關是B6）。
// 每一關依 checkpoints.json 的 verifyType 決定過關方式：
//   - 'keyword'：該關卡有現場關主，route 裡該步驟需要填 keyword（活動前請填入真實關鍵字）
//   - 'photo' / 'video'：該關卡沒有現場關主，改用上傳照片／影片自動偵測過關，route 裡該步驟不需要 keyword
const fs = require("fs");
const path = require("path");
const { checkpoints } = require("./checkpoints");

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, "teamsRoute.json"), "utf-8")
);

const routesByGroup = new Map();

for (const team of raw) {
  const { groupNo, route } = team;
  if (!Array.isArray(route) || route.length === 0) {
    throw new Error(`第 ${groupNo} 組的路線設定為空`);
  }
  for (const step of route) {
    const cp = checkpoints[step.checkpointId];
    if (!cp) {
      throw new Error(
        `第 ${groupNo} 組路線中出現未知的關卡代號：${step.checkpointId}`
      );
    }
    if (cp.verifyType === "keyword" && !step.keyword) {
      throw new Error(
        `第 ${groupNo} 組、關卡 ${step.checkpointId}（有關主）尚未設定關鍵字`
      );
    }
  }
  routesByGroup.set(groupNo, route);
}

function getRoute(groupNo) {
  const route = routesByGroup.get(Number(groupNo));
  if (!route) throw new Error(`找不到第 ${groupNo} 組的路線設定`);
  return route;
}

function getAllGroupNos() {
  return Array.from(routesByGroup.keys()).sort((a, b) => a - b);
}

module.exports = { getRoute, getAllGroupNos };
