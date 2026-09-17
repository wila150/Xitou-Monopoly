// 關卡設定與 10 組路線密語的存取層。
// 資料實際存在 Postgres（checkpoint_configs／team_route_configs 兩張表），
// 第一次啟動時如果這兩張表是空的，會從 checkpoints.json／teamsRoute.json 匯入一份初始值當種子資料，
// 之後所有讀寫都走資料庫，不會再被下次部署蓋掉——後台網頁編輯的內容會一直留著。
//
// 讀取端維持跟以前一樣的同步函式（getCheckpoint／getRoute…），呼叫前必須先 await init() 過一次
// （src/index.js 開機時、以及 tests 的 test.before 都會呼叫），之後每次寫入都會自動 reload() 更新快取，
// 所以其餘商業邏輯完全不用改成 async，也不用擔心讀到過期資料。
const fs = require("fs");
const path = require("path");
const { db } = require("../db");
const imageStore = require("./imageStore");

let checkpointsById = {};
let routesByGroup = new Map();

async function seedIfEmpty() {
  const cpCount = await db.get("SELECT COUNT(*)::int AS c FROM checkpoint_configs");
  if (Number(cpCount.c) === 0) {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, "checkpoints.json"), "utf-8")
    );
    for (let i = 0; i < raw.length; i++) {
      const cp = raw[i];
      await db.run(
        `INSERT INTO checkpoint_configs (id, name, location, content, scoring_method, verify_type, site_photos, map_images, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cp.id,
          cp.name,
          cp.location,
          cp.content,
          cp.scoringMethod,
          cp.verifyType,
          JSON.stringify(cp.sitePhotos || cp.mapFiles || []),
          JSON.stringify(cp.mapImages || []),
          i,
        ]
      );
    }
  }

  const routeCount = await db.get("SELECT COUNT(*)::int AS c FROM team_route_configs");
  if (Number(routeCount.c) === 0) {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, "teamsRoute.json"), "utf-8")
    );
    for (const team of raw) {
      for (let i = 0; i < team.route.length; i++) {
        const step = team.route[i];
        await db.run(
          `INSERT INTO team_route_configs (group_no, order_index, checkpoint_id, keyword)
           VALUES (?, ?, ?, ?)`,
          [team.groupNo, i, step.checkpointId, step.keyword]
        );
      }
    }
  }
}

async function reload() {
  const cpRows = await db.all(
    "SELECT * FROM checkpoint_configs ORDER BY sort_order, id"
  );
  const newCheckpoints = {};
  for (const row of cpRows) {
    newCheckpoints[row.id] = {
      id: row.id,
      name: row.name,
      location: row.location,
      content: row.content,
      scoringMethod: row.scoring_method,
      verifyType: row.verify_type,
      sitePhotos: JSON.parse(row.site_photos || "[]"),
      mapImages: JSON.parse(row.map_images || "[]"),
      sortOrder: row.sort_order,
    };
  }
  checkpointsById = newCheckpoints;

  const routeRows = await db.all(
    "SELECT * FROM team_route_configs ORDER BY group_no, order_index"
  );
  const newRoutes = new Map();
  for (const row of routeRows) {
    if (!newRoutes.has(row.group_no)) newRoutes.set(row.group_no, []);
    newRoutes
      .get(row.group_no)
      .push({ checkpointId: row.checkpoint_id, keyword: row.keyword });
  }
  routesByGroup = newRoutes;
}

async function init() {
  await seedIfEmpty();
  await reload();
}

// ---- 關卡讀取 ----

function getCheckpoint(id) {
  const cp = checkpointsById[id];
  if (!cp) throw new Error(`未知的關卡代號：${id}`);
  return cp;
}

function hasCheckpoint(id) {
  return Object.prototype.hasOwnProperty.call(checkpointsById, id);
}

function getAllCheckpoints() {
  return Object.values(checkpointsById);
}

function getFixedCheckpointIds() {
  return getAllCheckpoints()
    .filter((cp) => cp.sitePhotos.length > 0)
    .map((cp) => cp.id);
}

function getFlexibleCheckpointIds() {
  return getAllCheckpoints()
    .filter((cp) => cp.sitePhotos.length === 0)
    .map((cp) => cp.id);
}

// ---- 路線讀取 ----

function getRoute(groupNo) {
  const route = routesByGroup.get(Number(groupNo));
  if (!route) throw new Error(`找不到第 ${groupNo} 組的路線設定`);
  return route;
}

function getAllGroupNos() {
  return Array.from(routesByGroup.keys()).sort((a, b) => a - b);
}

// ---- 後台網頁用的寫入 API：每次寫完都會自動 reload() ----

async function upsertCheckpoint(cp) {
  await db.run(
    `INSERT INTO checkpoint_configs (id, name, location, content, scoring_method, verify_type, site_photos, map_images, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       location = excluded.location,
       content = excluded.content,
       scoring_method = excluded.scoring_method,
       verify_type = excluded.verify_type,
       site_photos = excluded.site_photos,
       map_images = excluded.map_images,
       sort_order = excluded.sort_order`,
    [
      cp.id,
      cp.name,
      cp.location,
      cp.content,
      cp.scoringMethod,
      cp.verifyType,
      JSON.stringify(cp.sitePhotos || []),
      JSON.stringify(cp.mapImages || []),
      cp.sortOrder ?? 999,
    ]
  );
  await reload();
}

// 只更新一般欄位（不含 site_photos／map_images），給後台網頁「儲存」按鈕用。
// 刻意不去動圖片欄位，避免「按儲存」跟「上傳／刪除圖片」兩個請求前後腳送出時，
// 儲存那邊帶著舊的圖片清單快照把剛上傳的圖片蓋掉（read-modify-write 競爭問題）。
async function updateCheckpointFields(cp) {
  await db.run(
    `UPDATE checkpoint_configs
     SET name = ?, location = ?, content = ?, scoring_method = ?, verify_type = ?,
         sort_order = COALESCE(?, sort_order)
     WHERE id = ?`,
    [cp.name, cp.location, cp.content, cp.scoringMethod, cp.verifyType, cp.sortOrder ?? null, cp.id]
  );
  await reload();
}

// 圖片新增／刪除改用資料庫端的 jsonb 陣列運算做原子更新，不用「讀出陣列、在 JS 改、整包寫回」，
// 理由同上：避免跟其他同時發生的寫入互相蓋掉彼此的圖片清單。
function imageColumn(field) {
  if (field === "sitePhotos") return "site_photos";
  if (field === "mapImages") return "map_images";
  throw new Error(`未知的圖片欄位：${field}`);
}

async function appendCheckpointImage(id, field, filename) {
  const column = imageColumn(field);
  await db.run(
    `UPDATE checkpoint_configs
     SET ${column} = (COALESCE(${column}::jsonb, '[]'::jsonb) || to_jsonb(?::text))::text
     WHERE id = ?`,
    [filename, id]
  );
  await reload();
}

async function removeCheckpointImage(id, field, filename) {
  const column = imageColumn(field);
  await db.run(
    `UPDATE checkpoint_configs
     SET ${column} = COALESCE(
       (SELECT jsonb_agg(elem) FROM jsonb_array_elements_text(${column}::jsonb) elem WHERE elem <> ?),
       '[]'::jsonb
     )::text
     WHERE id = ?`,
    [filename, id]
  );
  await reload();
}

async function deleteCheckpoint(id) {
  // 連同這關已上傳到資料庫的圖片一起清掉，避免刪關卡後留下沒有任何關卡引用的孤兒圖片
  if (hasCheckpoint(id)) {
    const cp = getCheckpoint(id);
    await Promise.all(
      [...cp.sitePhotos, ...cp.mapImages].map((filename) => imageStore.deleteImage(filename))
    );
  }
  await db.run("DELETE FROM checkpoint_configs WHERE id = ?", [id]);
  await reload();
}

function validateRoute(route) {
  if (!Array.isArray(route) || route.length === 0) {
    throw new Error("路線不能是空的");
  }
  const seen = new Set();
  for (const step of route) {
    if (!hasCheckpoint(step.checkpointId)) {
      throw new Error(`未知的關卡代號：${step.checkpointId}`);
    }
    if (seen.has(step.checkpointId)) {
      throw new Error(`路線中「${step.checkpointId}」重複出現`);
    }
    seen.add(step.checkpointId);
    const cp = getCheckpoint(step.checkpointId);
    if (cp.verifyType === "keyword" && !step.keyword) {
      throw new Error(`關卡「${step.checkpointId}」是密語制，必須填 keyword`);
    }
  }
}

// route: [{ checkpointId, keyword }, ...]，會整組覆蓋掉該組原本的路線設定
async function setTeamRoute(groupNo, route) {
  validateRoute(route);
  await db.run("DELETE FROM team_route_configs WHERE group_no = ?", [groupNo]);
  for (let i = 0; i < route.length; i++) {
    const step = route[i];
    await db.run(
      `INSERT INTO team_route_configs (group_no, order_index, checkpoint_id, keyword)
       VALUES (?, ?, ?, ?)`,
      [groupNo, i, step.checkpointId, step.keyword || null]
    );
  }
  await reload();
}

async function deleteTeamRoute(groupNo) {
  await db.run("DELETE FROM team_route_configs WHERE group_no = ?", [groupNo]);
  await reload();
}

module.exports = {
  init,
  reload,
  getCheckpoint,
  hasCheckpoint,
  getAllCheckpoints,
  getFixedCheckpointIds,
  getFlexibleCheckpointIds,
  getRoute,
  getAllGroupNos,
  upsertCheckpoint,
  updateCheckpointFields,
  appendCheckpointImage,
  removeCheckpointImage,
  deleteCheckpoint,
  setTeamRoute,
  deleteTeamRoute,
};
