// 後台網頁：登入、關卡與路線設定的 CRUD、即時進度、關主名單。
// 掛在 src/index.js 的 app.use("/admin", adminRouter)。
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");

const auth = require("./auth");
const configStore = require("../config/configStore");
const teamService = require("../services/teamService");

const router = express.Router();
const PUBLIC_ADMIN_DIR = path.join(__dirname, "..", "..", "public", "admin");
const MAPS_DIR = path.join(__dirname, "..", "..", "public", "maps");

const VALID_VERIFY_TYPES = ["keyword", "photo", "video", "referee"];

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

const upload = multer({
  storage: multer.diskStorage({
    destination: MAPS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      const safeId = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, "");
      cb(null, `${safeId}-${Date.now()}${ext}`);
    },
  }),
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
    const { name, location, content, scoringMethod, verifyType, mapFiles, sortOrder } =
      req.body || {};
    if (!name || !location || !content || !scoringMethod || !verifyType) {
      return res
        .status(400)
        .json({ error: "name / location / content / scoringMethod / verifyType 都是必填" });
    }
    if (!VALID_VERIFY_TYPES.includes(verifyType)) {
      return res.status(400).json({ error: "verifyType 必須是 keyword / photo / video / referee" });
    }
    await configStore.upsertCheckpoint({
      id: req.params.id,
      name,
      location,
      content,
      scoringMethod,
      verifyType,
      mapFiles: Array.isArray(mapFiles) ? mapFiles : [],
      sortOrder,
    });
    res.json({ ok: true, checkpoint: configStore.getCheckpoint(req.params.id) });
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

router.post("/api/checkpoints/:id/image", upload.single("image"), async (req, res, next) => {
  try {
    if (!configStore.hasCheckpoint(req.params.id)) {
      return res.status(404).json({ error: "找不到這個關卡代號，請先建立關卡再上傳圖片" });
    }
    if (!req.file) return res.status(400).json({ error: "沒有收到圖片檔" });
    const cp = configStore.getCheckpoint(req.params.id);
    await configStore.upsertCheckpoint({ ...cp, mapFiles: [...cp.mapFiles, req.file.filename] });
    res.json({ ok: true, checkpoint: configStore.getCheckpoint(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.delete("/api/checkpoints/:id/image/:filename", async (req, res, next) => {
  try {
    const cp = configStore.getCheckpoint(req.params.id);
    const mapFiles = cp.mapFiles.filter((f) => f !== req.params.filename);
    await configStore.upsertCheckpoint({ ...cp, mapFiles });
    fs.unlink(path.join(MAPS_DIR, req.params.filename), () => {});
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
