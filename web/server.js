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
