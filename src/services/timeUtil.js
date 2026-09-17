const event = require("../config/event");

function nowIso() {
  return new Date().toISOString();
}

// 對應架構文件「八、耗時計算方式」：格式統一為 時:分:秒
function formatElapsed(startIso, endIso) {
  if (!startIso) return "尚未出發";
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso || nowIso()).getTime();
  const totalSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function elapsedSeconds(startIso, endIso) {
  if (!startIso) return Infinity;
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso || nowIso()).getTime();
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

// 準時／逾時：看該組「出發」到「終點確認」經過多久，不是比對固定時刻，
// 超過 event.maxDurationMinutes（預設 2 小時）就算逾時
function isLate(startIso, finishIso) {
  if (!startIso) return false;
  const elapsedMs = new Date(finishIso).getTime() - new Date(startIso).getTime();
  return elapsedMs > event.maxDurationMinutes * 60 * 1000;
}

module.exports = { nowIso, formatElapsed, elapsedSeconds, isLate };
