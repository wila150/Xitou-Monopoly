// 影片還在轉檔、第一次沒抓到內容時，背景重試下載，抓到就補進審核佇列（見 submissionStore.fillMedia）。
// 後台審核頁的「重試下載」按鈕、伺服器重啟後的接續重試也走這裡。
const submissionStore = require("./config/submissionStore");

// 第一次下載失敗之後的重試間隔：15 秒、45 秒、2 分、5 分、10 分，都沒成功就停，之後只能手動按「重試下載」
const RETRY_DELAYS_MS = [15000, 45000, 120000, 300000, 600000];

// 嘗試抓一次。download 是 (messageId, kind, opts) => Promise<{buffer, mimeType}>（實際是 lineClient.getMessageContent）。
// 回傳 status："filled" 已經有內容（含這次抓到）／"pending" 還沒好，可稍後再試／"gone" 這筆已經被處理掉／"failed" 內容不合格，不必再試
async function attemptDownload(submissionId, download, { maxWaitMs = 10000 } = {}) {
  const target = await submissionStore.getDownloadTarget(submissionId);
  if (!target) return { status: "gone" };
  if (!target.awaiting) return { status: "filled" };
  if (!target.line_message_id) return { status: "failed", error: "沒有 LINE 訊息 ID，無法重試" };

  const kind = target.media_type === "video" ? "video" : "image";
  let media;
  try {
    media = await download(target.line_message_id, kind, { maxWaitMs });
  } catch (err) {
    await submissionStore.recordDownloadFailure(submissionId, err.message || err);
    return { status: "pending", error: err.message || String(err) };
  }
  const ok = await submissionStore.fillMedia(submissionId, media);
  return ok ? { status: "filled" } : { status: "failed", error: "內容不合格（空的或超過 15MB）" };
}

// 排程重試：每次失敗就等下一個間隔再試；成功、被處理掉、內容不合格就停。計時器不擋程式結束。
function scheduleRetries(submissionId, download, { delays = RETRY_DELAYS_MS, maxWaitMs = 10000, onDone = () => {} } = {}) {
  let attempt = 0;
  const next = () => {
    if (attempt >= delays.length) return onDone({ status: "gave-up" });
    const timer = setTimeout(async () => {
      try {
        const result = await attemptDownload(submissionId, download, { maxWaitMs });
        if (result.status === "pending") return next();
        onDone(result);
      } catch (err) {
        console.error(`第 ${submissionId} 筆審核媒體重試下載時發生錯誤：`, err);
        next();
      }
    }, delays[attempt++]);
    if (timer.unref) timer.unref();
  };
  next();
}

// 伺服器啟動時，把還在等內容的紀錄接著重試
async function resumePending(download, options) {
  for (const id of await submissionStore.listAwaitingDownload()) scheduleRetries(id, download, options);
}

module.exports = { attemptDownload, scheduleRetries, resumePending, RETRY_DELAYS_MS };
