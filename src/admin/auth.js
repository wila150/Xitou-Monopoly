// 後台網頁的登入機制：單一共用密碼 + 簽名過的 cookie，不需要額外的資料庫表或第三方套件。
const crypto = require("crypto");

const SESSION_COOKIE = "xitou_admin_session";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 小時

function getSecret() {
  const secret = process.env.ADMIN_PANEL_SECRET;
  if (!secret) {
    throw new Error("缺少 ADMIN_PANEL_SECRET 環境變數，後台網頁無法啟用");
  }
  return secret;
}

function sign(payload) {
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return false;
  const idx = token.lastIndexOf(".");
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  let sigBuf, expectedBuf;
  try {
    const expectedSig = crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
    sigBuf = Buffer.from(sig, "hex");
    expectedBuf = Buffer.from(expectedSig, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function createSessionCookie() {
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  const token = sign(String(expiresAt));
  const maxAgeSec = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/admin; Max-Age=${maxAgeSec}; SameSite=Strict`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/admin; Max-Age=0; SameSite=Strict`;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[SESSION_COOKIE]);
}

// 掛在 /admin 底下，除了登入頁跟登入 API，其他都要先驗證過 cookie
function requireAuth(req, res, next) {
  if (req.path === "/login" || req.path === "/api/login") return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "未登入或登入已過期，請重新登入。" });
  }
  return res.redirect("/admin/login");
}

module.exports = {
  createSessionCookie,
  clearSessionCookie,
  isAuthenticated,
  requireAuth,
};
