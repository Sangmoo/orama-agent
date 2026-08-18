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
app.post('/api/login', async (req, res) => {
  try {
    const usrId = await auth.verify(req.body.usrId, req.body.password);
    if (!usrId) return res.json({ ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
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
app.get('/api/audit', api(async () => ({ list: store.getAudit(100) })));

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
app.post('/api/tune/:id', api(async (req) => {
  const sqlId = String(req.params.id || '').trim();
  if (!/^[0-9a-z]+$/i.test(sqlId)) throw new Error('SQL_ID 형식 오류');
  const usrId = req.user && req.user.usrId;
  const result = await advisor.suggest(sqlId, { usrId, force: req.query.force === '1' });
  if (!result.cached) store.addAudit(usrId, 'AI_TUNE', sqlId, `${result.model}/${result.effort}`);
  return result;
}));

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
  return { events: collector.getLockEvents(parseInt(req.query.limit || '100', 10)) };
}));

// --- 실제 데드락 이력 (alert log ORA-00060, 백그라운드 캐시) ---
//   ?refresh=1 이면 백그라운드 재수집 트리거 (즉시 반환, 결과는 다음 조회때)
app.get('/api/deadlocks', api(async (req) => {
  const c = req.query.refresh === '1' ? collector.refreshDeadlocks() : collector.getDeadlocks();
  return { list: c.list, fetchedAt: c.fetchedAt, loading: c.loading, error: c.error };
}));

// --- 테이블스페이스 (권한 없으면 error 필드로 안내) ---
app.get('/api/tablespaces', api(async () => {
  try {
    return { list: await db.query(Q.TABLESPACES) };
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
