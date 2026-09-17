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
  is_late         INTEGER NOT NULL DEFAULT 0
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
CREATE TABLE IF NOT EXISTS checkpoint_configs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  location        TEXT NOT NULL,
  content         TEXT NOT NULL,
  scoring_method  TEXT NOT NULL,
  verify_type     TEXT NOT NULL, -- 'keyword' | 'referee' | 'photo' | 'video'
  map_files       TEXT NOT NULL DEFAULT '[]', -- JSON 陣列字串，例如 ["B4-1.jpg","B4-2.jpg"]
  sort_order      INTEGER NOT NULL DEFAULT 0
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

async function init() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "缺少 DATABASE_URL 環境變數，請設定 Postgres 連線字串（見 .env.example）"
    );
  }
  await pool.query(SCHEMA_SQL);
}

module.exports = { db, transaction, init, pool };
