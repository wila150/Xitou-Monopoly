// 把 data/checkpoints.csv 匯入回資料庫的關卡設定。
// 可以編輯既有關卡的 name／location／content／scoringMethod／verifyType，
// 也可以「新增一整列」來新增全新的關卡代號（CSV 裡多出來的 id 會被當成新關卡新增進資料庫）；
// 如果整列刪掉不留，該關卡也會被一起從資料庫刪除，請小心操作。
// 需要 DATABASE_URL 環境變數（跟伺服器連同一個資料庫）。
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { parseCsvAsObjects } = require("./csvUtil");
const db = require("../src/db");
const configStore = require("../src/config/configStore");

const CSV_PATH = path.join(__dirname, "..", "data", "checkpoints.csv");

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`找不到 ${CSV_PATH}，請先執行 npm run checkpoints:export`);
    process.exit(1);
  }

  await db.init();
  await configStore.init();

  const existingIds = new Set(configStore.getAllCheckpoints().map((c) => c.id));
  const rows = parseCsvAsObjects(fs.readFileSync(CSV_PATH, "utf-8"));
  const errors = [];
  const seenIds = new Set();
  const updated = [];

  rows.forEach((row, i) => {
    const lineNo = i + 2;
    const id = (row.id || "").trim();
    if (!id) {
      errors.push(`第 ${lineNo} 列：id 不能空白`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`第 ${lineNo} 列：關卡代號「${id}」重複`);
      return;
    }
    seenIds.add(id);

    const verifyType = (row.verifyType || "").trim();
    if (!["keyword", "photo", "video", "referee"].includes(verifyType)) {
      errors.push(
        `第 ${lineNo} 列：verifyType「${row.verifyType}」不合法，必須是 keyword／photo／video／referee 其中之一`
      );
      return;
    }

    const sitePhotos = (row.sitePhotos || "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const mapImages = (row.mapImages || "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    updated.push({
      id,
      name: row.name || "",
      location: row.location || "",
      content: row.content || "",
      scoringMethod: row.scoringMethod || "",
      sitePhotos,
      mapImages,
      verifyType,
    });
  });

  if (errors.length > 0) {
    console.error(`檢查未通過，共 ${errors.length} 個問題，尚未寫入資料庫：\n`);
    errors.forEach((e) => console.error(" - " + e));
    await db.pool.end();
    process.exit(1);
  }

  const removedIds = [...existingIds].filter((id) => !seenIds.has(id));
  if (removedIds.length > 0) {
    console.log(`CSV 中少了這些關卡，將會被刪除：${removedIds.join("、")}`);
  }

  for (const id of removedIds) {
    await configStore.deleteCheckpoint(id);
  }
  for (let i = 0; i < updated.length; i++) {
    await configStore.upsertCheckpoint({ ...updated[i], sortOrder: i });
  }

  console.log(`已寫入資料庫：${updated.length} 關（新增或更新），刪除 ${removedIds.length} 關。`);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
