// 傳過訊息／加好友的 LINE 使用者名單（userId＋顯示名稱），供後台「指定關主／總領隊」挑選。
// LINE 沒有公開的「列出全部好友」API，所以只記錄有跟機器人互動過的人；從隊伍、關主、總領隊資料表補登既有的人（backfill）。
const { db } = require("../db");

// 記下這個人剛剛互動過，回傳是否還缺顯示名稱（缺才需要去問 LINE，避免每則訊息都打一次 API）
async function touch(userId) {
  const now = new Date().toISOString();
  const row = await db.get(
    `INSERT INTO line_users (user_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
     RETURNING display_name`,
    [userId, now, now]
  );
  return !row.display_name;
}

async function setDisplayName(userId, displayName) {
  await db.run("UPDATE line_users SET display_name = ? WHERE user_id = ?", [displayName, userId]);
}

// 既有的隊伍成員、關主、總領隊、緊急聯絡回報者，就算還沒在新版本互動過，也先放進名單
async function backfill() {
  const now = new Date().toISOString();
  for (const table of ["team_members", "referees", "broadcasters"]) {
    await db.run(
      `INSERT INTO line_users (user_id, first_seen_at, last_seen_at)
       SELECT user_id, ?, ? FROM ${table}
       ON CONFLICT (user_id) DO NOTHING`,
      [now, now]
    );
  }
}

async function listMissingNames(limit = 100) {
  const rows = await db.all(
    "SELECT user_id FROM line_users WHERE display_name IS NULL ORDER BY last_seen_at DESC LIMIT ?",
    [limit]
  );
  return rows.map((r) => r.user_id);
}

module.exports = { touch, setDisplayName, backfill, listMissingNames };
