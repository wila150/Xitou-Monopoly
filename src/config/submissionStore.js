// 沒有現場關主的關卡：隊伍上傳的照片／影片存在這裡（bytea），供後台網頁「照片／影片審核」分頁預覽。
// 影片可能很大，免費方案的 Postgres 容量有限，超過上限就不存，退回純文字通知＋LINE聊天記錄查看的舊方式。
const { db } = require("../db");

const MAX_STORED_BYTES = 15 * 1024 * 1024; // 15MB

// 兩種存法：①有內容（buffer）→ 直接存；②沒有內容但有 LINE 訊息 ID（下載失敗，通常是影片還在轉檔）→
// 先存一筆「等待下載」的紀錄（data 為 NULL），讓小編看得到、背景再重試。回傳新紀錄的 id，沒存回傳 null。
// 空檔、超過大小上限的都不存（退回純文字通知＋LINE聊天記錄查看的方式）。
async function saveSubmission({ groupNo, checkpointId, mediaType, mimeType, buffer, submittedBy, lineMessageId = null }) {
  const hasBuffer = !!buffer;
  if (hasBuffer && (buffer.length === 0 || buffer.length > MAX_STORED_BYTES)) return null;
  if (!hasBuffer && !lineMessageId) return null;
  const row = await db.get(
    `INSERT INTO pending_submissions
       (group_no, checkpoint_id, media_type, mime_type, data, submitted_by, submitted_at, line_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [groupNo, checkpointId, mediaType, mimeType, hasBuffer ? buffer : null, submittedBy, new Date().toISOString(), lineMessageId]
  );
  return row.id;
}

async function listPending() {
  return db.all(
    `SELECT id, group_no, checkpoint_id, media_type, submitted_by, submitted_at,
            (data IS NOT NULL) AS has_data, download_error, download_attempts
     FROM pending_submissions ORDER BY submitted_at`
  );
}

async function getSubmissionMedia(id) {
  return db.get("SELECT mime_type, data FROM pending_submissions WHERE id = ?", [id]);
}

// 背景重試用：這筆是否還在等內容、要抓哪個 LINE 訊息、是照片還是影片
async function getDownloadTarget(id) {
  const row = await db.get(
    "SELECT line_message_id, media_type, (data IS NULL) AS awaiting FROM pending_submissions WHERE id = ?",
    [id]
  );
  return row || null;
}

// 抓到內容後補進去。只補還沒有內容的（避免重複覆蓋），內容不合格（空的或太大）回傳 false 並記下原因。
async function fillMedia(id, { buffer, mimeType }) {
  if (!buffer || buffer.length === 0 || buffer.length > MAX_STORED_BYTES) {
    await recordDownloadFailure(id, buffer && buffer.length > MAX_STORED_BYTES ? "檔案超過 15MB，無法存進後台" : "下載到的內容是空的");
    return false;
  }
  await db.run(
    "UPDATE pending_submissions SET data = ?, mime_type = ?, download_error = NULL WHERE id = ? AND data IS NULL",
    [buffer, mimeType, id]
  );
  return true;
}

async function recordDownloadFailure(id, message) {
  await db.run(
    "UPDATE pending_submissions SET download_error = ?, download_attempts = download_attempts + 1 WHERE id = ?",
    [String(message).slice(0, 300), id]
  );
}

// 伺服器重啟後要接著重試的（最近 24 小時內、還沒抓到內容的）
async function listAwaitingDownload() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.all(
    `SELECT id FROM pending_submissions
     WHERE data IS NULL AND line_message_id IS NOT NULL AND submitted_at > ? ORDER BY id`,
    [since]
  );
  return rows.map((r) => r.id);
}

async function getSubmissionMeta(id) {
  return db.get("SELECT group_no, checkpoint_id FROM pending_submissions WHERE id = ?", [id]);
}

async function deleteSubmission(id) {
  await db.run("DELETE FROM pending_submissions WHERE id = ?", [id]);
}

// 該組通過任何關卡後（不論是走 LINE 指令還是後台網頁按鈕），
// 之前留下的待審核紀錄都失去意義，一併清掉，避免佇列裡堆積已經處理過的舊照片。
async function deleteSubmissionsForGroup(groupNo) {
  await db.run("DELETE FROM pending_submissions WHERE group_no = ?", [groupNo]);
}

module.exports = {
  saveSubmission,
  listPending,
  getSubmissionMedia,
  getDownloadTarget,
  fillMedia,
  recordDownloadFailure,
  listAwaitingDownload,
  getSubmissionMeta,
  deleteSubmission,
  deleteSubmissionsForGroup,
};
