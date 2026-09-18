const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render 的免費 Postgres 需要 SSL，本機開發連線不需要，用環境變數區分
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

// 把既有程式碼慣用的 "?" 參數佔位符轉成 pg 需要的 "$1, $2, ..."，
// 讓 teamService.js 的 SQL 字串幾乎不用改寫。
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makeExecutor(runQuery) {
  return {
    async run(sql, params = []) {
      await runQuery(toPgSql(sql), params);
    },
    async get(sql, params = []) {
      const res = await runQuery(toPgSql(sql), params);
      return res.rows[0];
    },
    async all(sql, params = []) {
      const res = await runQuery(toPgSql(sql), params);
      return res.rows;
    },
  };
}

// 一般查詢（非交易）：直接向連線池下指令
const db = makeExecutor((text, params) => pool.query(text, params));

// 交易：checkout 一個專屬 client，包住 BEGIN/COMMIT/ROLLBACK，
// callback 收到的 tx 物件有一樣的 run/get/all 介面，但都跑在同一個交易裡。
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = makeExecutor((text, params) => client.query(text, params));
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// 狀態機對應架構文件 v2「二、隊伍狀態流程」：
// ①②已報到／待出發合併為 CHECKED_IN（文件中兩者間沒有獨立觸發指令，皆是「等待關主宣布出發」）
// ③闖關中 = IN_PROGRESS　④已在B6辦理終點確認 = FINISHED
// finish_time／is_late 只會在 B6 工作人員觸發「到站 X組」時才寫入，
// 12:30 或小編「遊戲結束」只會凍結 current_index（見 settings 的 progress_frozen_at），不會自動產生 finish_time。
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS teams (
  group_no        INTEGER PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'CHECKED_IN',
  leader_user_id  TEXT,
  checked_in_at   TEXT,
  start_time      TEXT,
  current_index   INTEGER NOT NULL DEFAULT 0,
  finish_time     TEXT,
  is_late         INTEGER NOT NULL DEFAULT 0,
  bonus_points    INTEGER NOT NULL DEFAULT 0
);

-- 小編手動加分／扣分的紀錄（任意時機、任意理由，例如額外任務、表現優異、犯規扣分）。
-- 跟 checkpoint_log 分開存，因為這不是關卡進度，是額外的人工調整，需要留紀錄方便事後對帳。
CREATE TABLE IF NOT EXISTS bonus_log (
  id            SERIAL PRIMARY KEY,
  group_no      INTEGER NOT NULL,
  points        INTEGER NOT NULL,
  reason        TEXT,
  awarded_by    TEXT NOT NULL,
  awarded_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  user_id    TEXT PRIMARY KEY,
  group_no   INTEGER NOT NULL,
  role       TEXT NOT NULL, -- 'LEADER' | 'MEMBER'
  joined_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoint_log (
  id                SERIAL PRIMARY KEY,
  group_no          INTEGER NOT NULL,
  checkpoint_index  INTEGER NOT NULL,
  checkpoint_id     TEXT NOT NULL,
  passed_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leader_transfer_requests (
  id                 SERIAL PRIMARY KEY,
  group_no           INTEGER NOT NULL,
  requester_user_id  TEXT NOT NULL,
  requested_at       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING' -- 'PENDING' | 'APPROVED' | 'SUPERSEDED'
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- 關主自己傳「我是 B3 關主」登記，之後這個帳號打「通過 X組」只對登記的那一關生效
CREATE TABLE IF NOT EXISTS referees (
  user_id        TEXT PRIMARY KEY,
  checkpoint_id  TEXT NOT NULL,
  registered_at  TEXT NOT NULL
);

-- 總領隊自己傳「我是總領隊」登記，不需要是 ADMIN_USER_IDS 也能用「群發 訊息」對所有小隊長廣播
CREATE TABLE IF NOT EXISTS broadcasters (
  user_id        TEXT PRIMARY KEY,
  registered_at  TEXT NOT NULL
);

-- 關卡設定與 10 組路線密語：原本存在 checkpoints.json / teamsRoute.json，
-- 現在改成存資料庫，讓後台網頁編輯的內容不會被下次部署蓋掉。
-- 第一次啟動時會自動從 JSON 檔案匯入一份初始值（見 src/config/configStore.js 的 seedIfEmpty）。
-- site_photos／map_images 是兩種不同用途的圖片（見下方 checkpoint_images 的說明）：
--   site_photos＝現場照片（這關實際長什麼樣子／任務參考照），map_images＝地圖位置圖（怎麼走到這關）
CREATE TABLE IF NOT EXISTS checkpoint_configs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  location        TEXT NOT NULL,
  content         TEXT NOT NULL,
  scoring_method  TEXT NOT NULL,
  verify_type     TEXT NOT NULL, -- 'keyword' | 'referee' | 'photo' | 'video'
  site_photos     TEXT NOT NULL DEFAULT '[]', -- JSON 陣列字串，現場照片檔名
  map_images      TEXT NOT NULL DEFAULT '[]', -- JSON 陣列字串，地圖位置圖檔名
  sort_order      INTEGER NOT NULL DEFAULT 0
);

-- 後台網頁上傳的圖片存在這裡（bytea），不是存在網頁服務本機硬碟：
-- Render 免費方案的網頁服務磁碟是暫時性的，重新部署或閒置關機喚醒都會清空本機檔案，
-- 必須存資料庫才能保證小編上傳的照片不會無故消失（這也是這個系統從頭到尾用 Postgres 而不用本機檔案的同一個原因）。
-- 專案原本內建、隨 git 一起部署的示意圖／現場照片（public/maps/ 下）不受影響——
-- GET /maps/:filename 會先查這張表，查不到才 fallback 到 public/maps/ 的靜態檔案。
CREATE TABLE IF NOT EXISTS checkpoint_images (
  filename     TEXT PRIMARY KEY,
  mime_type    TEXT NOT NULL,
  data         BYTEA NOT NULL,
  uploaded_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_route_configs (
  group_no       INTEGER NOT NULL,
  order_index    INTEGER NOT NULL,
  checkpoint_id  TEXT NOT NULL,
  keyword        TEXT,
  PRIMARY KEY (group_no, order_index)
);

CREATE INDEX IF NOT EXISTS idx_team_members_group ON team_members(group_no);
CREATE INDEX IF NOT EXISTS idx_checkpoint_log_group ON checkpoint_log(group_no);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_group ON leader_transfer_requests(group_no, status);
`;

// 既有正式環境的 checkpoint_configs 表原本只有單一欄位 map_files，
// 這裡把它拆成 site_photos／map_images 兩欄：舊資料本來就是現場照片，直接搬過去，
// map_images 是全新欄位，之後在後台網頁另外上傳。CREATE TABLE IF NOT EXISTS 不會改動已存在的表，
// 所以新舊欄位的搬遷要用 ALTER TABLE 額外處理，且要能重複執行不出錯（IF NOT EXISTS／先檢查再 DROP）。
async function migrateCheckpointImageColumns() {
  await pool.query(
    `ALTER TABLE checkpoint_configs ADD COLUMN IF NOT EXISTS site_photos TEXT NOT NULL DEFAULT '[]'`
  );
  await pool.query(
    `ALTER TABLE checkpoint_configs ADD COLUMN IF NOT EXISTS map_images TEXT NOT NULL DEFAULT '[]'`
  );
  const oldColumn = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'checkpoint_configs' AND column_name = 'map_files'`
  );
  if (oldColumn.rows.length > 0) {
    await pool.query(
      `UPDATE checkpoint_configs SET site_photos = map_files WHERE map_files IS NOT NULL`
    );
    await pool.query(`ALTER TABLE checkpoint_configs DROP COLUMN map_files`);
  }
}

// 既有正式環境的 teams 表沒有 bonus_points 欄位，CREATE TABLE IF NOT EXISTS 不會補上，要額外 ALTER TABLE。
async function migrateBonusPointsColumn() {
  await pool.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS bonus_points INTEGER NOT NULL DEFAULT 0`);
}

async function init() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "缺少 DATABASE_URL 環境變數，請設定 Postgres 連線字串（見 .env.example）"
    );
  }
  await pool.query(SCHEMA_SQL);
  await migrateCheckpointImageColumns();
  await migrateBonusPointsColumn();
}

module.exports = { db, transaction, init, pool };
