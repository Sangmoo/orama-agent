// =============================================================
//  ORAMON - 인증 (T_USR / T_EMP 부서 212003 기반)
//  비밀번호는 SQL 내에서 CRYPTO_DECRYPT 로 bind 비교 → 앱은 평문을 다루지 않음.
//  세션은 메모리 보관(재시작 시 재로그인). 쿠키: oramon_sid
// =============================================================
const crypto = require('crypto');
const db = require('./db');
const Q = require('./queries');
const store = require('./store');

const COOKIE = 'oramon_sid';
const IDLE_MS = parseInt(process.env.AUTH_IDLE_MIN || '480', 10) * 60000; // 기본 8시간
const AUTH_ENABLED = (process.env.AUTH_ENABLED || 'true').toLowerCase() === 'true';

const sessions = new Map(); // token -> { usrId, created, last }

function enabled() { return AUTH_ENABLED; }

// 로그인 검증. 성공 시 usrId, 실패 시 null. (오류는 상위에서 처리)
async function verify(usrId, password) {
  if (!usrId || !password) return null;
  const rows = await db.query(Q.AUTH_LOGIN, { usr_id: String(usrId), pw: String(password) });
  return rows.length ? rows[0].USR_ID : null;
}

function createSession(usrId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  sessions.set(token, { usrId, created: now, last: now });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.last > IDLE_MS) { sessions.delete(token); return null; }
  s.last = Date.now();
  return s;
}

function destroySession(token) { if (token) sessions.delete(token); }

// 쿠키 파싱 (의존성 없이)
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function tokenFrom(req) { return parseCookies(req)[COOKIE]; }

// 현재 로그인 사용자 (없으면 null)
function currentUser(req) {
  if (!AUTH_ENABLED) return { usrId: 'anonymous' };
  const s = getSession(tokenFrom(req));
  return s ? { usrId: s.usrId } : null;
}

// 보호 미들웨어: 로그인 안 됐으면 401
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) { req.user = { usrId: 'anonymous' }; return next(); }
  const s = getSession(tokenFrom(req));
  if (!s) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.', auth: false });
  req.user = { usrId: s.usrId };
  next();
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(IDLE_MS / 1000)}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

module.exports = {
  enabled, verify, createSession, destroySession, currentUser, requireAuth,
  tokenFrom, setCookie, clearCookie, COOKIE
};
