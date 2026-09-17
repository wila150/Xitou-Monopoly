// 把 src/config/checkpoints.json 匯出成 data/checkpoints.csv，方便用 Excel／Google Sheets 編輯任務說明文字。
const fs = require("fs");
const path = require("path");
const { toCsv } = require("./csvUtil");

const SRC = path.join(__dirname, "..", "src", "config", "checkpoints.json");
const OUT = path.join(__dirname, "..", "data", "checkpoints.csv");

const checkpoints = JSON.parse(fs.readFileSync(SRC, "utf-8"));

const rows = [
  ["id", "name", "location", "content", "scoringMethod", "mapFiles", "verifyType"],
];
for (const cp of checkpoints) {
  rows.push([
    cp.id,
    cp.name,
    cp.location,
    cp.content,
    cp.scoringMethod,
    (cp.mapFiles || []).join(";"),
    cp.verifyType,
  ]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, toCsv(rows), "utf-8");
console.log(`已匯出 ${checkpoints.length} 關 -> ${OUT}`);
console.log(
  "請用 Excel／Google Sheets 編輯 name／location／content／scoringMethod（id、verifyType 請勿更動）。"
);
console.log(
  "mapFiles 一格可以放多張圖片檔名，用「;」分隔（例如 B4-1.jpg;B4-2.jpg），沒有圖片就留空。存檔後執行："
);
console.log("  npm run checkpoints:import");
