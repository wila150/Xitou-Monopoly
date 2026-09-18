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
const adminRouter = require("./admin/router");

const app = express();

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

app.use("/admin", adminRouter);

app.post("/webhook", lineClient.webhookMiddleware, async (req, res) => {
  // 先回 200，避免 LINE 平台因處理耗時而重送 webhook
  res.status(200).end();

  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
});

// 加好友時的歡迎訊息：LINE 官方帳號後台內建的「加入好友歡迎訊息」功能請關閉（見 README），
// 統一由這裡的 webhook 發送，才會跟報到指令實際支援的格式（見 commandRouter.js 的 CHECKIN_RE）保持一致。
const WELCOME_MESSAGE =
  "感謝您將本帳號設為好友！🌲\n\n" +
  "【森呼吸．永續漫遊｜溪頭闖關系統】\n\n" +
  "請小隊長輸入您的組別編號完成報到（例如：1組、第一組）\n" +
  "完成報到後，請在集合地點等待關主宣布出發。\n\n" +
  "出發後，跟著系統指示前往每一關：\n" +
  "📍 有關主的關卡：請關主告知關鍵字後輸入\n" +
  "📸 沒有關主的關卡：直接拍照／錄影上傳即可過關\n\n" +
  "⏰ 活動不要求跑完全部關卡，可依時間自行決定何時折返\n" +
  "🏁 但請注意：一定要實際回到 B6 終點完成確認，系統才會停止計時！\n\n" +
  "點擊下方選單，可隨時查詢目前關卡、闖關進度、排行榜。";

async function handleEvent(event) {
  try {
    if (event.type === "follow") {
      if (event.replyToken) {
        await lineClient.reply(event.replyToken, [teamService.textMsg(WELCOME_MESSAGE)]);
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
      // 無現場關主的 6 關：收到照片／影片先送審，通知小編，不會自動過關
      const { reply, adminNotify } = await teamService.submitMedia(userId);
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
      const memberIds = await teamService.getGroupMemberIds(b.groupNo);
      tasks.push(lineClient.pushToMany(memberIds, b.messages));
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
    });
  })
  .catch((err) => {
    console.error("資料庫初始化失敗，伺服器無法啟動：", err);
    process.exit(1);
  });
