// 把 assets/richmenu.png 上傳到 LINE、建立圖文選單並設成所有人的預設選單。
// 用法：
//   LINE_CHANNEL_ACCESS_TOKEN=xxx node scripts/setup-rich-menu.js
// 重複執行是安全的：會先刪除帳號上所有既有的圖文選單，再建立新的一份，不會累積殘留。
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const line = require("@line/bot-sdk");

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error("缺少 LINE_CHANNEL_ACCESS_TOKEN 環境變數。");
  process.exit(1);
}

const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: token });
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: token });

const IMAGE_PATH = path.join(__dirname, "..", "assets", "richmenu.png");

const W = 2500;
const H = 1686;
const HEADER_H = 260;
const COL_W = W / 2; // 1250
const ROW_H = (H - HEADER_H) / 2; // 713

function messageArea(x, y, w, h, text) {
  return { bounds: { x, y, width: w, height: h }, action: { type: "message", text } };
}

const richMenuRequest = {
  size: { width: W, height: H },
  selected: true,
  name: "溪頭闖關系統選單",
  chatBarText: "選單",
  areas: [
    messageArea(0, HEADER_H, COL_W, ROW_H, "目前關卡"),
    messageArea(COL_W, HEADER_H, COL_W, ROW_H, "闖關進度"),
    messageArea(0, HEADER_H + ROW_H, COL_W, ROW_H, "排行榜"),
    messageArea(COL_W, HEADER_H + ROW_H, COL_W, ROW_H, "報到"),
  ],
};

async function main() {
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`找不到 ${IMAGE_PATH}，請先執行 python3 scripts/generate-richmenu.py`);
    process.exit(1);
  }

  console.log("清除既有的圖文選單...");
  const existing = await client.getRichMenuList();
  for (const menu of existing.richmenus) {
    await client.deleteRichMenu(menu.richMenuId);
    console.log(`  已刪除舊選單 ${menu.richMenuId}（${menu.name}）`);
  }

  console.log("建立新的圖文選單...");
  const { richMenuId } = await client.createRichMenu(richMenuRequest);
  console.log(`  已建立 ${richMenuId}`);

  console.log("上傳選單圖片...");
  const imageBuffer = fs.readFileSync(IMAGE_PATH);
  const blob = new Blob([imageBuffer], { type: "image/png" });
  await blobClient.setRichMenuImage(richMenuId, blob);
  console.log("  上傳完成");

  console.log("設成所有使用者的預設選單...");
  await client.setDefaultRichMenu(richMenuId);
  console.log("完成！所有加好友的使用者現在都會看到這個圖文選單。");
}

main().catch((err) => {
  console.error("設定圖文選單失敗：", err);
  process.exit(1);
});
