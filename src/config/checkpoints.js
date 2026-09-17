// 關卡設定的薄封裝，實際資料與快取都在 configStore.js（存資料庫，後台網頁可編輯）。
// 保留這個檔案是因為原本程式碼慣用 require("../config/checkpoints") 這個路徑。
const configStore = require("./configStore");

module.exports = {
  getCheckpoint: configStore.getCheckpoint,
  hasCheckpoint: configStore.hasCheckpoint,
  getAllCheckpoints: configStore.getAllCheckpoints,
  getFixedCheckpointIds: configStore.getFixedCheckpointIds,
  getFlexibleCheckpointIds: configStore.getFlexibleCheckpointIds,
};
