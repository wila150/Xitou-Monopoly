// 把資料庫裡的路線設定匯出成 data/teams-route.csv，方便用 Excel／Google Sheets 編輯。
// 需要 DATABASE_URL 環境變數（跟伺服器連同一個資料庫）。
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { toCsv } = require("./csvUtil");
const db = require("../src/db");
const configStore = require("../src/config/configStore");

const OUT = path.join(__dirname, "..", "data", "teams-route.csv");

async function main() {
  await db.init();
  await configStore.init();

  const rows = [["groupNo", "order", "checkpointId", "verifyType", "keyword"]];
  let total = 0;
  for (const groupNo of configStore.getAllGroupNos()) {
    const route = configStore.getRoute(groupNo);
    route.forEach((step, index) => {
      const verifyType = configStore.getCheckpoint(step.checkpointId).verifyType;
      rows.push([groupNo, index + 1, step.checkpointId, verifyType, step.keyword || ""]);
      total++;
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, toCsv(rows), "utf-8");
  console.log(
    `已從資料庫匯出 ${configStore.getAllGroupNos().length} 組、共 ${total} 列 -> ${OUT}`
  );
  console.log(
    "verifyType 欄位僅供參考、匯入時會忽略：'keyword' 的列才要填 keyword（同一關卡 10 組請填同一個值）；"
  );
  console.log("'photo' / 'video' / 'referee' 的列不需要 keyword，請留空。");
  console.log("要新增一組全新的組別，直接在 CSV 最後面加新的 groupNo 對應 12 列即可。存檔後執行：");
  console.log("  npm run routes:import");

  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
