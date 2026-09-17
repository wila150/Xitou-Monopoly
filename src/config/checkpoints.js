// 對應架構文件「七、關卡解鎖規則｜關卡通過回覆內容」
// 實際資料放在同目錄的 checkpoints.json（方便用 scripts/checkpoints-*-csv.js 以 CSV／Excel 編輯）。
// mapFiles 是圖片檔名陣列（對應 public/maps/ 底下的檔案），可以 0 張（地點不限的彈性關卡）、
// 1 張，或多張（例如同一地點有好幾個角度的照片，會依序全部傳送）。
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
  const hasMap = Array.isArray(cp.mapFiles) && cp.mapFiles.length > 0;
  (hasMap ? FIXED_CHECKPOINT_IDS : FLEXIBLE_CHECKPOINT_IDS).push(cp.id);
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
