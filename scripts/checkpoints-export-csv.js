// 把資料庫裡的關卡設定匯出成 data/checkpoints.csv，方便用 Excel／Google Sheets 編輯任務說明文字。
// 需要 DATABASE_URL 環境變數（跟伺服器連同一個資料庫）。
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { toCsv } = require("./csvUtil");
const db = require("../src/db");
const configStore = require("../src/config/configStore");

const OUT = path.join(__dirname, "..", "data", "checkpoints.csv");

async function main() {
  await db.init();
  await configStore.init();

  const checkpoints = configStore.getAllCheckpoints();
  const rows = [
    ["id", "name", "location", "content", "scoringMethod", "sitePhotos", "mapImages", "verifyType"],
  ];
  for (const cp of checkpoints) {
    rows.push([
      cp.id,
      cp.name,
      cp.location,
      cp.content,
      cp.scoringMethod,
      (cp.sitePhotos || []).join(";"),
      (cp.mapImages || []).join(";"),
      cp.verifyType,
    ]);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, toCsv(rows), "utf-8");
  console.log(`已從資料庫匯出 ${checkpoints.length} 關 -> ${OUT}`);
  console.log(
    "請用 Excel／Google Sheets 編輯 name／location／content／scoringMethod（id、verifyType 請勿更動）。"
  );
  console.log(
    "sitePhotos（現場照片）／mapImages（地圖位置圖）一格可以放多張圖片檔名，用「;」分隔，沒有圖片就留空。" +
      "這兩欄只是參考現有檔名，實際上傳／刪除圖片請用後台網頁（/admin），這裡改檔名不會真的搬動圖片。存檔後執行："
  );
  console.log("  npm run checkpoints:import");

  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
