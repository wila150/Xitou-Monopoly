// 把 src/config/teamsRoute.json 匯出成 data/teams-route.csv，方便用 Excel／Google Sheets 編輯。
const fs = require("fs");
const path = require("path");
const { toCsv } = require("./csvUtil");
const { checkpoints } = require("../src/config/checkpoints");

const SRC = path.join(__dirname, "..", "src", "config", "teamsRoute.json");
const OUT = path.join(__dirname, "..", "data", "teams-route.csv");

const teams = JSON.parse(fs.readFileSync(SRC, "utf-8"));

const rows = [["groupNo", "order", "checkpointId", "verifyType", "keyword"]];
for (const team of teams) {
  team.route.forEach((step, index) => {
    const verifyType = checkpoints[step.checkpointId].verifyType;
    rows.push([team.groupNo, index + 1, step.checkpointId, verifyType, step.keyword]);
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, toCsv(rows), "utf-8");
console.log(`已匯出 ${teams.length} 組、共 ${rows.length - 1} 列 -> ${OUT}`);
console.log("verifyType 欄位僅供參考、匯入時會忽略：'keyword' 的列才需要填 keyword（現場關主給的關鍵字，");
console.log("同一關卡 10 組請填同一個值）；'photo' / 'video' 的列不需要 keyword，請留空。");
console.log("用 Excel/Sheets 開啟編輯 order（路線順序）與 keyword，存回同一份 CSV 後執行：");
console.log("  npm run routes:import");
