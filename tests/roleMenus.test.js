// 個人專屬圖文選單：綁定身分後自動換選單，取消綁定換回預設。
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://localhost/line_checkpoint_test";
process.env.PGSSL = "false";
process.env.PUBLIC_BASE_URL = "https://example.com";
process.env.ADMIN_USER_IDS = "Uadmin";

const dbModule = require("../src/db");
const configStore = require("../src/config/configStore");
const commandRouter = require("../src/handlers/commandRouter");
const teamService = require("../src/services/teamService");
const { createRoleMenus, MENU_NAME_BY_ROLE } = require("../src/roleMenus");
const layout = require("../scripts/richmenus.json");

test.before(async () => {
  await dbModule.init();
  await configStore.init();
});
test.after(async () => {
  teamService.setRoleMenuHook(null);
  await dbModule.pool.end();
});

const ADMIN = "Uadmin";
const wait = () => new Promise((resolve) => setTimeout(resolve, 30)); // 同步是背景執行，稍等它跑完

// 假的 LINE client：記錄所有呼叫；menus 是帳號上目前的選單清單
function fakeClient(menus) {
  const calls = [];
  return {
    calls,
    menus,
    async getRichMenuList() {
      calls.push(["list"]);
      return { richmenus: this.menus };
    },
    async linkRichMenuIdToUser(userId, menuId) {
      calls.push(["link", userId, menuId]);
      if (this.failLinkFor && this.failLinkFor.has(menuId)) throw new Error("404 richmenu not found");
    },
    async unlinkRichMenuIdFromUser(userId) {
      calls.push(["unlink", userId]);
      if (this.failUnlink) throw new Error(this.failUnlink);
    },
  };
}
const allMenus = () =>
  layout.menus.map((m) => ({ name: m.name, richMenuId: `rm-${m.key}` }));

test("版型設定：每種身分都有專屬選單，點擊文字都是機器人看得懂的指令，格數與座標合法", () => {
  const keys = layout.menus.map((m) => m.key);
  assert.deepEqual(keys.sort(), ["admin", "broadcaster", "default", "referee", "team"]);
  assert.deepEqual(Object.keys(MENU_NAME_BY_ROLE).sort(), ["admin", "broadcaster", "referee", "team"]);
  const names = layout.menus.map((m) => m.name);
  assert.equal(new Set(names).size, names.length, "選單名稱不能重複（程式靠名稱找選單）");
  for (const m of layout.menus) {
    const cells = new Set();
    for (const t of m.tiles) {
      assert.ok(t.text && t.label, `${m.key} 每格都要有文字與標籤`);
      for (let c = t.col; c < t.col + (t.colspan || 1); c++) {
        const cell = `${t.row},${c}`;
        assert.ok(!cells.has(cell), `${m.key} 的格子 ${cell} 重疊`);
        cells.add(cell);
      }
      assert.ok(t.col + (t.colspan || 1) <= 2 && t.row <= 2, `${m.key} 超出 2x3 版面`);
    }
  }
  // 「總領隊選單」的推播按鈕送出的字，剛好是機器人「推播 對象」指令
  const bc = layout.menus.find((m) => m.key === "broadcaster").tiles.map((t) => t.text);
  assert.deepEqual(bc.filter((t) => t.startsWith("推播")), ["推播 隊長", "推播 關主", "推播 所有人"]);
  // 小隊選單沒有「報到」（已經報到了）
  assert.ok(!layout.menus.find((m) => m.key === "team").tiles.some((t) => t.text === "報到"));
});

test("套用選單：依身分找到對應選單並綁定；同一個人不重複呼叫；換回預設就解除綁定", async () => {
  const client = fakeClient(allMenus());
  const menus = createRoleMenus(client);

  assert.equal(await menus.apply("U1", "broadcaster"), "linked");
  assert.deepEqual(client.calls.filter((c) => c[0] === "link"), [["link", "U1", "rm-broadcaster"]]);
  assert.equal(await menus.apply("U1", "broadcaster"), "already", "已經套用就不再打 LINE");
  assert.equal(client.calls.filter((c) => c[0] === "link").length, 1);
  assert.equal(client.calls.filter((c) => c[0] === "list").length, 1, "選單清單有快取");

  // 身分換了（總領隊 → 關主）：改綁關主選單
  assert.equal(await menus.apply("U1", "referee"), "linked");
  assert.deepEqual(client.calls.at(-1), ["link", "U1", "rm-referee"]);

  // 取消身分：解除綁定（換回預設）；再套用會重新綁
  assert.equal(await menus.apply("U1", null), "unlinked");
  assert.deepEqual(client.calls.at(-1), ["unlink", "U1"]);
  assert.equal(await menus.apply("U1", "referee"), "linked");
});

test("套用選單：選單還沒上傳不會壞；選單被重新上傳（ID 換了）會重查後重試；解除綁定遇到「本來就沒有」不報錯", async () => {
  // 帳號上還沒有任何選單
  const empty = createRoleMenus(fakeClient([]));
  assert.equal(await empty.apply("U1", "referee"), "menu-missing");

  // 快取的舊 ID 已失效：第一次綁定失敗 → 重新查清單拿到新 ID → 成功
  const client = fakeClient(allMenus());
  const menus = createRoleMenus(client);
  await menus.apply("Uwarm", "referee"); // 先讓快取記住舊 ID
  client.menus = layout.menus.map((m) => ({ name: m.name, richMenuId: `NEW-${m.key}` }));
  client.failLinkFor = new Set(["rm-referee"]);
  assert.equal(await menus.apply("U2", "referee"), "linked");
  assert.deepEqual(client.calls.at(-1), ["link", "U2", "NEW-referee"]);

  // 解除綁定：對方本來就沒有專屬選單（LINE 回 404）→ 視為成功；其他錯誤才丟出
  client.failUnlink = "404 not found";
  assert.equal(await menus.apply("U3", null), "unlinked");
  client.failUnlink = "500 server error";
  await assert.rejects(menus.apply("U3", null), /500/);
});

test("身分判斷：小編 > 總領隊 > 關主 > 小隊 > 預設", async () => {
  await commandRouter.route(ADMIN, "重置遊戲 確認");
  await teamService.resetReferees();
  await teamService.resetBroadcasters();
  assert.equal(await teamService.menuRoleOf("Ustranger"), null);
  await commandRouter.route("Uleader", "報到 1組");
  assert.equal(await teamService.menuRoleOf("Uleader"), "team");
  await commandRouter.route("Uref", "我是 B3 關主");
  assert.equal(await teamService.menuRoleOf("Uref"), "referee");
  await commandRouter.route("Uref", "總領綁定");
  assert.equal(await teamService.menuRoleOf("Uref"), "broadcaster", "同時是關主與總領隊 → 總領隊選單");
  assert.equal(await teamService.menuRoleOf(ADMIN), "admin");
  await teamService.resetReferees();
  await teamService.resetBroadcasters();
});

test("身分改變時會通知換選單：報到、綁定與取消關主／總領隊、解除綁定、重置；失敗的操作不會動選單；掛鉤壞掉不影響指令", async () => {
  await commandRouter.route(ADMIN, "重置遊戲 確認");
  await teamService.resetReferees();
  await teamService.resetBroadcasters();
  const events = [];
  teamService.setRoleMenuHook(async (userId, role) => {
    events.push([userId, role]);
  });
  const last = () => events.at(-1);
  const settle = async () => {
    await wait();
  };

  // 報到 → 小隊選單；重複報到、報到不存在的組別不會多換
  await commandRouter.route("Ul1", "報到 1組");
  await settle();
  assert.deepEqual(last(), ["Ul1", "team"]);
  const before = events.length;
  await commandRouter.route("Ustranger", "報到 99組");
  await settle();
  assert.equal(events.length, before, "報到失敗不動選單");

  // 自助登記關主／總領隊
  await commandRouter.route("Uref", "我是 B3 關主");
  await settle();
  assert.deepEqual(last(), ["Uref", "referee"]);
  await commandRouter.route("Uboss", "總領綁定");
  await settle();
  assert.deepEqual(last(), ["Uboss", "broadcaster"]);

  // 已在隊伍裡的人登記失敗 → 不換選單
  const n = events.length;
  await commandRouter.route("Ul1", "我是 B3 關主");
  await settle();
  assert.equal(events.length, n);

  // 小編用指令指定／取消（含後台用的同一組函式）
  await teamService.assignReferee("Ustaff", "B4");
  await settle();
  assert.deepEqual(last(), ["Ustaff", "referee"]);
  await teamService.removeReferee("Ustaff");
  await settle();
  assert.deepEqual(last(), ["Ustaff", null], "取消關主 → 換回預設");
  await teamService.assignBroadcaster("Ustaff2");
  await teamService.removeBroadcaster("Ustaff2");
  await settle();
  assert.deepEqual(last(), ["Ustaff2", null]);

  // 解除綁定：整組成員換回預設；重置關主：所有關主換回預設；重置遊戲：所有隊伍成員換回預設
  await commandRouter.route("Um1", "報到 1組");
  await settle();
  events.length = 0;
  await commandRouter.route(ADMIN, "解除綁定 1組");
  await settle();
  assert.deepEqual(events.map((e) => e[0]).sort(), ["Ul1", "Um1"]);
  assert.ok(events.every((e) => e[1] === null));

  events.length = 0;
  await commandRouter.route(ADMIN, "重置關主");
  await settle();
  assert.deepEqual(events, [["Uref", null]]);

  await commandRouter.route("Ul2", "報到 2組");
  await settle();
  events.length = 0;
  await commandRouter.route(ADMIN, "重置遊戲 確認");
  await settle();
  assert.deepEqual(events, [["Ul2", null]]);

  // 掛鉤丟錯：指令照常回覆，不會壞
  teamService.setRoleMenuHook(async () => {
    throw new Error("LINE 掛了");
  });
  const r = await commandRouter.route("Ul3", "報到 3組");
  assert.match(r.reply[0].text, /報到成功/);
  await settle();

  // 全部同步：隊伍成員、關主、總領隊、小編都會確認一次
  teamService.setRoleMenuHook(Object.assign(async (userId, role) => events.push([userId, role]), { refresh: async () => events.push("refreshed") }));
  events.length = 0;
  const count = await teamService.syncAllRoleMenus();
  assert.equal(events[0], "refreshed");
  assert.ok(count >= 3);
  assert.ok(events.some((e) => e[0] === ADMIN && e[1] === "admin"));
  assert.ok(events.some((e) => e[0] === "Ul3" && e[1] === "team"));
  teamService.setRoleMenuHook(null);
});

test("總領隊綁定成功的訊息底下附推播按鈕", async () => {
  await teamService.resetBroadcasters();
  const r = await commandRouter.route("Uboss2", "總領綁定");
  const help = r.reply.find((m) => m.quickReply);
  assert.deepEqual(help.quickReply.items.map((i) => i.action.text), ["推播 隊長", "推播 關主", "推播 所有人"]);
  // 按鈕送出的字：進入「輸入內容」的下一步（再點確認送出才會發）
  const tap = await commandRouter.route("Uboss2", "推播 隊長");
  assert.match(tap.reply[0].text, /請輸入要推播給「小隊長」的訊息內容/);
  await commandRouter.route("Uboss2", "取消");
  await teamService.resetBroadcasters();
});
