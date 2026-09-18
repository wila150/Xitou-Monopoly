require("dotenv").config();

const path = require("path");
const express = require("express");

const lineClient = require("./lineClient");
const commandRouter = require("./handlers/commandRouter");
const teamService = require("./services/teamService");
const scheduler = require("./scheduler");
const db = require("./db");
const configStore = require("./config/configStore");
const imageStore = require("./config/imageStore");
const lineUserStore = require("./config/lineUserStore");
const mediaRetry = require("./mediaRetry");
const adminRouter = require("./admin/router");

const app = express();

teamService.setProfileResolver(lineClient.getDisplayName);

// 關卡圖片：/maps/A2.jpg ...
// 後台網頁上傳的圖片存在資料庫（見 imageStore.js），先查資料庫，查不到再 fallback
// 到 public/maps/ 底下隨 git 部署的原始示意圖／現場照片。
app.get("/maps/:filename", async (req, res, next) => {
  try {
    const image = await imageStore.getImage(req.params.filename);
    if (!image) return next();
    res.set("Content-Type", image.mime_type);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(image.data);
  } catch (err) {
    next(err);
  }
});
app.use("/maps", express.static(path.join(__dirname, "..", "public", "maps")));

app.get("/health", (req, res) => res.status(200).send("ok"));

// 目前部署的版本（Render 會自動帶入 RENDER_GIT_COMMIT），部署後可以用它確認新版是否已經上線
app.get("/version", (req, res) => {
  const commit = process.env.RENDER_GIT_COMMIT || "";
  res.json({ commit: commit.slice(0, 7) || null });
});

app.use("/admin", adminRouter);

app.post("/webhook", lineClient.webhookMiddleware, async (req, res) => {
  // 先回 200，避免 LINE 平台因處理耗時而重送 webhook
  res.status(200).end();

  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
});

// LINE 的 webhook 簽章驗證失敗（不是 LINE 送來的、或 channel secret 設錯）回 401，不要讓它變成 500 干擾錯誤監控
// eslint-disable-next-line no-unused-vars
app.use("/webhook", (err, req, res, next) => {
  if (err instanceof lineClient.SignatureValidationFailed || err instanceof lineClient.JSONParseError) {
    return res.status(401).send("invalid signature");
  }
  console.error("webhook 發生未預期錯誤：", err);
  res.status(500).end();
});

// 記下互動過的人（顯示名稱只在還沒有時才問 LINE），背景執行，失敗只記 log，不影響任何回覆
function recordLineUser(userId) {
  lineUserStore
    .touch(userId)
    .then(async (needsName) => {
      if (!needsName) return;
      const name = await lineClient.getDisplayName(userId);
      if (name) await lineUserStore.setDisplayName(userId, name);
    })
    .catch((err) => console.error("記錄 LINE 使用者失敗（不影響回覆）：", err.message || err));
}

// 啟動時把既有的隊伍成員／關主／總領隊補進名單，並在背景補齊缺的顯示名稱
async function backfillLineUsers() {
  await lineUserStore.backfill();
  for (const userId of await lineUserStore.listMissingNames()) {
    try {
      const name = await lineClient.getDisplayName(userId);
      if (name) await lineUserStore.setDisplayName(userId, name);
    } catch {
      // 查不到（例如對方已封鎖）就留空，之後對方傳訊息時會再補
    }
  }
}

// 加好友時的歡迎訊息：LINE 官方帳號後台內建的「加入好友歡迎訊息」功能請關閉（見 README），
// 統一由這裡的 webhook 發送，才會跟報到指令實際支援的格式（見 commandRouter.js 的 CHECKIN_RE）保持一致。
// 實際文字內容存在資料庫、可在後台網頁編輯（見 configStore.getWelcomeMessage／setWelcomeMessage）。
async function handleEvent(event) {
  try {
    if (event.source && event.source.userId) recordLineUser(event.source.userId);

    if (event.type === "follow") {
      console.log(`收到加入好友事件：userId=${event.source && event.source.userId}`);
      if (event.replyToken) {
        await lineClient.reply(event.replyToken, [
          teamService.textMsg(configStore.getWelcomeMessage()),
        ]);
        console.log("歡迎訊息已送出");
      }
      return;
    }

    if (event.type !== "message") return;

    const userId = event.source && event.source.userId;
    if (!userId) return;

    console.log(
      `收到訊息：userId=${userId} type=${event.message.type}` +
        (event.message.type === "text" ? ` text=${JSON.stringify(event.message.text)}` : "")
    );

    let result;
    if (event.message.type === "text") {
      result = await commandRouter.route(userId, event.message.text);
    } else if (event.message.type === "image" || event.message.type === "video") {
      // 無現場關主的 6 關：收到照片／影片先送審，通知小編，不會自動過關。
      // 順便把實際內容下載下來存進審核佇列，小編才能在後台網頁直接預覽，不用去 LINE 聊天記錄翻——
      // 下載失敗（例如太久沒處理、LINE 內容過期）不影響原本的文字通知流程，退回舊行為就好。
      let media = null;
      try {
        // 影片要等 LINE 轉檔完成才抓得到完整內容；抓到的東西會檢查大小與格式，不合格就丟錯（見 lineContent.js）
        media = await lineClient.getMessageContent(event.message.id, event.message.type);
      } catch (err) {
        console.error("下載使用者上傳的照片／影片內容失敗（會先存成等待下載，背景重試）：", err.message || err);
      }
      const { reply, adminNotify, pendingDownloadId } = await teamService.submitMedia(userId, media, {
        lineMessageId: event.message.id,
      });
      // 沒抓到內容的話（通常是影片還在轉檔），背景重試下載，抓到就補進後台預覽
      if (pendingDownloadId) mediaRetry.scheduleRetries(pendingDownloadId, lineClient.getMessageContent);
      result = { reply, groupBroadcasts: [], directPushes: adminNotify || [] };
    } else {
      return;
    }

    const { reply, groupBroadcasts, directPushes } = result;
    console.log(
      `處理結果：reply=${reply ? reply.length + "則" : "無"} groupBroadcasts=${groupBroadcasts.length} directPushes=${directPushes.length}`
    );
    const tasks = [];
    if (reply) tasks.push(lineClient.reply(event.replyToken, reply));
    for (const b of groupBroadcasts) {
      const recipientIds = await teamService.getGroupBroadcastRecipientIds(b.groupNo);
      tasks.push(lineClient.pushToMany(recipientIds, b.messages));
    }
    for (const p of directPushes) {
      tasks.push(lineClient.push(p.to, p.messages));
    }
    await Promise.all(tasks);
    console.log("回覆／推播已送出");
  } catch (err) {
    console.error("處理 LINE 事件時發生錯誤：", err);
    // 保底回覆：讓使用者知道系統出錯了，而不是完全沒有任何回應
    if (event.replyToken) {
      try {
        await lineClient.reply(event.replyToken, [
          teamService.textMsg("⚠️ 系統發生錯誤，請稍後再試一次，或聯繫小編處理。"),
        ]);
      } catch (replyErr) {
        console.error("連保底錯誤回覆都失敗：", replyErr);
      }
    }
  }
}

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => configStore.init())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`LINE 闖關系統伺服器已啟動，監聽埠 ${PORT}`);
      scheduler.start();
      mediaRetry
        .resumePending(lineClient.getMessageContent)
        .catch((err) => console.error("接續重試審核媒體下載失敗：", err));
      backfillLineUsers().catch((err) => console.error("補登 LINE 使用者名單失敗：", err));
    });
  })
  .catch((err) => {
    console.error("資料庫初始化失敗，伺服器無法啟動：", err);
    process.exit(1);
  });
