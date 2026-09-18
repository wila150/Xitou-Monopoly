// 沒有現場關主的關卡：隊伍上傳的照片／影片存在這裡（bytea），供後台網頁「照片／影片審核」分頁預覽。
// 影片可能很大，免費方案的 Postgres 容量有限，超過上限就不存，退回純文字通知＋LINE聊天記錄查看的舊方式。
const { db } = require("../db");

const MAX_STORED_BYTES = 15 * 1024 * 1024; // 15MB

async function saveSubmission({ groupNo, checkpointId, mediaType, mimeType, buffer, submittedBy }) {
  if (!buffer || buffer.length > MAX_STORED_BYTES) return false;
  await db.run(
    `INSERT INTO pending_submissions (group_no, checkpoint_id, media_type, mime_type, data, submitted_by, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [groupNo, checkpointId, mediaType, mimeType, buffer, submittedBy, new Date().toISOString()]
  );
  return true;
}

async function listPending() {
  return db.all(
    `SELECT id, group_no, checkpoint_id, media_type, submitted_by, submitted_at
     FROM pending_submissions ORDER BY submitted_at`
  );
}

async function getSubmissionMedia(id) {
  return db.get("SELECT mime_type, data FROM pending_submissions WHERE id = ?", [id]);
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
  getSubmissionMeta,
  deleteSubmission,
  deleteSubmissionsForGroup,
};
