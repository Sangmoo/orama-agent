// =============================================================
//  ORAMON Web - Express 서버 + REST API
// =============================================================
require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');
const Q = require('./queries');
const collector = require('./collector');
const store = require('./store');
const mailer = require('./mailer');
const auth = require('./auth');
const advisor = require('./advisor');

const app = express();
const PORT = parseInt(process.env.PORT || '3900', 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 각 API 를 공통 래핑: {ok:true, data} 또는 {ok:false, error}
function api(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req);
      res.json({ ok: true, data, ts: Date.now() });
    } catch (e) {
      res.status(200).json({ ok: false, error: e.message, ts: Date.now() });
    }
  };
}

// 단일 행을 안전하게 조회 (권한 없으면 null)
async function tryOne(sql, binds = {}) {
  try {
    const rows = await db.query(sql, binds);
    return rows[0] || null;
  } catch (e) {
    return { _error: e.message };
  }
}

const MODE = (process.env.ORAMON_MODE || 'readonly').toLowerCase();

// ============ 인증 (아래 /api 라우트보다 먼저) ============
const LOGIN_MAX_LABEL = parseInt(process.env.LOGIN_MAX_ATTEMPTS || '5', 10);
app.post('/api/login', async (req, res) => {
  try {
    const reqId = req.body.usrId;
    // 1) 잠금 확인 (연속 실패 시 일시 잠금)
    const lockSec = auth.loginLockedFor(req, reqId);
    if (lockSec > 0) {
      store.addAudit(String(reqId || '-'), 'LOGIN_LOCK', auth.clientIp(req), `잠금 ${lockSec}초 남음`);
      return res.status(429).json({ ok: false, error: `로그인 시도가 많아 일시 잠겼습니다. ${lockSec}초 후 다시 시도하세요.` });
    }
    const usrId = await auth.verify(reqId, req.body.password);
    if (!usrId) {
      const f = auth.recordLoginFail(req, reqId);
      const msg = f.locked
        ? `로그인 실패가 많아 ${f.lockSec}초간 잠깁니다.`
        : `아이디 또는 비밀번호가 올바르지 않습니다. (남은 시도 ${f.remaining}회)`;
      if (f.locked) store.addAudit(String(reqId || '-'), 'LOGIN_LOCK', auth.clientIp(req), `${LOGIN_MAX_LABEL}회 연속 실패로 잠금`);
      return res.status(f.locked ? 429 : 401).json({ ok: false, error: msg });
    }
    auth.recordLoginSuccess(req, usrId);
    const token = auth.createSession(usrId);
    auth.setCookie(res, token);
    store.addAudit(usrId, 'LOGIN', null, null);
    res.json({ ok: true, data: { usrId } });
  } catch (e) {
    res.json({ ok: false, error: '로그인 처리 오류: ' + e.message });
  }
});
app.post('/api/logout', (req, res) => {
  const u = auth.currentUser(req);
  auth.destroySession(auth.tokenFrom(req));
  auth.clearCookie(res);
  if (u) store.addAudit(u.usrId, 'LOGOUT', null, null);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const u = auth.currentUser(req);
  res.json({ ok: true, data: { user: u, authEnabled: auth.enabled() } });
});

// 이 지점 이후의 모든 /api 라우트는 로그인 필요
app.use('/api', auth.requireAuth);

// --- 감사 로그 ---
app.get('/api/audit', api(async () => ({ list: store.getAudit(500) })));

// --- 접속/헬스 상태 ---
app.get('/api/health', api(async () => {
  let connected = false;
  try { connected = await db.ping(); } catch (_) { connected = false; }
  return { connected, profile: `${process.env.DB_USER}@${process.env.DB_SID}`, mode: MODE };
}));

// --- 개요: 인스턴스 + DB + 지표 + 세션요약 + 지표 히스토리(sparkline) ---
app.get('/api/overview', api(async () => {
  const [instance, database, metrics, summary, history] = await Promise.all([
    tryOne(Q.INSTANCE),
    tryOne(Q.DATABASE),
    db.query(Q.SYSMETRICS).catch(() => []),
    tryOne(Q.SESSION_SUMMARY),
    db.query(Q.METRIC_HISTORY).catch(() => [])
  ]);
  // 지표명 -> [값...] (시간순) 으로 묶기. 중복 timestamp 는 제거.
  const hist = {};
  const seen = {};
  for (const r of history) {
    const k = r.METRIC_NAME + '|' + r.T;
    if (seen[k]) continue;
    seen[k] = 1;
    (hist[r.METRIC_NAME] = hist[r.METRIC_NAME] || []).push(r.VALUE);
  }
  return { instance, database, metrics, summary, history: hist };
}));

// --- 세션 목록 ---
app.get('/api/sessions', api(async () => {
  const showBg = (process.env.SHOW_BACKGROUND === 'true') ? 'Y' : 'N';
  const [list, summary] = await Promise.all([
    db.query(Q.SESSIONS, { show_bg: showBg }),
    tryOne(Q.SESSION_SUMMARY)
  ]);
  return { list, summary };
}));

// --- Top SQL ---
app.get('/api/topsql', api(async () => {
  return { list: await db.query(Q.TOP_SQL) };
}));

// --- 특정 SQL 전체 텍스트 ---
app.get('/api/sql/:id', api(async (req) => {
  const rows = await db.query(Q.SQL_FULLTEXT, { sql_id: req.params.id });
  return { sql_id: req.params.id, sql_text: rows[0] ? rows[0].SQL_TEXT : null };
}));

// --- 특정 SQL 실행계획 ---
app.get('/api/plan/:id', api(async (req) => {
  const rows = await db.query(Q.SQL_PLAN, { sql_id: req.params.id });
  return { sql_id: req.params.id, plan: rows };
}));

// --- AI 튜닝 제안 (Claude API) ---
app.get('/api/tune/config', api(async (req) => ({
  configured: advisor.isConfigured(), model: advisor.MODEL, effort: advisor.EFFORT,
  limits: advisor.limits(req.user && req.user.usrId)
})));
// SSE 스트리밍: 생각중(thinking) → 텍스트 델타 → 완료. 캐시 히트면 즉시 1건 전송.
app.post('/api/tune/:id', async (req, res) => {
  const sqlId = String(req.params.id || '').trim();
  if (!/^[0-9a-z]+$/i.test(sqlId)) { res.status(400).json({ ok: false, error: 'SQL_ID 형식 오류' }); return; }
  const usrId = req.user && req.user.usrId;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch (_) {} };
  try {
    await advisor.suggestStream(sqlId, { usrId, force: req.query.force === '1' }, {
      cached: (data) => send({ type: 'cached', data }),
      thinking: () => send({ type: 'thinking' }),
      delta: (t) => send({ type: 'delta', text: t }),
      done: (data) => { store.addAudit(usrId, 'AI_TUNE', sqlId, `${data.model}/${data.effort}`); send({ type: 'done', data }); }
    });
  } catch (e) {
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// --- 진행 중/최근 대형 작업 (longops) ---
app.get('/api/longops', api(async () => {
  return { list: await db.query(Q.LONGOPS).catch(() => []) };
}));

// --- 세션 KILL (dba 모드에서만) ---
app.post('/api/kill', api(async (req) => {
  if (MODE !== 'dba') {
    throw new Error('readonly 모드입니다. 세션 종료는 .env 에서 ORAMON_MODE=dba 로 변경 후 서버 재시작해야 합니다.');
  }
  const sid = parseInt(req.body.sid, 10);
  const serial = parseInt(req.body.serial, 10);
  if (!Number.isInteger(sid) || !Number.isInteger(serial)) {
    throw new Error('sid / serial 값이 올바르지 않습니다.');
  }
  // sid,serial 은 정수로 검증됐으므로 문자열 조합 안전
  await db.exec(`ALTER SYSTEM KILL SESSION '${sid},${serial}' IMMEDIATE`);
  store.addAudit(req.user && req.user.usrId, 'KILL', `${sid},${serial}`, req.body.user || null);
  return { killed: `${sid},${serial}` };
}));

// --- 대기 이벤트 ---
app.get('/api/waits', api(async () => {
  const [classes, active] = await Promise.all([
    db.query(Q.WAIT_CLASS).catch((e) => ({ _error: e.message })),
    db.query(Q.ACTIVE_WAITS).catch(() => [])
  ]);
  return { classes, active };
}));

// --- 블로킹 세션 (enrich + fallback) ---
app.get('/api/blocking', api(async () => {
  return { list: await collector.getBlocking() };
}));

// --- 대시보드용 시계열 히스토리 (수집기 링버퍼) ---
app.get('/api/history', api(async (req) => {
  const limit = parseInt(req.query.limit || '0', 10);
  return { points: collector.getHistory(limit || undefined), config: collector.getConfig() };
}));

// --- 기준선 비교 (어제 vs 오늘, 같은 시간대) ---
app.get('/api/baseline', api(async (req) => {
  const minutes = Math.min(1440, Math.max(5, parseInt(req.query.minutes || '180', 10)));
  const allowed = ['cpu', 'aas', 'sessActive', 'execs', 'preads', 'utxn'];
  const metric = allowed.includes(req.query.metric) ? req.query.metric : 'cpu';
  const now = Date.now(), from = now - minutes * 60000, DAY = 86400000;
  const today = store.getMetricsBetween(from, now).map((p) => ({ t: p.t, v: p[metric] }));
  const yesterday = store.getMetricsBetween(from - DAY, now - DAY).map((p) => ({ t: p.t + DAY, v: p[metric] }));
  return { metric, minutes, from, now, today, yesterday };
}));

// --- CPU 스파이크 이력 ---
app.get('/api/events/cpu', api(async (req) => {
  return { events: collector.getCpuEvents(parseInt(req.query.limit || '100', 10)) };
}));

// --- 블로킹 이력 (수집기 파일 로그) ---
app.get('/api/events/locks', api(async (req) => {
  return { events: collector.getLockEvents(parseInt(req.query.limit || '500', 10)) };
}));

// --- 실제 데드락 이력 (alert log ORA-00060, 백그라운드 캐시) ---
//   ?refresh=1 이면 백그라운드 재수집 트리거 (즉시 반환, 결과는 다음 조회때)
app.get('/api/deadlocks', api(async (req) => {
  const c = req.query.refresh === '1' ? collector.refreshDeadlocks() : collector.getDeadlocks();
  return { list: c.list, fetchedAt: c.fetchedAt, loading: c.loading, error: c.error };
}));

// --- 테이블스페이스 (권한 없으면 error 필드로 안내) + 증가 예측 ---
//   수집기가 저장한 사용량 시계열로 선형회귀 → MB/일 증가율·포화 예상일 계산 (라이선스 프리)
const LOG_RETAIN_DAYS = parseInt(process.env.LOG_RETAIN_DAYS || '30', 10);
function predictTs(name, usedMb, totalMb) {
  const since = Date.now() - LOG_RETAIN_DAYS * 86400000;
  const s = store.getTsSamples(name, since);
  if (s.length < 3) return { status: 'collecting' }; // 표본 부족 → 수집 중
  const spanH = (s[s.length - 1].ts - s[0].ts) / 3600000;
  if (spanH < 2) return { status: 'collecting' };
  // 선형회귀 y=used_mb, x=ts(ms). slope: MB/ms
  const n = s.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of s) { sx += p.ts; sy += p.used_mb; sxx += p.ts * p.ts; sxy += p.ts * p.used_mb; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { status: 'stable' };
  const perDay = ((n * sxy - sx * sy) / denom) * 86400000;
  if (perDay <= 0.5) return { status: 'stable', perDay: Math.round(perDay * 10) / 10 }; // 사실상 정체/감소
  const remaining = (totalMb || 0) - (usedMb || 0);
  const daysToFull = remaining > 0 ? remaining / perDay : 0;
  return {
    status: 'growing',
    perDay: Math.round(perDay * 10) / 10,
    daysToFull: Math.round(daysToFull * 10) / 10,
    fullDate: new Date(Date.now() + daysToFull * 86400000).toISOString().slice(0, 10),
    samples: n
  };
}
app.get('/api/tablespaces', api(async () => {
  try {
    const list = await db.query(Q.TABLESPACES);
    for (const r of list) { try { r.PREDICT = predictTs(r.TABLESPACE_NAME, r.USED_MB, r.TOTAL_MB); } catch (_) { r.PREDICT = null; } }
    return { list };
  } catch (e) {
    return { list: [], error: 'DBA_ 뷰 조회 권한이 없습니다 (SELECT_CATALOG_ROLE 또는 개별 GRANT 필요): ' + e.message };
  }
}));

// --- 자체 ASH (구간별 top SQL / 이벤트 / 세션 + 타임라인) ---
app.get('/api/ash', api(async (req) => {
  const minutes = Math.min(1440, Math.max(1, parseInt(req.query.minutes || '15', 10)));
  const to = Date.now();
  const from = to - minutes * 60000;
  return {
    minutes,
    topSql: store.ashTopSql(from, to, 15),
    topEvents: store.ashTopEvents(from, to, 15),
    topSessions: store.ashTopSessions(from, to, 15),
    timeline: store.ashTimeline(from, to, 60)
  };
}));

// --- ASH 액티비티 히트맵 (버킷 × 대기클래스) ---
app.get('/api/ash/heatmap', api(async (req) => {
  const minutes = Math.min(1440, Math.max(1, parseInt(req.query.minutes || '15', 10)));
  const buckets = Math.min(96, Math.max(12, parseInt(req.query.buckets || '48', 10)));
  const to = Date.now();
  const from = to - minutes * 60000;
  const { bsize, rows } = store.ashHeatmap(from, to, buckets);
  // 연속 버킷 타임라인 생성
  const b0 = Math.floor(from / bsize) * bsize;
  const times = [];
  for (let t = b0; t <= to; t += bsize) times.push(t);
  const order = ['ON CPU', 'User I/O', 'System I/O', 'Concurrency', 'Application', 'Commit', 'Configuration', 'Network', 'Cluster', 'Scheduler', 'Administrative', 'Queueing', 'Other'];
  const present = [...new Set(rows.map((r) => r.wc))];
  const classes = order.filter((c) => present.includes(c)).concat(present.filter((c) => !order.includes(c)));
  const idx = new Map(times.map((t, i) => [t, i]));
  const cells = {}; let max = 0;
  for (const c of classes) cells[c] = new Array(times.length).fill(0);
  for (const r of rows) {
    const i = idx.get(r.bucket);
    if (i != null && cells[r.wc]) { cells[r.wc][i] = r.c; if (r.c > max) max = r.c; }
  }
  return { minutes, times, classes, cells, max, bsize };
}));

// --- 인시던트 통합 타임라인 (스파이크·블로킹·데드락·KILL·보안·알림) ---
app.get('/api/incidents', api(async (req) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '7', 10)));
  const since = Date.now() - days * 86400000;
  const items = [];
  for (const s of store.getSpikes(200)) {
    if (s.ts < since) continue;
    const sid0 = Array.isArray(s.topSql) && s.topSql[0] ? (s.topSql[0].SQL_ID || s.topSql[0].sql_id) : null;
    items.push({ ts: s.ts, type: 'CPU', title: `CPU 스파이크 ${Math.round(s.cpu || 0)}%`, detail: `AAS ${s.aas != null ? Number(s.aas).toFixed(1) : '-'} · 활성 ${s.activeSessions ?? '-'}`, sqlId: sid0 });
  }
  for (const l of store.getLocks(300)) {
    if (l.ts < since) continue;
    const b = l.blocker || {}, w = l.waiter || {};
    items.push({ ts: l.ts, type: 'BLOCK', title: `블로킹 ${l.wait_sec || 0}s`, detail: `blocker ${b.sid ?? '?'} → waiter ${w.sid ?? '?'}${l.locked_obj ? ' · ' + l.locked_obj : ''}`, sqlId: b.sql_id || w.sql_id || null });
  }
  for (const d of store.getDeadlocks(200)) {
    if ((d.ts || 0) < since) continue;
    items.push({ ts: d.ts, type: 'DEADLOCK', title: '데드락 (ORA-00060)', detail: d.trace || '', sqlId: null });
  }
  for (const a of store.getAudit(500)) {
    if (a.ts < since) continue;
    if (a.action === 'KILL') items.push({ ts: a.ts, type: 'KILL', title: `세션 KILL`, detail: `${a.usr_id} · ${a.target || ''} ${a.detail || ''}`.trim(), sqlId: null });
    else if (a.action === 'LOGIN_LOCK') items.push({ ts: a.ts, type: 'SECURITY', title: '로그인 잠금', detail: `${a.usr_id} · ${a.detail || a.target || ''}`, sqlId: null });
  }
  for (const al of store.getAlertLog(200)) {
    if (al.ts < since) continue;
    items.push({ ts: al.ts, type: 'ALERT', title: `알림: ${al.subject || al.kind || ''}`, detail: al.ok ? '메일 발송' : '메일 실패', sqlId: null });
  }
  items.sort((a, b) => b.ts - a.ts);
  return { days, list: items.slice(0, 300) };
}));

// --- 라이브 상태 (탭 배지용, DB 히트 없이 수집기 최신 샘플) ---
app.get('/api/status', api(async () => {
  const p = collector.getHistory(1)[0] || {};
  return { active: p.sessActive ?? null, blocked: p.sessBlocked ?? null, total: p.sessTotal ?? null, cpu: p.cpu ?? null };
}));

// --- "지금 상황 AI 요약" (Claude, 120초 캐시) ---
app.post('/api/ai/summary', async (req, res) => {
  const usrId = req.user && req.user.usrId;
  try {
    const out = await advisor.summarizeState({ force: req.query.force === '1' });
    if (!out.cached) store.addAudit(usrId, 'AI_SUMMARY', null, out.model);
    res.json({ ok: true, data: out });
  } catch (e) {
    res.status(advisor.isConfigured() ? 500 : 400).json({ ok: false, error: e.message });
  }
});

// --- 아카이브 로그 생성률 (최근 24h) ---
app.get('/api/archivelog', api(async () => {
  try { return { list: await db.query(Q.ARCHIVE_LOG_RATE) }; }
  catch (e) { return { list: [], error: 'v$archived_log 접근 불가: ' + e.message }; }
}));

// --- 세그먼트 Top 공간 소비 ---
app.get('/api/segments', api(async () => {
  try { return { list: await db.query(Q.TOP_SEGMENTS) }; }
  catch (e) { return { list: [], error: 'dba_segments 접근 권한이 없습니다: ' + e.message }; }
}));

// --- 메모리 어드바이저 (SGA/PGA/Buffer Cache/Shared Pool advice) ---
app.get('/api/memory', api(async () => {
  const q = (sql) => db.query(sql).catch(() => []);
  const [current, pgaTarget, sga, pga, cache, shared] = await Promise.all([
    q(Q.MEM_CURRENT), q(Q.MEM_PGA_TARGET), q(Q.MEM_SGA_ADVICE), q(Q.MEM_PGA_ADVICE), q(Q.MEM_CACHE_ADVICE), q(Q.MEM_SHARED_ADVICE)
  ]);
  const err = (!current.length && !cache.length && !shared.length) ? 'v$ advice 뷰 접근 권한이 없거나(SELECT_CATALOG_ROLE) 자동 메모리 관리가 꺼져 있습니다.' : null;
  return { current, pgaTargetMb: pgaTarget[0] ? pgaTarget[0].MB : null, sga, pga, cache, shared, error: err };
}));

// --- Undo / Temp 모니터 ---
app.get('/api/undotemp', api(async () => {
  const q = (sql) => db.query(sql).catch(() => []);
  const [retention, undoSummary, undoStat, tempUsage, tempSessions] = await Promise.all([
    q(Q.UNDO_RETENTION), q(Q.UNDO_SUMMARY), q(Q.UNDO_STAT), q(Q.TEMP_USAGE), q(Q.TEMP_SESSIONS)
  ]);
  return {
    undoRetention: retention[0] ? parseInt(retention[0].VALUE, 10) : null,
    undoSummary, undoStat, tempUsage, tempSessions
  };
}));

// --- 점검: 통계 신선도 + 인덱스 (중복/미사용) ---
app.get('/api/checkup', api(async () => {
  const [staleStats, idxMon, redundant] = await Promise.all([
    db.query(Q.STALE_STATS).catch((e) => ({ error: e.message })),
    db.query(Q.INDEX_MON_USAGE).catch(() => []),
    db.query(Q.REDUNDANT_INDEXES).catch((e) => ({ error: e.message }))
  ]);
  return {
    staleStats: Array.isArray(staleStats) ? staleStats : [],
    staleError: Array.isArray(staleStats) ? null : (staleStats && staleStats.error),
    indexMon: Array.isArray(idxMon) ? idxMon : [],
    redundant: Array.isArray(redundant) ? redundant : [],
    redundantError: Array.isArray(redundant) ? null : (redundant && redundant.error)
  };
}));

// --- 메모(주석): scope 별 목록 / 단건 조회 / 저장 / 삭제 ---
app.get('/api/notes', api(async (req) => ({ list: store.listNotes(String(req.query.scope || 'sql')) })));
app.get('/api/note/:scope/:ref', api(async (req) => ({ note: store.getNote(String(req.params.scope), String(req.params.ref)) })));
app.put('/api/note', api(async (req) => {
  const scope = String((req.body && req.body.scope) || '').trim();
  const ref = String((req.body && req.body.ref) || '').trim();
  if (!scope || !ref) throw new Error('scope/ref 필요');
  store.setNote(scope, ref, (req.body && req.body.note) || '', req.user && req.user.usrId);
  store.addAudit(req.user && req.user.usrId, 'NOTE', `${scope}:${ref}`, null);
  return { note: store.getNote(scope, ref) };
}));
app.delete('/api/note/:scope/:ref', api(async (req) => {
  store.deleteNote(String(req.params.scope), String(req.params.ref));
  return { ok: true };
}));

// --- 세션 상세 (v$session + v$sesstat) ---
app.get('/api/session/:sid', api(async (req) => {
  const sid = parseInt(req.params.sid, 10);
  if (!Number.isInteger(sid)) throw new Error('sid 오류');
  const [rows, stats] = await Promise.all([
    db.query(Q.SESSION_ROW, { sid }),
    db.query(Q.SESSION_STAT, { sid }).catch(() => [])
  ]);
  return { session: rows[0] || null, stats };
}));

// --- 알림 수신자 관리 ---
app.get('/api/recipients', api(async () => ({ list: store.listRecipients() })));
app.post('/api/recipients', api(async (req) => {
  const email = String(req.body.email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('이메일 형식이 올바르지 않습니다.');
  store.addRecipient(email);
  store.addAudit(req.user && req.user.usrId, 'RECIPIENT_ADD', email, null);
  return { list: store.listRecipients() };
}));
app.delete('/api/recipients/:email', api(async (req) => {
  const email = decodeURIComponent(req.params.email);
  store.removeRecipient(email);
  store.addAudit(req.user && req.user.usrId, 'RECIPIENT_DEL', email, null);
  return { list: store.listRecipients() };
}));

// --- 알림 설정 / 테스트 ---
app.get('/api/alerts/config', api(async () => ({
  enabled: mailer.isEnabled(),
  configured: mailer.isConfigured(),
  recipients: store.listRecipients().length,
  log: store.getAlertLog(30),
  thresholds: collector.getConfig()
})));
app.post('/api/alerts/toggle', api(async (req) => {
  mailer.setEnabled(!!req.body.enabled);
  store.addAudit(req.user && req.user.usrId, 'ALERT_TOGGLE', mailer.isEnabled() ? 'ON' : 'OFF', null);
  return { enabled: mailer.isEnabled() };
}));
app.post('/api/alerts/test', api(async () => {
  const r = await mailer.sendTest();
  if (!r.ok) throw new Error(r.error || '발송 실패');
  return r;
}));

// --- 임계치 런타임 조정 ---
app.post('/api/settings/thresholds', api(async (req) => {
  const cfg = collector.setThresholds({
    cpuSpike: req.body.cpuSpike, blockSec: req.body.blockSec, tsPct: req.body.tsPct
  });
  store.addAudit(req.user && req.user.usrId, 'THRESHOLD', `CPU ${cfg.CPU_SPIKE_PCT}% / 블로킹 ${cfg.BLOCK_SEC}s / TS ${cfg.TS_ALERT_PCT}%`, null);
  return cfg;
}));

// --- Prometheus 노출 (실제 Grafana 연동용, 선택) ---
//   Grafana + Prometheus 를 쓰고 싶으면 Prometheus 가 이 엔드포인트를 scrape 하면 됩니다.
app.get('/metrics', async (req, res) => {
  const h = collector.getHistory(1);
  const p = h[0] || {};
  const lines = [];
  const g = (name, help, val) => {
    if (val == null) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${val}`);
  };
  g('oramon_host_cpu_pct', 'Host CPU Utilization (%)', p.cpu);
  g('oramon_avg_active_sessions', 'Average Active Sessions', p.aas);
  g('oramon_executions_per_sec', 'Executions Per Sec', p.execs);
  g('oramon_physical_reads_per_sec', 'Physical Reads Per Sec', p.preads);
  g('oramon_user_txn_per_sec', 'User Transactions Per Sec', p.utxn);
  g('oramon_db_cpu_ratio', 'Database CPU Time Ratio', p.dbcpu);
  g('oramon_sessions_active', 'Active sessions', p.sessActive);
  g('oramon_sessions_blocked', 'Blocked sessions', p.sessBlocked);
  g('oramon_sessions_total', 'Total sessions', p.sessTotal);
  res.set('Content-Type', 'text/plain; version=0.0.4').send(lines.join('\n') + '\n');
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

(async () => {
  // 저장소·메일러는 DB 없이도 먼저 준비 (로그인 화면은 떠야 하므로 웹서버부터 기동)
  store.init();
  mailer.init();
  app.listen(PORT, () => {
    console.log(`[ORAMON] 웹 대시보드: http://localhost:${PORT}`);
  });
  // Oracle 접속은 재시도 루프로 — 리스너가 늦게 떠도, 운영 중 끊겨도 스스로 회복
  console.log('[ORAMON] Oracle 커넥션 풀 초기화 중...');
  db.initWithRetry(() => {
    console.log(`[ORAMON] Oracle 접속됨: ${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_SID}`);
    collector.start();
  });
})();

process.on('SIGINT', async () => {
  console.log('\n[ORAMON] 종료 중...');
  await db.close();
  process.exit(0);
});
