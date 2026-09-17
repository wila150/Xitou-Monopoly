// 對應架構文件「七、關卡解鎖規則｜關卡通過回覆內容」
// 實際資料放在同目錄的 checkpoints.json（方便用 scripts/checkpoints-*-csv.js 以 CSV／Excel 編輯）。
// 9 個固定地點關卡（hasMap: true）需搭配 public/maps/ 底下對應檔名的地圖圖片；
// D5、C5、E2 為地點不限的彈性關卡（hasMap: false），僅提供文字說明、不附地圖。
const fs = require("fs");
const path = require("path");

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, "checkpoints.json"), "utf-8")
);

const checkpoints = {};
const FIXED_CHECKPOINT_IDS = [];
const FLEXIBLE_CHECKPOINT_IDS = [];

for (const cp of raw) {
  checkpoints[cp.id] = cp;
  (cp.hasMap ? FIXED_CHECKPOINT_IDS : FLEXIBLE_CHECKPOINT_IDS).push(cp.id);
}

function getCheckpoint(id) {
  const cp = checkpoints[id];
  if (!cp) throw new Error(`未知的關卡代號：${id}`);
  return cp;
}

module.exports = {
  checkpoints,
  getCheckpoint,
  FIXED_CHECKPOINT_IDS,
  FLEXIBLE_CHECKPOINT_IDS,
};
