// 把 data/teams-route.csv 匯入回資料庫的路線設定，並做完整性檢查：
//   - 每組必須剛好涵蓋所有關卡代號各一次（不多不少、不重複）
//   - 密語制（verifyType 'keyword'）的關卡必須填關鍵字，且同一關卡在所有組別裡的關鍵字必須完全一致
//     （目前設計是每關全部組別共用同一個密語，方便關主現場只需記一個字，而不是每組各給不同密語）
//   - 照片／影片送審制（'photo' / 'video'）與關主直接喊過制（'referee'）的關卡都不需要關鍵字，該欄位須留空
//   - checkpointId 必須是資料庫裡已存在的關卡代號
// CSV 裡出現的組別編號，不限於現有的 10 組——加一組全新的 groupNo 就會新增一組。
// 檢查沒過不會寫入資料庫，請照錯誤訊息修正 CSV 後重跑。
// 需要 DATABASE_URL 環境變數（跟伺服器連同一個資料庫）。
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { parseCsvAsObjects } = require("./csvUtil");
const db = require("../src/db");
const configStore = require("../src/config/configStore");

const CSV_PATH = path.join(__dirname, "..", "data", "teams-route.csv");

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`找不到 ${CSV_PATH}，請先執行 npm run routes:export`);
    process.exit(1);
  }

  await db.init();
  await configStore.init();

  const rows = parseCsvAsObjects(fs.readFileSync(CSV_PATH, "utf-8"));
  const errors = [];
  const byGroup = new Map();

  rows.forEach((row, i) => {
    const lineNo = i + 2;
    const groupNo = Number(row.groupNo);
    const order = Number(row.order);
    const checkpointId = (row.checkpointId || "").trim();
    const keyword = (row.keyword || "").trim();

    if (!Number.isInteger(groupNo) || groupNo < 1) {
      errors.push(`第 ${lineNo} 列：groupNo 不是有效的組別編號（${row.groupNo}）`);
      return;
    }
    if (!Number.isInteger(order) || order < 1) {
      errors.push(`第 ${lineNo} 列：order 不是有效的順序數字（${row.order}）`);
      return;
    }
    if (!configStore.hasCheckpoint(checkpointId)) {
      errors.push(`第 ${lineNo} 列：checkpointId「${checkpointId}」不是已知的關卡代號`);
      return;
    }
    const cp = configStore.getCheckpoint(checkpointId);
    if (cp.verifyType === "keyword" && !keyword) {
      errors.push(
        `第 ${lineNo} 列：關鍵字為空（第 ${groupNo} 組、${checkpointId} 是密語制，需要關鍵字）`
      );
      return;
    }
    if (cp.verifyType !== "keyword" && keyword) {
      errors.push(
        `第 ${lineNo} 列：${checkpointId}（${cp.verifyType}）不需要關鍵字，請清空該欄位（第 ${groupNo} 組）`
      );
      return;
    }

    if (!byGroup.has(groupNo)) byGroup.set(groupNo, []);
    byGroup.get(groupNo).push({ order, checkpointId, keyword: keyword || null, lineNo });
  });

  const allCheckpointIds = new Set(
    configStore.getAllCheckpoints().map((c) => c.id)
  );
  for (const [groupNo, steps] of byGroup) {
    const ids = steps.map((s) => s.checkpointId);
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) {
      errors.push(`第 ${groupNo} 組：關卡代號有重複（${ids.join(", ")}）`);
    }
    for (const requiredId of allCheckpointIds) {
      if (!idSet.has(requiredId)) {
        errors.push(`第 ${groupNo} 組：缺少關卡「${requiredId}」`);
      }
    }
  }

  const keywordByCheckpoint = new Map();
  for (const [groupNo, steps] of byGroup) {
    for (const step of steps) {
      if (!step.keyword) continue;
      const seen = keywordByCheckpoint.get(step.checkpointId);
      if (seen === undefined) {
        keywordByCheckpoint.set(step.checkpointId, { keyword: step.keyword, groupNo });
      } else if (seen.keyword !== step.keyword) {
        errors.push(
          `關卡「${step.checkpointId}」的關鍵字不一致：第${seen.groupNo}組是「${seen.keyword}」，第${groupNo}組卻是「${step.keyword}」，同一關卡所有組別須共用同一個關鍵字`
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error(`檢查未通過，共 ${errors.length} 個問題，尚未寫入資料庫：\n`);
    errors.forEach((e) => console.error(" - " + e));
    await db.pool.end();
    process.exit(1);
  }

  for (const [groupNo, steps] of byGroup) {
    const route = steps
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ checkpointId: s.checkpointId, keyword: s.keyword }));
    await configStore.setTeamRoute(groupNo, route);
  }

  console.log(`檢查通過！已寫入資料庫：${byGroup.size} 組路線設定。`);
  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
