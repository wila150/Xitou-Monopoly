// 下載使用者傳來的照片／影片內容（給後台審核佇列預覽用），並檢查下載到的東西真的能用。
//
// 影片跟照片不一樣：LINE 收到影片後還要轉檔，剛收到訊息時內容可能還沒準備好，這時候抓到的會是空檔或不完整的檔案
// （HTTP 202、或 200 但內容不完整）。所以影片要先問「準備狀態」（processing／succeeded／failed），
// 等到 succeeded 才下載；下載後再檢查狀態碼、大小、檔案開頭的格式，任何一項不對就當作失敗（丟出錯誤，呼叫端不存），
// 不要把壞掉的檔案存進資料庫，後台才不會出現一張放不出來的卡片。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 用檔案開頭幾個 byte 判斷實際格式，回傳 mime type；認不出來回傳 null（例如下載到的其實是錯誤訊息）
function sniffMediaType(buffer, kind) {
  if (!buffer || buffer.length < 12) return null;
  const startsWith = (...bytes) => bytes.every((b, i) => buffer[i] === b);
  const ascii = (from, to) => buffer.toString("latin1", from, to);

  if (kind === "image") {
    if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
    if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png";
    if (ascii(0, 4) === "GIF8") return "image/gif";
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    if (ascii(4, 8) === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(ascii(8, 12))) {
      return "image/heic"; // iPhone 原始格式，Safari 以外的瀏覽器通常不能顯示，後台會提供下載連結
    }
    return null;
  }
  // video
  if (ascii(4, 8) === "ftyp") return ascii(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  return null;
}

// 影片等到「準備好」才下載。maxWaitMs 內都還在處理中就放棄（呼叫端會退回文字通知）。
async function waitUntilReady(blobClient, messageId, { maxWaitMs, intervalMs }) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const { status } = await blobClient.getMessageContentTranscodingByMessageId(messageId);
    if (status === "succeeded") return;
    if (status === "failed") throw new Error("LINE 回報影片內容準備失敗（transcoding failed）");
    if (Date.now() + intervalMs > deadline) throw new Error(`影片內容在 ${maxWaitMs / 1000} 秒內還沒準備好（status=${status}）`);
    await sleep(intervalMs);
  }
}

// kind: "image" | "video"。成功回傳 { buffer, mimeType }，失敗丟出說明原因的錯誤。
async function downloadContent(blobClient, messageId, kind, { maxWaitMs = 25000, intervalMs = 1500 } = {}) {
  if (kind === "video") {
    await waitUntilReady(blobClient, messageId, { maxWaitMs, intervalMs });
  }
  const { httpResponse, body } = await blobClient.getMessageContentWithHttpInfo(messageId);
  if (httpResponse.status !== 200) {
    throw new Error(`LINE 內容還沒準備好或無法下載（HTTP ${httpResponse.status}）`);
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) throw new Error("下載到的內容是空的");

  const declared = Number(httpResponse.headers.get("content-length"));
  if (declared && declared !== buffer.length) {
    throw new Error(`下載內容不完整（應為 ${declared} bytes，實際 ${buffer.length} bytes）`);
  }
  const mimeType = sniffMediaType(buffer, kind);
  if (!mimeType) throw new Error(`下載到的內容不是有效的${kind === "video" ? "影片" : "照片"}格式`);
  return { buffer, mimeType };
}

module.exports = { downloadContent, sniffMediaType };
