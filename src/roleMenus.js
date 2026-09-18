// 個人專屬圖文選單：綁定成小隊／關主／總領隊（或是小編）之後，這個人聊天室下方的選單自動換成他身分專用的按鈕，
// 取消綁定就換回預設選單。LINE 的做法是「把某個圖文選單綁到某個使用者身上」，優先於預設選單。
// 選單本身（版型、圖片、名稱）由 scripts/setup-rich-menu.js 依 scripts/richmenus.json 建立到 LINE 帳號上；
// 這裡靠「選單名稱」找到它們的 ID（不需要把 ID 存資料庫，重新上傳選單後也會自己找到新的）。
const layout = require("../scripts/richmenus.json");

const MENU_NAME_BY_ROLE = Object.fromEntries(
  layout.menus.filter((m) => m.key !== "default").map((m) => [m.key, m.name])
);

const MENU_ID_TTL_MS = 5 * 60 * 1000; // 選單 ID 快取，重新上傳選單後最慢 5 分鐘內會自己更新

// client 需要 getRichMenuList／linkRichMenuIdToUser／unlinkRichMenuIdFromUser（即 LINE 的 MessagingApiClient）
function createRoleMenus(client, { now = Date.now } = {}) {
  let idsByName = null;
  let idsFetchedAt = 0;
  const linked = new Map(); // userId -> 這個人目前已套用的選單 ID（同一個人不重複呼叫 LINE）

  async function menuIdFor(role, { refresh = false } = {}) {
    const name = MENU_NAME_BY_ROLE[role];
    if (!name) return null;
    if (refresh || !idsByName || now() - idsFetchedAt > MENU_ID_TTL_MS) {
      const { richmenus } = await client.getRichMenuList();
      idsByName = new Map(richmenus.map((m) => [m.name, m.richMenuId]));
      idsFetchedAt = now();
    }
    return idsByName.get(name) || null;
  }

  // role: "team" | "referee" | "broadcaster" | "admin" | null（null＝換回預設選單）
  async function apply(userId, role) {
    if (!role) {
      linked.delete(userId);
      try {
        await client.unlinkRichMenuIdFromUser(userId);
      } catch (err) {
        // 這個人本來就沒有專屬選單、或已封鎖官方帳號：不用處理
        if (!/404|not found|blocked/i.test(String(err && (err.message || err.status)))) throw err;
      }
      return "unlinked";
    }
    let menuId = await menuIdFor(role);
    if (!menuId) return "menu-missing"; // 還沒執行 setup-rich-menu.js 上傳這個身分的選單
    if (linked.get(userId) === menuId) return "already";
    try {
      await client.linkRichMenuIdToUser(userId, menuId);
    } catch (err) {
      // 選單可能剛被重新上傳（ID 換了）：更新一次 ID 再試
      menuId = await menuIdFor(role, { refresh: true });
      if (!menuId) return "menu-missing";
      await client.linkRichMenuIdToUser(userId, menuId);
    }
    linked.set(userId, menuId);
    return "linked";
  }

  // 重新上傳選單後，強制重新查一次選單 ID
  async function refresh() {
    idsByName = null;
    linked.clear();
  }

  return { apply, refresh, menuIdFor, _linked: linked };
}

module.exports = { createRoleMenus, MENU_NAME_BY_ROLE };
