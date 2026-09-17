// 把 src/config/checkpoints.json 匯出成 data/checkpoints.csv，方便用 Excel／Google Sheets 編輯任務說明文字。
const fs = require("fs");
const path = require("path");
const { toCsv } = require("./csvUtil");

const SRC = path.join(__dirname, "..", "src", "config", "checkpoints.json");
const OUT = path.join(__dirname, "..", "data", "checkpoints.csv");

const checkpoints = JSON.parse(fs.readFileSync(SRC, "utf-8"));

const rows = [
  ["id", "name", "location", "content", "scoringMethod", "hasMap", "mapFile", "verifyType"],
];
for (const cp of checkpoints) {
  rows.push([
    cp.id,
    cp.name,
    cp.location,
    cp.content,
    cp.scoringMethod,
    cp.hasMap ? "TRUE" : "FALSE",
    cp.mapFile || "",
    cp.verifyType,
  ]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, toCsv(rows), "utf-8");
console.log(`已匯出 ${checkpoints.length} 關 -> ${OUT}`);
console.log(
  "請用 Excel／Google Sheets 編輯 name／location／content／scoringMethod（id、hasMap、mapFile、verifyType 請勿更動），存回同一份 CSV 後執行："
);
console.log("  npm run checkpoints:import");
