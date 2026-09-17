// 把 data/checkpoints.csv 匯入回 src/config/checkpoints.json。
// 只允許編輯既有 12 關的 name／location／content／scoringMethod／hasMap／mapFile，不允許新增或刪除關卡代號
// （關卡代號變動牽涉到 teamsRoute.json 與地圖圖片，請直接改 checkpoints.json 並同步調整其他地方）。
const fs = require("fs");
const path = require("path");
const { parseCsvAsObjects } = require("./csvUtil");

const CSV_PATH = path.join(__dirname, "..", "data", "checkpoints.csv");
const OUT = path.join(__dirname, "..", "src", "config", "checkpoints.json");

if (!fs.existsSync(CSV_PATH)) {
  console.error(`找不到 ${CSV_PATH}，請先執行 npm run checkpoints:export`);
  process.exit(1);
}

const existing = JSON.parse(fs.readFileSync(OUT, "utf-8"));
const existingIds = new Set(existing.map((c) => c.id));

const rows = parseCsvAsObjects(fs.readFileSync(CSV_PATH, "utf-8"));
const errors = [];
const seenIds = new Set();

const updated = rows.map((row, i) => {
  const lineNo = i + 2;
  const id = (row.id || "").trim();
  if (!existingIds.has(id)) {
    errors.push(`第 ${lineNo} 列：關卡代號「${id}」不存在，請勿新增／改動 id 欄位`);
  }
  if (seenIds.has(id)) {
    errors.push(`第 ${lineNo} 列：關卡代號「${id}」重複`);
  }
  seenIds.add(id);

  const hasMap = String(row.hasMap).trim().toUpperCase() === "TRUE";
  const verifyType = (row.verifyType || "").trim();
  if (!["keyword", "photo", "video"].includes(verifyType)) {
    errors.push(
      `第 ${lineNo} 列：verifyType「${row.verifyType}」不合法，必須是 keyword／photo／video 其中之一`
    );
  }
  return {
    id,
    name: row.name || "",
    location: row.location || "",
    content: row.content || "",
    scoringMethod: row.scoringMethod || "",
    hasMap,
    mapFile: hasMap ? row.mapFile || `${id}.jpg` : null,
    verifyType,
  };
});

for (const id of existingIds) {
  if (!seenIds.has(id)) {
    errors.push(`CSV 中缺少關卡「${id}」，請勿刪除任何一列`);
  }
}

if (errors.length > 0) {
  console.error(`檢查未通過，共 ${errors.length} 個問題，尚未覆寫 checkpoints.json：\n`);
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(updated, null, 2) + "\n", "utf-8");
console.log(`檢查通過！已寫回 ${updated.length} 關設定 -> ${OUT}`);
