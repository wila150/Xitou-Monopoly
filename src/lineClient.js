const line = require("@line/bot-sdk");
const { downloadContent } = require("./lineContent");

const messagingApiConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const middlewareConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient(messagingApiConfig);
const blobClient = new line.messagingApi.MessagingApiBlobClient(messagingApiConfig);
const webhookMiddleware = line.middleware(middlewareConfig);

// 下載使用者傳來的照片／影片內容（給審核佇列存進資料庫用），回傳 { buffer, mimeType }。
// 影片會先等 LINE 轉檔完成、下載後檢查完整性與格式，細節見 lineContent.js。
function getMessageContent(messageId, kind, options) {
  return downloadContent(blobClient, messageId, kind, options);
}

// 查使用者的 LINE 顯示名稱（緊急聯絡通知小編時附上，比一串 userId 好認）
async function getDisplayName(userId) {
  const profile = await client.getProfile(userId);
  return profile.displayName;
}

// LINE 一次 reply/push 最多 5 則訊息
function chunk(messages, size = 5) {
  const out = [];
  for (let i = 0; i < messages.length; i += size) {
    out.push(messages.slice(i, i + size));
  }
  return out;
}

async function reply(replyToken, messages) {
  if (!messages || messages.length === 0) return;
  const [first, ...rest] = chunk(messages);
  await client.replyMessage({ replyToken, messages: first });
  for (const batch of rest) {
    // reply token 只能用一次，超過 5 則訊息的部分改用一般訊息無法補送，僅記錄警告
    console.warn(
      `訊息超過單次可回覆上限，以下 ${batch.length} 則訊息未送出：`,
      batch
    );
  }
}

async function push(userId, messages) {
  if (!messages || messages.length === 0) return;
  for (const batch of chunk(messages)) {
    await client.pushMessage({ to: userId, messages: batch });
  }
}

async function pushToMany(userIds, messages) {
  await Promise.all(userIds.map((userId) => push(userId, messages)));
}

module.exports = {
  client,
  webhookMiddleware,
  reply,
  push,
  pushToMany,
  getMessageContent,
  getDisplayName,
  SignatureValidationFailed: line.SignatureValidationFailed,
  JSONParseError: line.JSONParseError,
};
