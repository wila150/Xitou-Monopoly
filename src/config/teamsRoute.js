// 路線設定的薄封裝，實際資料與快取都在 configStore.js（存資料庫，後台網頁可編輯，
// 也可以新增原本沒有的組別）。保留這個檔案是因為原本程式碼慣用這個 require 路徑。
const configStore = require("./configStore");

module.exports = {
  getRoute: configStore.getRoute,
  getAllGroupNos: configStore.getAllGroupNos,
};
