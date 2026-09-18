// 後台網頁：登入、關卡與路線設定的 CRUD、即時進度、關主名單。
// 掛在 src/index.js 的 app.use("/admin", adminRouter)。
const path = require("path");
const express = require("express");
const multer = require("multer");

const auth = require("./auth");
const configStore = require("../config/configStore");
const imageStore = require("../config/imageStore");
const teamService = require("../services/teamService");

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
