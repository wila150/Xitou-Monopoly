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

// 今天的 12:30（建議回報上限／自動結算時間點）
function getCutoffTimestamp(reference = new Date()) {
  const d = new Date(reference);
  d.setHours(event.cutoffHour, event.cutoffMinute, 0, 0);
  return d.toISOString();
}

function isLate(finishIso, reference = new Date()) {
  return new Date(finishIso).getTime() > new Date(getCutoffTimestamp(reference)).getTime();
}

module.exports = { nowIso, formatElapsed, elapsedSeconds, getCutoffTimestamp, isLate };
