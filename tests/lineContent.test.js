const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const { downloadContent, sniffMediaType } = require("../src/lineContent");

// 最小可辨識的檔案開頭（sniffMediaType 只看開頭幾個 byte）
const pad = (head) => Buffer.concat([head, Buffer.alloc(64)]);
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const MP4 = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom")]));
const MOV = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ")]));
const HEIC = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic")]));
const ERROR_JSON = Buffer.from('{"message":"content is not ready yet, please try again later"}');

// 假的 LINE blob client：statuses 依序回傳每次「準備狀態」查詢的結果
function fakeClient({ statuses = ["succeeded"], status = 200, body = MP4, contentLength = undefined } = {}) {
  const calls = { transcoding: 0, content: 0 };
  return {
    calls,
    async getMessageContentTranscodingByMessageId() {
      const s = statuses[Math.min(calls.transcoding, statuses.length - 1)];
      calls.transcoding++;
      return { status: s };
    },
    async getMessageContentWithHttpInfo() {
      calls.content++;
      const len = contentLength === undefined ? body.length : contentLength;
      return {
        httpResponse: { status, headers: { get: (name) => (name.toLowerCase() === "content-length" && len !== null ? String(len) : null) } },
        // 拆成兩段，確認有正確把多個 chunk 串起來
        body: Readable.from([body.subarray(0, 10), body.subarray(10)]),
      };
    },
  };
}
const fast = { maxWaitMs: 60, intervalMs: 5 };

test("辨識檔案格式：JPEG／PNG／GIF／WebP／HEIC、MP4／MOV／WebM，認不出來或太短回傳 null", () => {
  assert.equal(sniffMediaType(JPEG, "image"), "image/jpeg");
  assert.equal(sniffMediaType(PNG, "image"), "image/png");
  assert.equal(sniffMediaType(pad(Buffer.from("GIF89a")), "image"), "image/gif");
  assert.equal(sniffMediaType(pad(Buffer.concat([Buffer.from("RIFF...."), Buffer.from("WEBP")])), "image"), "image/webp");
  assert.equal(sniffMediaType(HEIC, "image"), "image/heic");
  assert.equal(sniffMediaType(MP4, "video"), "video/mp4");
  assert.equal(sniffMediaType(MOV, "video"), "video/quicktime");
  assert.equal(sniffMediaType(pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), "video"), "video/webm");
  // 錯誤訊息、空的、太短、把影片當照片都不能通過
  assert.equal(sniffMediaType(ERROR_JSON, "video"), null);
  assert.equal(sniffMediaType(ERROR_JSON, "image"), null);
  assert.equal(sniffMediaType(Buffer.alloc(0), "image"), null);
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8]), "image"), null);
  assert.equal(sniffMediaType(MP4, "image"), null);
});

test("影片：LINE 還在轉檔（processing）時會等，準備好（succeeded）才下載，回傳完整內容與格式", async () => {
  const client = fakeClient({ statuses: ["processing", "processing", "succeeded"] });
  const result = await downloadContent(client, "m1", "video", fast);
  assert.equal(result.mimeType, "video/mp4");
  assert.ok(result.buffer.equals(MP4), "多個 chunk 串起來的內容跟原檔一致");
  assert.equal(client.calls.transcoding, 3, "問了三次準備狀態");
  assert.equal(client.calls.content, 1, "準備好之前不會下載");
});

test("影片：轉檔失敗、等太久還沒準備好，都丟出說明原因的錯誤，而且不會去下載", async () => {
  const failed = fakeClient({ statuses: ["failed"] });
  await assert.rejects(downloadContent(failed, "m", "video", fast), /準備失敗/);
  assert.equal(failed.calls.content, 0);

  const stuck = fakeClient({ statuses: ["processing"] });
  await assert.rejects(downloadContent(stuck, "m", "video", fast), /還沒準備好/);
  assert.equal(stuck.calls.content, 0);
});

test("下載結果不合格一律丟錯（不存壞檔）：HTTP 202、空檔、大小不符、內容不是影片", async () => {
  await assert.rejects(downloadContent(fakeClient({ status: 202, body: Buffer.alloc(0) }), "m", "video", fast), /HTTP 202/);
  await assert.rejects(downloadContent(fakeClient({ body: Buffer.alloc(0) }), "m", "video", fast), /空的/);
  await assert.rejects(downloadContent(fakeClient({ contentLength: MP4.length + 500 }), "m", "video", fast), /不完整/);
  await assert.rejects(downloadContent(fakeClient({ body: ERROR_JSON }), "m", "video", fast), /不是有效的影片格式/);
  await assert.rejects(downloadContent(fakeClient({ body: ERROR_JSON }), "m", "image", fast), /不是有效的照片格式/);
});

test("照片：不需要等轉檔，直接下載並辨識格式；沒有 content-length 標頭也能通過", async () => {
  const jpeg = fakeClient({ body: JPEG });
  const result = await downloadContent(jpeg, "m", "image", fast);
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(jpeg.calls.transcoding, 0, "照片不查轉檔狀態");

  const png = await downloadContent(fakeClient({ body: PNG, contentLength: null }), "m", "image", fast);
  assert.equal(png.mimeType, "image/png");
});
