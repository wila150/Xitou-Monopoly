// 後台網頁上傳的關卡圖片存在資料庫（bytea），不是網頁服務本機硬碟。
// Render 免費方案的網頁服務磁碟是暫時性的，重新部署或閒置關機喚醒都會清空本機檔案，
// 存資料庫才能保證小編上傳的照片不會無故消失。
const crypto = require("crypto");
const path = require("path");
const { db } = require("../db");

function generateFilename(prefix, originalName) {
  const ext = path.extname(originalName || "").toLowerCase() || ".jpg";
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_-]/g, "") || "img";
  return `${safePrefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`;
}

async function saveImage(buffer, mimeType, prefix, originalName) {
  const filename = generateFilename(prefix, originalName);
  await db.run(
    `INSERT INTO checkpoint_images (filename, mime_type, data, uploaded_at) VALUES (?, ?, ?, ?)`,
    [filename, mimeType, buffer, new Date().toISOString()]
  );
  return filename;
}

async function deleteImage(filename) {
  await db.run("DELETE FROM checkpoint_images WHERE filename = ?", [filename]);
}

async function getImage(filename) {
  return db.get("SELECT mime_type, data FROM checkpoint_images WHERE filename = ?", [filename]);
}

module.exports = { saveImage, deleteImage, getImage };
