require("dotenv").config();

const path = require("path");
const express = require("express");

const lineClient = require("./lineClient");
const commandRouter = require("./handlers/commandRouter");
const teamService = require("./services/teamService");
const scheduler = require("./scheduler");
const db = require("./db");
const configStore = require("./config/configStore");
const adminRouter = require("./admin/router");

const app = express();

// 關卡地圖圖片：/maps/A2.png ...
app.use("/maps", express.static(path.join(__dirname, "..", "public", "maps")));

app.get("/health", (req, res) => res.status(200).send("ok"));

app.use("/admin", adminRouter);

app.post("/webhook", lineClient.webhookMiddleware, async (req, res) => {
  // 先回 200，避免 LINE 平台因處理耗時而重送 webhook
  res.status(200).end();

  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
});

async function handleEvent(event) {
  try {
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
