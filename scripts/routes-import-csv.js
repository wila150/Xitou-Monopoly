// 把 data/teams-route.csv 匯入回 src/config/teamsRoute.json，並做完整性檢查：
//   - 每組必須剛好涵蓋所有關卡代號各一次（不多不少、不重複）
//   - 密語制（verifyType 'keyword'，目前是 A3、A5）的關卡必須填關鍵字，且同一關卡在 10 組裡的關鍵字必須完全一致
//     （目前設計是每關全部組別共用同一個密語，方便關主現場只需記一個字，而不是 10 組各給不同密語）
//   - 照片／影片送審制（verifyType 'photo' / 'video'）與關主直接喊過制（verifyType 'referee'，
//     目前是 B3、B4、D6、C4）的關卡都不需要關鍵字，該欄位須留空
//   - checkpointId 必須是 checkpoints.json 裡存在的代號
// 檢查沒過不會覆寫 teamsRoute.json，請照錯誤訊息修正 CSV 後重跑。
const fs = require("fs");
const path = require("path");
const { parseCsvAsObjects } = require("./csvUtil");

const CSV_PATH = path.join(__dirname, "..", "data", "teams-route.csv");
const OUT = path.join(__dirname, "..", "src", "config", "teamsRoute.json");
const CHECKPOINTS_PATH = path.join(__dirname, "..", "src", "config", "checkpoints.json");

const checkpoints = JSON.parse(fs.readFileSync(CHECKPOINTS_PATH, "utf-8"));
const checkpointById = new Map(checkpoints.map((c) => [c.id, c]));

if (!fs.existsSync(CSV_PATH)) {
  console.error(`找不到 ${CSV_PATH}，請先執行 npm run routes:export`);
  process.exit(1);
}

const rows = parseCsvAsObjects(fs.readFileSync(CSV_PATH, "utf-8"));
const errors = [];
const byGroup = new Map();

rows.forEach((row, i) => {
  const lineNo = i + 2; // +1 表頭 +1 從 1 起算
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
  const cp = checkpointById.get(checkpointId);
  if (!cp) {
    errors.push(`第 ${lineNo} 列：checkpointId「${checkpointId}」不是已知的關卡代號`);
    return;
  }
  if (cp.verifyType === "keyword" && !keyword) {
    errors.push(
      `第 ${lineNo} 列：關鍵字為空（第 ${groupNo} 組、${checkpointId} 有關主，需要關鍵字）`
    );
    return;
  }
  if (cp.verifyType !== "keyword" && keyword) {
    errors.push(
      `第 ${lineNo} 列：${checkpointId} 無關主（${cp.verifyType}），不需要關鍵字，請清空該欄位（第 ${groupNo} 組）`
    );
    return;
  }

  if (!byGroup.has(groupNo)) byGroup.set(groupNo, []);
  byGroup.get(groupNo).push({ order, checkpointId, keyword: keyword || null, lineNo });
});

// 每組必須剛好包含全部關卡代號各一次
const allCheckpointIds = new Set(checkpointById.keys());
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

// 同一關卡（有關主）的關鍵字，10 組必須完全一致
const keywordByCheckpoint = new Map();
for (const [groupNo, steps] of byGroup) {
  for (const step of steps) {
    if (!step.keyword) continue;
    const seen = keywordByCheckpoint.get(step.checkpointId);
    if (seen === undefined) {
      keywordByCheckpoint.set(step.checkpointId, { keyword: step.keyword, groupNo });
    } else if (seen.keyword !== step.keyword) {
      errors.push(
        `關卡「${step.checkpointId}」的關鍵字不一致：第${seen.groupNo}組是「${seen.keyword}」，第${groupNo}組卻是「${step.keyword}」，同一關卡 10 組須共用同一個關鍵字`
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`檢查未通過，共 ${errors.length} 個問題，尚未覆寫 teamsRoute.json：\n`);
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
}

const teams = Array.from(byGroup.entries())
  .sort((a, b) => a[0] - b[0])
  .map(([groupNo, steps]) => ({
    groupNo,
    route: steps
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ checkpointId: s.checkpointId, keyword: s.keyword })),
  }));

fs.writeFileSync(OUT, JSON.stringify(teams, null, 2) + "\n", "utf-8");
console.log(`檢查通過！已寫回 ${teams.length} 組路線設定 -> ${OUT}`);
