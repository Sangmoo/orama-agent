// =============================================================
//  ORAMON - 이메일 알림 (nodemailer / SMTP)
//  등록된 수신자에게 원인 SQL_ID + 상세 쿼리 전문을 포함해 발송.
// =============================================================
const nodemailer = require('nodemailer');
const store = require('./store');

let transporter = null;
let enabled = false;

function init() {
  const host = process.env.SMTP_HOST;
  enabled = (process.env.ALERT_ENABLED || 'false').toLowerCase() === 'true';
  if (!host) {
    console.log('[mailer] SMTP_HOST 미설정 — 이메일 알림 비활성');
    return;
  }
  transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true', // 465 이면 true
    auth: (process.env.SMTP_USER)
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    tls: { rejectUnauthorized: false } // 사내 자체 서명 인증서 대비
  });
  console.log(`[mailer] SMTP 준비: ${host}:${process.env.SMTP_PORT || 587} · 알림 ${enabled ? 'ON' : 'OFF'}`);
}

function isEnabled() { return enabled && !!transporter; }
function setEnabled(v) { enabled = !!v; }
function isConfigured() { return !!transporter; }

// HTML 이스케이프
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));

// 실제 발송 (수신자 없거나 미설정이면 skip)
async function send(subject, html, kind) {
  const to = store.listRecipients();
  if (!transporter) { store.logAlert(kind, subject, false, 'SMTP 미설정'); return { ok: false, error: 'SMTP 미설정' }; }
  if (!to.length) { store.logAlert(kind, subject, false, '수신자 없음'); return { ok: false, error: '수신자 없음' }; }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'oramon@localhost',
      to: to.join(','),
      subject,
      html
    });
    store.logAlert(kind, subject, true, `to ${to.length}명`);
    return { ok: true, sent: to.length };
  } catch (e) {
    store.logAlert(kind, subject, false, e.message);
    console.error('[mailer] 발송 실패:', e.message);
    return { ok: false, error: e.message };
  }
}

const PROFILE = () => `${process.env.DB_USER}@${process.env.DB_SID}`;
const wrap = (title, bodyRows) => `
  <div style="font-family:Segoe UI,Malgun Gothic,sans-serif;font-size:14px;color:#222">
    <h2 style="color:#c0392b;margin:0 0 4px">⚠ ORAMON 알림 · ${esc(title)}</h2>
    <div style="color:#888;margin-bottom:12px">${esc(PROFILE())} · ${new Date().toLocaleString('ko-KR', { hour12: false })}</div>
    ${bodyRows}
  </div>`;
const sqlBlock = (sqlId, sqlText) => sqlId ? `
    <h3 style="margin:14px 0 4px">원인 SQL</h3>
    <div><b>SQL_ID:</b> <code>${esc(sqlId)}</code></div>
    <pre style="background:#f4f4f4;border:1px solid #ddd;border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:360px;overflow:auto">${esc(sqlText || '(SQL 텍스트를 찾을 수 없음)')}</pre>` : '';

// CPU 스파이크 알림 — 원인 top SQL + 전문 포함
async function alertSpike(event, sqlText) {
  if (!isEnabled()) return;
  const top = (event.topSql && event.topSql[0]) || {};
  const rows = (event.topSql || []).slice(0, 5).map((t) =>
    `<tr><td style="padding:3px 8px"><code>${esc(t.sql_id || '(no sql)')}</code></td><td style="padding:3px 8px">${t.count}세션</td></tr>`).join('');
  const html = wrap(`CPU 스파이크 ${event.cpu}%`, `
    <div>Host CPU <b>${event.cpu}%</b> · AAS <b>${event.aas}</b> · 활성 세션 <b>${event.activeSessions}</b></div>
    <h3 style="margin:14px 0 4px">원인 추정 Top SQL</h3>
    <table style="border-collapse:collapse">${rows}</table>
    ${sqlBlock(top.sql_id, sqlText)}`);
  return send(`[ORAMON] CPU 스파이크 ${event.cpu}% (${PROFILE()})`, html, 'spike');
}

// 블로킹 알림 — blocker/waiter SQL_ID + blocker 전문 포함
async function alertBlock(event, blockerSqlText) {
  if (!isEnabled()) return;
  const w = event.waiter || {}, b = event.blocker || {};
  const html = wrap(`블로킹 ${event.wait_sec}초`, `
    <div><b>${event.wait_sec}초</b> 이상 블로킹 감지 ${event.locked_obj ? `· 잠긴 객체 <code>${esc(event.locked_obj)}</code>` : ''}</div>
    <table style="border-collapse:collapse;margin-top:8px">
      <tr><td style="padding:3px 8px;color:#888">Waiter</td><td style="padding:3px 8px">SID <b>${esc(w.sid)}</b> · ${esc(w.user)} · SQL <code>${esc(w.sql_id)}</code></td></tr>
      <tr><td style="padding:3px 8px;color:#888">Blocker</td><td style="padding:3px 8px">SID <b>${esc(b.sid)},${esc(b.serial)}</b> · ${esc(b.user)} · SQL <code>${esc(b.sql_id)}</code> · ${esc(b.status)}</td></tr>
    </table>
    ${sqlBlock(b.sql_id, blockerSqlText)}`);
  return send(`[ORAMON] 블로킹 ${event.wait_sec}초 · blocker ${b.sid} (${PROFILE()})`, html, 'block');
}

// 테이블스페이스 포화 알림
async function alertTablespace(list) {
  if (!isEnabled()) return;
  const rows = list.map((t) => `<tr>
    <td style="padding:3px 8px">${esc(t.TABLESPACE_NAME)}</td>
    <td style="padding:3px 8px;color:${t.USED_PCT >= 90 ? '#c0392b' : '#e67e22'}"><b>${t.USED_PCT}%</b></td>
    <td style="padding:3px 8px">${t.FREE_MB} MB free</td></tr>`).join('');
  const html = wrap('테이블스페이스 포화 경고', `
    <table style="border-collapse:collapse"><tr><th style="text-align:left;padding:3px 8px">TS</th><th style="text-align:left;padding:3px 8px">사용률</th><th></th></tr>${rows}</table>`);
  return send(`[ORAMON] 테이블스페이스 포화 경고 (${PROFILE()})`, html, 'tablespace');
}

// 테스트 발송
async function sendTest() {
  const html = wrap('테스트 메일', '<div>ORAMON 이메일 알림이 정상 설정되었습니다. ✅</div>');
  const prev = enabled; enabled = true;
  const r = await send(`[ORAMON] 테스트 알림 (${PROFILE()})`, html, 'test');
  enabled = prev;
  return r;
}

module.exports = { init, isEnabled, setEnabled, isConfigured, alertSpike, alertBlock, alertTablespace, sendTest };
