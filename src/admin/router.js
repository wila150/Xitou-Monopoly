// 後台網頁：登入、關卡與路線設定的 CRUD、即時進度、關主名單。
// 掛在 src/index.js 的 app.use("/admin", adminRouter)。
const path = require("path");
const express = require("express");
const multer = require("multer");

const auth = require("./auth");
const configStore = require("../config/configStore");
const imageStore = require("../config/imageStore");
const submissionStore = require("../config/submissionStore");
const teamService = require("../services/teamService");
const lineClient = require("../lineClient");

const router = express.Router();
const PUBLIC_ADMIN_DIR = path.join(__dirname, "..", "..", "public", "admin");

const VALID_VERIFY_TYPES = ["keyword", "photo", "video", "referee"];
const IMAGE_CATEGORIES = { "site-photos": "sitePhotos", "map-images": "mapImages" };

router.use(express.json());

// ---- 登入／登出（不需要先登入）----

router.post("/api/login", (req, res) => {
  const expected = process.env.ADMIN_PANEL_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: "後台尚未設定 ADMIN_PANEL_PASSWORD，無法登入。" });
  }
  const { password } = req.body || {};
  if (typeof password !== "string" || password !== expected) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  res.setHeader("Set-Cookie", auth.createSessionCookie());
  res.json({ ok: true });
});

router.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", auth.clearSessionCookie());
  res.json({ ok: true });
});

// ---- 以下都需要登入 ----

router.use(auth.requireAuth);

router.get("/login", (req, res) => {
  res.sendFile(path.join(PUBLIC_ADMIN_DIR, "login.html"));
});

router.use(express.static(PUBLIC_ADMIN_DIR));

// 上傳的圖片先進記憶體，再由 imageStore 存進資料庫（bytea），不落地寫本機硬碟——
// Render 免費方案的網頁服務磁碟是暫時性的，寫本機檔案的話重新部署／閒置喚醒就會消失。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error("只能上傳圖片檔"));
    cb(null, true);
  },
});

// ---- 關卡設定 ----

router.get("/api/checkpoints", (req, res) => {
  res.json(configStore.getAllCheckpoints());
});

router.put("/api/checkpoints/:id", async (req, res, next) => {
  try {
    const { name, location, content, scoringMethod, verifyType, sortOrder } = req.body || {};
    if (!name || !location || !content || !scoringMethod || !verifyType) {
      return res
        .status(400)
        .json({ error: "name / location / content / scoringMethod / verifyType 都是必填" });
    }
    if (!VALID_VERIFY_TYPES.includes(verifyType)) {
      return res.status(400).json({ error: "verifyType 必須是 keyword / photo / video / referee" });
    }
    const id = req.params.id;
    if (configStore.hasCheckpoint(id)) {
      // 只改一般欄位，不動 site_photos／map_images，避免跟同時發生的圖片上傳／刪除互相蓋掉
      await configStore.updateCheckpointFields({
        id,
        name,
        location,
        content,
        scoringMethod,
        verifyType,
        sortOrder,
      });
    } else {
      await configStore.upsertCheckpoint({
        id,
        name,
        location,
        content,
        scoringMethod,
        verifyType,
        sitePhotos: [],
        mapImages: [],
        sortOrder,
      });
    }
    res.json({ ok: true, checkpoint: configStore.getCheckpoint(id) });
  } catch (err) {
    next(err);
  }
});

router.delete("/api/checkpoints/:id", async (req, res, next) => {
  try {
    await configStore.deleteCheckpoint(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// category 是 "site-photos" 或 "map-images"，見上面的 IMAGE_CATEGORIES 對照表
// （Express 5 的路由不支援 :param(regex) 這種自訂樣式了，改成收 :category 後手動檢查）
router.post("/api/checkpoints/:id/:category", upload.single("image"), async (req, res, next) => {
  try {
    const field = IMAGE_CATEGORIES[req.params.category];
    if (!field) {
      return res.status(404).json({ error: "找不到這個路徑" });
    }
    if (!configStore.hasCheckpoint(req.params.id)) {
      return res.status(404).json({ error: "找不到這個關卡代號，請先建立關卡再上傳圖片" });
    }
    if (!req.file) return res.status(400).json({ error: "沒有收到圖片檔" });
    const filename = await imageStore.saveImage(
      req.file.buffer,
      req.file.mimetype,
      `${req.params.id}-${req.params.category}`,
      req.file.originalname
    );
    await configStore.appendCheckpointImage(req.params.id, field, filename);
    res.json({ ok: true, checkpoint: configStore.getCheckpoint(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.delete("/api/checkpoints/:id/:category/:filename", async (req, res, next) => {
  try {
    const field = IMAGE_CATEGORIES[req.params.category];
    if (!field) {
      return res.status(404).json({ error: "找不到這個路徑" });
    }
    await configStore.removeCheckpointImage(req.params.id, field, req.params.filename);
    await imageStore.deleteImage(req.params.filename);
    res.json({ ok: true, checkpoint: configStore.getCheckpoint(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// ---- 組別路線設定 ----

router.get("/api/routes", (req, res) => {
  const groupNos = configStore.getAllGroupNos();
  const routes = {};
  for (const g of groupNos) routes[g] = configStore.getRoute(g);
  res.json({ routes, checkpointIds: configStore.getAllCheckpoints().map((c) => c.id) });
});

router.put("/api/routes/:groupNo", async (req, res, next) => {
  try {
    const groupNo = Number(req.params.groupNo);
    if (!Number.isInteger(groupNo) || groupNo <= 0) {
      return res.status(400).json({ error: "組別編號必須是正整數" });
    }
    await configStore.setTeamRoute(groupNo, (req.body || {}).route);
    res.json({ ok: true, route: configStore.getRoute(groupNo) });
  } catch (err) {
    next(err);
  }
});

router.delete("/api/routes/:groupNo", async (req, res, next) => {
  try {
    await configStore.deleteTeamRoute(Number(req.params.groupNo));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- 即時進度／關主名單 ----

router.get("/api/progress", async (req, res, next) => {
  try {
    res.json(await teamService.getProgressSnapshot());
  } catch (err) {
    next(err);
  }
});

router.get("/api/referees", async (req, res, next) => {
  try {
    res.json(await teamService.listReferees());
  } catch (err) {
    next(err);
  }
});

router.get("/api/team-leaders", async (req, res, next) => {
  try {
    res.json(await teamService.listTeamLeaders());
  } catch (err) {
    next(err);
  }
});

router.get("/api/broadcasters", async (req, res, next) => {
  try {
    res.json(await teamService.listBroadcasters());
  } catch (err) {
    next(err);
  }
});

router.get("/api/bonus-log", async (req, res, next) => {
  try {
    res.json(await teamService.listBonusLog());
  } catch (err) {
    next(err);
  }
});

// ---- 照片／影片審核佇列 ----

router.get("/api/submissions", async (req, res, next) => {
  try {
    res.json(await teamService.listPendingSubmissions());
  } catch (err) {
    next(err);
  }
});

// 影片需要支援 Range 分段讀取，Safari／iPhone 沒有這個就無法播放（Chrome 沒有也能播，所以容易漏掉）
function sendWithRange(req, res, mimeType, data) {
  const total = data.length;
  res.set("Content-Type", mimeType);
  res.set("Accept-Ranges", "bytes");
  const header = req.headers.range;
  if (!header) return res.send(data);
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  let start;
  let end;
  if (m && (m[1] !== "" || m[2] !== "")) {
    if (m[1] === "") {
      start = Math.max(total - Number(m[2]), 0);
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
    }
  }
  if (start === undefined || start > end || start >= total) {
    res.set("Content-Range", `bytes */${total}`);
    return res.status(416).end();
  }
  res.status(206);
  res.set("Content-Range", `bytes ${start}-${end}/${total}`);
  res.set("Content-Length", String(end - start + 1));
  return res.end(data.subarray(start, end + 1));
}

router.get("/api/submissions/:id/media", async (req, res, next) => {
  try {
    const media = await submissionStore.getSubmissionMedia(Number(req.params.id));
    if (!media) return res.status(404).json({ error: "找不到這筆待審核媒體，可能已經被處理過" });
    sendWithRange(req, res, media.mime_type, media.data);
  } catch (err) {
    next(err);
  }
});

// 通過：跟輸入 LINE 指令「通過 X組」效果完全一樣（小編權限、不限關卡），
// 會直接推播下一關公告給隊伍（依「即時進度」分頁設定的推播範圍：只推隊長或全組成員）。
router.post("/api/submissions/:id/approve", async (req, res, next) => {
  try {
    const result = await teamService.approveSubmissionById(Number(req.params.id));
    if (result.groupBroadcast) {
      const recipientIds = await teamService.getGroupBroadcastRecipientIds(
        result.groupBroadcast.groupNo
      );
      await lineClient.pushToMany(recipientIds, result.groupBroadcast.messages);
    }
    for (const p of result.directPushes || []) {
      await lineClient.push(p.to, p.messages);
    }
    res.json({ ok: true, message: (result.reply || []).map((m) => m.text).join("\n") });
  } catch (err) {
    next(err);
  }
});

// 移除：只清掉這筆待審核紀錄，不會讓隊伍過關（例如上傳錯誤、想請隊伍重傳一次）
router.delete("/api/submissions/:id", async (req, res, next) => {
  try {
    await submissionStore.deleteSubmission(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- 緊急聯絡 ----

router.get("/api/emergencies", async (req, res, next) => {
  try {
    res.json(await teamService.listEmergencies());
  } catch (err) {
    next(err);
  }
});

// 後台按「已處理」：跟 LINE 上按「我來處理」同一個底層函式，會通知回報者與其他小編
router.post("/api/emergencies/:id/handle", async (req, res, next) => {
  try {
    const result = await teamService.handleEmergency(Number(req.params.id), "後台網頁");
    for (const p of result.directPushes || []) {
      await lineClient.push(p.to, p.messages);
    }
    res.json({ ok: true, message: (result.reply || []).map((m) => m.text).join("\n") });
  } catch (err) {
    next(err);
  }
});

// ---- 後台出發：跟 LINE 指令「出發 X組」同一個底層函式，可一次出發多組，可補登實際出發時間 ----

const DEPART_MAX_BACKDATE_MS = 24 * 60 * 60 * 1000;
const DEPART_CLOCK_SKEW_MS = 60 * 1000;

// 出發／到站時間可省略（＝現在）；有填的話必須是有效時間、不能是未來、不能早於 24 小時前，避免手滑填錯天讓耗時／逾時失真
function parseEventTime(value, label) {
  if (value === undefined || value === null || value === "") return { iso: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: `${label}格式不正確` };
  const now = Date.now();
  if (d.getTime() > now + DEPART_CLOCK_SKEW_MS) return { error: `${label}不能是未來的時間` };
  if (d.getTime() < now - DEPART_MAX_BACKDATE_MS) return { error: `${label}不能早於 24 小時前，請確認日期` };
  return { iso: d.toISOString() };
}

// 一次處理多個組別：逐組執行 action，再把該組的 LINE 通知推出去。推播失敗不影響已記錄的結果，回報給小編就好。
async function runForGroups(req, res, next, { timeField, timeLabel, action }) {
  try {
    const { groupNos } = req.body || {};
    if (!Array.isArray(groupNos) || groupNos.length === 0) {
      return res.status(400).json({ error: "請至少選擇一個組別" });
    }
    const groups = [...new Set(groupNos.map(Number))];
    if (groups.some((g) => !Number.isInteger(g) || g <= 0)) {
      return res.status(400).json({ error: "組別編號必須是正整數" });
    }
    const parsed = parseEventTime((req.body || {})[timeField], timeLabel);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const results = [];
    for (const groupNo of groups) {
      const result = await action(groupNo, parsed.iso);
      const notifyFailed = await deliver(groupNo, result);
      results.push({
        groupNo,
        done: !!result.groupBroadcast,
        notifyFailed,
        message: (result.reply || []).map((m) => m.text).join("\n"),
      });
    }
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
}

router.post("/api/depart", (req, res, next) =>
  runForGroups(req, res, next, {
    timeField: "startedAt",
    timeLabel: "出發時間",
    action: (groupNo, iso) => teamService.depart(groupNo, iso),
  })
);

// 後台到站：跟 LINE 指令「到站 X組」同一個底層函式（B6 終點確認），可一次多組、可補登實際到站時間
router.post("/api/finish", (req, res, next) =>
  runForGroups(req, res, next, {
    timeField: "finishedAt",
    timeLabel: "到站時間",
    action: (groupNo, iso) => teamService.finishAtB6(groupNo, iso),
  })
);

// ---- 進度表上的單組操作：通過／退回／取消到站（跟 LINE 指令「通過 X組」「退回 X組」「取消到站 X組」同一個底層函式）----

// 把通知推出去；推播失敗不影響已經記錄的結果，回報 notifyFailed 讓小編知道要手動通知
async function deliver(groupNo, result) {
  try {
    if (result.groupBroadcast) {
      const recipientIds = await teamService.getGroupBroadcastRecipientIds(groupNo);
      await lineClient.pushToMany(recipientIds, result.groupBroadcast.messages);
    }
    for (const p of result.directPushes || []) {
      await lineClient.push(p.to, p.messages);
    }
    return false;
  } catch (err) {
    console.error(`第 ${groupNo} 組通知推播失敗：`, err);
    return true;
  }
}

function teamAction(name, action) {
  router.post(`/api/teams/:groupNo/${name}`, async (req, res, next) => {
    try {
      const groupNo = Number(req.params.groupNo);
      if (!Number.isInteger(groupNo) || groupNo <= 0) {
        return res.status(400).json({ error: "組別編號必須是正整數" });
      }
      const result = await action(groupNo);
      const notifyFailed = await deliver(groupNo, result);
      res.json({
        ok: true,
        done: !!result.groupBroadcast,
        notifyFailed,
        message: (result.reply || []).map((m) => m.text).join("\n"),
      });
    } catch (err) {
      next(err);
    }
  });
}
teamAction("approve", (groupNo) => teamService.approveCheckpoint(groupNo, null)); // 小編權限：任何關卡都能通過
teamAction("revert", (groupNo) => teamService.revertLastCheckpoint(groupNo));
teamAction("cancel-finish", (groupNo) => teamService.cancelFinish(groupNo));

// ---- 人員清單與角色指定：小編直接從「傳過訊息給機器人的人」裡挑名字指定關主／總領隊，不用複製 userId ----

router.get("/api/line-users", async (req, res, next) => {
  try {
    res.json(await teamService.listLineUsers());
  } catch (err) {
    next(err);
  }
});

async function roleChange(res, next, change) {
  try {
    const result = await change();
    if (!result.ok) return res.status(400).json({ error: result.error });
    let notifyFailed = false;
    try {
      for (const p of result.pushes || []) await lineClient.push(p.to, p.messages);
    } catch (err) {
      console.error("角色異動通知推播失敗：", err);
      notifyFailed = true;
    }
    res.json({ ok: true, message: result.message, notifyFailed });
  } catch (err) {
    next(err);
  }
}

router.post("/api/referees", (req, res, next) => {
  const { userId, checkpointId } = req.body || {};
  if (!userId || !checkpointId) return res.status(400).json({ error: "請選擇人員與關卡" });
  return roleChange(res, next, () => teamService.assignReferee(String(userId), String(checkpointId).toUpperCase()));
});
router.delete("/api/referees/:userId", (req, res, next) =>
  roleChange(res, next, () => teamService.removeReferee(req.params.userId))
);
router.post("/api/broadcasters", (req, res, next) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "請選擇人員" });
  return roleChange(res, next, () => teamService.assignBroadcaster(String(userId)));
});
router.delete("/api/broadcasters/:userId", (req, res, next) =>
  roleChange(res, next, () => teamService.removeBroadcaster(req.params.userId))
);

// ---- 加好友歡迎詞 ----

router.get("/api/welcome-message", (req, res) => {
  res.json({ message: configStore.getWelcomeMessage() });
});

router.put("/api/welcome-message", async (req, res, next) => {
  try {
    const { message } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "歡迎訊息不能是空的" });
    }
    await configStore.setWelcomeMessage(message);
    res.json({ ok: true, message: configStore.getWelcomeMessage() });
  } catch (err) {
    next(err);
  }
});

// ---- 關卡公告推播範圍：leader（只推隊長，省則數）／ all（推全組成員）----

router.get("/api/broadcast-scope", (req, res) => {
  res.json({ scope: configStore.getBroadcastScope() });
});

router.put("/api/broadcast-scope", async (req, res, next) => {
  try {
    const { scope } = req.body || {};
    if (scope !== "leader" && scope !== "all") {
      return res.status(400).json({ error: "scope 必須是 leader 或 all" });
    }
    await configStore.setBroadcastScope(scope);
    res.json({ ok: true, scope: configStore.getBroadcastScope() });
  } catch (err) {
    next(err);
  }
});

// 重置整場遊戲：清空所有隊伍報到／進度／紀錄，跟 LINE 指令「重置遊戲 確認」是同一個底層函式。
// 這是不可逆操作，前端有另外做二次確認，這裡再多要求 body 帶 confirm: true，避免誤觸的請求直接生效。
router.post("/api/reset-game", async (req, res, next) => {
  try {
    if (!(req.body || {}).confirm) {
      return res.status(400).json({ error: "需要確認才能重置（confirm: true）" });
    }
    await teamService.resetGame();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  res.status(400).json({ error: (err && err.message) || "發生未知錯誤" });
});

module.exports = router;
