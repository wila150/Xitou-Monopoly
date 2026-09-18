// 依 scripts/richmenus.json 把所有圖文選單（預設＋小隊／關主／總領隊／小編專屬）上傳到 LINE，預設選單設成所有人的預設。
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

const LAYOUT = require("./richmenus.json");

const W = 2500;
const H = 1686;
const HEADER_H = 258; // (1686 - 258) / 3 = 476，三列高度才是整數（LINE 要求點擊區座標為整數）
const COL_W = W / 2; // 1250
const ROW_H = (H - HEADER_H) / 3; // 2 欄 x 3 列，每列 476

function areaFor(tile) {
  return {
    bounds: {
      x: tile.col * COL_W,
      y: HEADER_H + tile.row * ROW_H,
      width: COL_W * (tile.colspan || 1),
      height: ROW_H,
    },
    action: { type: "message", text: tile.text },
  };
}

function requestFor(menu) {
  return {
    size: { width: W, height: H },
    // 個人專屬選單套用時預設展開；預設選單也展開（跟先前行為一致）
    selected: true,
    name: menu.name,
    chatBarText: "選單",
    areas: menu.tiles.map(areaFor),
  };
}

async function main() {
  const missing = LAYOUT.menus.filter((m) => !fs.existsSync(path.join(__dirname, "..", "assets", m.image)));
  if (missing.length > 0) {
    console.error(`找不到圖片：${missing.map((m) => m.image).join("、")}，請先執行 python3 scripts/generate-richmenu.py`);
    process.exit(1);
  }

  console.log("清除既有的圖文選單（個人專屬選單的綁定也會一併解除，之後由伺服器自動重新套用）...");
  const existing = await client.getRichMenuList();
  for (const menu of existing.richmenus) {
    await client.deleteRichMenu(menu.richMenuId);
    console.log(`  已刪除舊選單 ${menu.richMenuId}（${menu.name}）`);
  }

  for (const menu of LAYOUT.menus) {
    console.log(`建立「${menu.name}」...`);
    const { richMenuId } = await client.createRichMenu(requestFor(menu));
    const imageBuffer = fs.readFileSync(path.join(__dirname, "..", "assets", menu.image));
    await blobClient.setRichMenuImage(richMenuId, new Blob([imageBuffer], { type: "image/png" }));
    console.log(`  已建立並上傳圖片 ${richMenuId}`);
    if (menu.key === "default") {
      await client.setDefaultRichMenu(richMenuId);
      console.log("  已設成所有使用者的預設選單");
    }
  }
  console.log(
    "完成！一般使用者看到預設選單；綁定成小隊／關主／總領隊／小編的人，伺服器會自動套用他們的專屬選單" +
      "（已綁定的人在他們下一次傳訊息時、或後台按「同步專屬選單」時會套用）。"
  );
}

main().catch((err) => {
  console.error("設定圖文選單失敗：", err);
  process.exit(1);
});
