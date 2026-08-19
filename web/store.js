// =============================================================
//  ORAMON - SQLite 영구 저장소 (Node 내장 node:sqlite)
//  지표 시계열 / ASH 샘플 / 이벤트 / 알림 수신자 를 파일 DB 에 보관.
//  서버 재시작에도 데이터가 유지됩니다.
// =============================================================
const path = require('path');
const fs = require('fs');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) {
  console.error('[store] node:sqlite 로드 실패 (Node 22+ 필요):', e.message);
}

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'oramon.db');
const RETAIN_DAYS = parseInt(process.env.RETAIN_DAYS || '7', 10);
// 감사 로그 · 블로킹 감지 이력 · CPU 스파이크 이력은 더 오래 보관 (기본 30일)
const LOG_RETAIN_DAYS = parseInt(process.env.LOG_RETAIN_DAYS || '30', 10);

let db = null;

function init() {
  if (!DatabaseSync) return false;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      ts INTEGER PRIMARY KEY, cpu REAL, aas REAL, execs REAL, preads REAL,
      utxn REAL, dbcpu REAL, sess_active INTEGER, sess_blocked INTEGER, sess_total INTEGER
    );
    CREATE TABLE IF NOT EXISTS ash (
      ts INTEGER, sid INTEGER, serial INTEGER, username TEXT, sql_id TEXT,
      event TEXT, wait_class TEXT, machine TEXT, program TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ash_ts ON ash(ts);
    CREATE INDEX IF NOT EXISTS idx_ash_sql ON ash(sql_id);
    CREATE TABLE IF NOT EXISTS spike_events (
      ts INTEGER PRIMARY KEY, cpu REAL, aas REAL, active_sessions INTEGER,
      top_sql TEXT, sessions TEXT
    );
    CREATE TABLE IF NOT EXISTS lock_events (
      ts INTEGER PRIMARY KEY, wait_sec INTEGER, waiter TEXT, blocker TEXT, locked_obj TEXT
    );
    CREATE TABLE IF NOT EXISTS recipients ( email TEXT PRIMARY KEY, added_at INTEGER );
    CREATE TABLE IF NOT EXISTS alert_log ( ts INTEGER, kind TEXT, subject TEXT, ok INTEGER, detail TEXT );
    CREATE TABLE IF NOT EXISTS audit_log ( ts INTEGER, usr_id TEXT, action TEXT, target TEXT, detail TEXT );
    CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
    CREATE TABLE IF NOT EXISTS tune_cache ( sql_id TEXT PRIMARY KEY, payload TEXT, ts INTEGER );
    CREATE TABLE IF NOT EXISTS tune_calls ( ts INTEGER, usr_id TEXT );
    CREATE TABLE IF NOT EXISTS deadlocks ( ts INTEGER PRIMARY KEY, t TEXT, trace TEXT );
    CREATE TABLE IF NOT EXISTS ts_usage ( ts INTEGER, tablespace TEXT, used_mb REAL, total_mb REAL );
    CREATE INDEX IF NOT EXISTS idx_tsusage ON ts_usage(tablespace, ts);
    CREATE TABLE IF NOT EXISTS notes ( scope TEXT, ref TEXT, note TEXT, usr_id TEXT, ts INTEGER, PRIMARY KEY (scope, ref) );
  `);
  console.log(`[store] SQLite 준비: ${DB_FILE} (기본 보관 ${RETAIN_DAYS}일 · 이력 ${LOG_RETAIN_DAYS}일)`);
  return true;
}

const ok = () => !!db;

// ---- 지표 ----
function insertMetric(p) {
  if (!db) return;
  db.prepare(`INSERT OR REPLACE INTO metrics
    (ts,cpu,aas,execs,preads,utxn,dbcpu,sess_active,sess_blocked,sess_total)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    p.t, p.cpu, p.aas, p.execs, p.preads, p.utxn, p.dbcpu, p.sessActive, p.sessBlocked, p.sessTotal);
}
function getMetrics(sinceTs) {
  if (!db) return [];
  const rows = db.prepare(`SELECT * FROM metrics ${sinceTs ? 'WHERE ts >= ?' : ''} ORDER BY ts`).all(...(sinceTs ? [sinceTs] : []));
  return rows.map((r) => ({
    t: r.ts, cpu: r.cpu, aas: r.aas, execs: r.execs, preads: r.preads, utxn: r.utxn, dbcpu: r.dbcpu,
    sessActive: r.sess_active, sessBlocked: r.sess_blocked, sessTotal: r.sess_total
  }));
}

// ---- ASH ----
function insertAsh(ts, sessions) {
  if (!db || !sessions.length) return;
  const stmt = db.prepare(`INSERT INTO ash (ts,sid,serial,username,sql_id,event,wait_class,machine,program)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  // node:sqlite 는 db.transaction() 미지원 → 수동 BEGIN/COMMIT
  db.exec('BEGIN');
  try {
    for (const s of sessions) stmt.run(ts, s.SID, s.SERIAL, s.USERNAME, s.SQL_ID, s.EVENT, s.WAIT_CLASS, s.MACHINE, s.PROGRAM);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}
function ashTopSql(from, to, limit = 15) {
  if (!db) return [];
  return db.prepare(`SELECT sql_id, COUNT(*) samples, COUNT(DISTINCT sid) sessions
    FROM ash WHERE ts BETWEEN ? AND ? AND sql_id IS NOT NULL
    GROUP BY sql_id ORDER BY samples DESC LIMIT ?`).all(from, to, limit);
}
function ashTopEvents(from, to, limit = 15) {
  if (!db) return [];
  return db.prepare(`SELECT COALESCE(event,'ON CPU') event, wait_class, COUNT(*) samples
    FROM ash WHERE ts BETWEEN ? AND ?
    GROUP BY event, wait_class ORDER BY samples DESC LIMIT ?`).all(from, to, limit);
}
function ashTopSessions(from, to, limit = 15) {
  if (!db) return [];
  return db.prepare(`SELECT sid, username, machine, COUNT(*) samples, COUNT(DISTINCT sql_id) sqls
    FROM ash WHERE ts BETWEEN ? AND ?
    GROUP BY sid, username, machine ORDER BY samples DESC LIMIT ?`).all(from, to, limit);
}
function ashTimeline(from, to, buckets = 60) {
  if (!db) return [];
  const span = Math.max(1, to - from);
  const bsize = Math.ceil(span / buckets);
  // 버킷별 샘플 수 / 버킷당 tick 수 ~= 평균 활성 세션
  return db.prepare(`SELECT (ts/?)*? AS bucket, COUNT(*) samples, COUNT(DISTINCT ts) ticks
    FROM ash WHERE ts BETWEEN ? AND ? GROUP BY ts/? ORDER BY bucket`).all(bsize, bsize, from, to, bsize)
    .map((r) => ({ t: r.bucket, aas: r.ticks ? +(r.samples / r.ticks).toFixed(2) : 0 }));
}

// ---- 이벤트 ----
function insertSpike(e) {
  if (!db) return;
  db.prepare(`INSERT OR REPLACE INTO spike_events (ts,cpu,aas,active_sessions,top_sql,sessions)
    VALUES (?,?,?,?,?,?)`).run(e.ts, e.cpu, e.aas, e.activeSessions, JSON.stringify(e.topSql || []), JSON.stringify(e.sessions || []));
}
function getSpikes(limit = 100) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM spike_events ORDER BY ts DESC LIMIT ?`).all(limit).map((r) => ({
    ts: r.ts, cpu: r.cpu, aas: r.aas, activeSessions: r.active_sessions,
    topSql: JSON.parse(r.top_sql || '[]'), sessions: JSON.parse(r.sessions || '[]')
  }));
}
function insertLock(e) {
  if (!db) return;
  db.prepare(`INSERT OR REPLACE INTO lock_events (ts,wait_sec,waiter,blocker,locked_obj)
    VALUES (?,?,?,?,?)`).run(e.ts, e.wait_sec, JSON.stringify(e.waiter || {}), JSON.stringify(e.blocker || {}), e.locked_obj || null);
}
function getLocks(limit = 100) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM lock_events ORDER BY ts DESC LIMIT ?`).all(limit).map((r) => ({
    ts: r.ts, wait_sec: r.wait_sec, waiter: JSON.parse(r.waiter || '{}'), blocker: JSON.parse(r.blocker || '{}'), locked_obj: r.locked_obj
  }));
}

// ---- 알림 수신자 ----
function listRecipients() {
  if (!db) return [];
  return db.prepare(`SELECT email FROM recipients ORDER BY added_at`).all().map((r) => r.email);
}
function addRecipient(email) {
  if (!db) return;
  db.prepare(`INSERT OR IGNORE INTO recipients (email, added_at) VALUES (?, ?)`).run(email, Date.now());
}
function removeRecipient(email) {
  if (!db) return;
  db.prepare(`DELETE FROM recipients WHERE email = ?`).run(email);
}

// ---- 알림 로그 ----
function logAlert(kind, subject, okFlag, detail) {
  if (!db) return;
  db.prepare(`INSERT INTO alert_log (ts,kind,subject,ok,detail) VALUES (?,?,?,?,?)`)
    .run(Date.now(), kind, subject, okFlag ? 1 : 0, detail || null);
}
function getAlertLog(limit = 50) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM alert_log ORDER BY ts DESC LIMIT ?`).all(limit);
}

// ---- 감사 로그 (KILL / 설정변경 / 로그인) ----
function addAudit(usrId, action, target, detail) {
  if (!db) return;
  db.prepare(`INSERT INTO audit_log (ts,usr_id,action,target,detail) VALUES (?,?,?,?,?)`)
    .run(Date.now(), usrId || '-', action, target || null, detail || null);
}
function getAudit(limit = 100) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?`).all(limit);
}

// ---- 설정(런타임 임계치 등) ----
function getSetting(key) {
  if (!db) return null;
  const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  if (!db) return;
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, String(value));
}

// ---- 지표 구간 조회 (기준선 비교용) ----
function getMetricsBetween(from, to) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM metrics WHERE ts BETWEEN ? AND ? ORDER BY ts`).all(from, to).map((r) => ({
    t: r.ts, cpu: r.cpu, aas: r.aas, execs: r.execs, preads: r.preads, utxn: r.utxn, dbcpu: r.dbcpu,
    sessActive: r.sess_active, sessBlocked: r.sess_blocked, sessTotal: r.sess_total
  }));
}

// ---- AI 튜닝 캐시 & 호출 카운트 (비용 가드레일) ----
function getTuneCache(sqlId, maxAgeMs) {
  if (!db) return null;
  const r = db.prepare(`SELECT payload, ts FROM tune_cache WHERE sql_id = ?`).get(sqlId);
  if (!r) return null;
  if (maxAgeMs && (Date.now() - r.ts) > maxAgeMs) return null;
  try { return { payload: JSON.parse(r.payload), ts: r.ts }; } catch { return null; }
}
function setTuneCache(sqlId, obj) {
  if (!db) return;
  db.prepare(`INSERT OR REPLACE INTO tune_cache (sql_id, payload, ts) VALUES (?,?,?)`)
    .run(sqlId, JSON.stringify(obj), Date.now());
}
function addTuneCall(usrId) {
  if (!db) return;
  db.prepare(`INSERT INTO tune_calls (ts, usr_id) VALUES (?, ?)`).run(Date.now(), usrId || '-');
}
function tuneCallsSince(usrId, sinceTs) {
  if (!db) return 0;
  return db.prepare(`SELECT COUNT(*) c FROM tune_calls WHERE usr_id = ? AND ts >= ?`).get(usrId || '-', sinceTs).c;
}
function lastTuneCall(usrId) {
  if (!db) return 0;
  const r = db.prepare(`SELECT MAX(ts) m FROM tune_calls WHERE usr_id = ?`).get(usrId || '-');
  return (r && r.m) || 0;
}

// ---- 데드락 이력 (영구화: alert log 스캔이 느려 한 번 수집하면 SQLite 에 보관) ----
function insertDeadlocks(list) {
  if (!db || !list || !list.length) return 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO deadlocks (ts, t, trace) VALUES (?,?,?)`);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const d of list) { const r = stmt.run(d.ts, d.t, d.trace || null); added += r.changes || 0; }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
  return added;
}
function getDeadlocks(limit = 100) {
  if (!db) return [];
  return db.prepare(`SELECT ts, t, trace FROM deadlocks ORDER BY ts DESC LIMIT ?`).all(limit);
}

// ASH 히트맵: 구간을 buckets 개로 나눠 (버킷 × wait_class) 샘플 수 집계
function ashHeatmap(from, to, buckets = 48) {
  if (!db) return { bsize: 0, rows: [] };
  const bsize = Math.max(1000, Math.ceil(Math.max(1, to - from) / buckets));
  // node:sqlite 는 JS number 를 REAL 로 바인딩 → 정수 나눗셈이 안 되므로 CAST(.. AS INTEGER) 로 버킷 정렬
  const rows = db.prepare(
    `SELECT CAST(ts/? AS INTEGER)*? AS bucket, COALESCE(NULLIF(wait_class,''),'ON CPU') AS wc, COUNT(*) c
       FROM ash WHERE ts BETWEEN ? AND ?
      GROUP BY CAST(ts/? AS INTEGER), wc ORDER BY bucket`
  ).all(bsize, bsize, from, to, bsize);
  return { bsize, rows };
}

// ---- 테이블스페이스 사용량 시계열 (증가 예측용, 라이선스 프리 자체 수집) ----
function insertTsUsage(ts, rows) {
  if (!db || !rows || !rows.length) return;
  const stmt = db.prepare(`INSERT INTO ts_usage (ts, tablespace, used_mb, total_mb) VALUES (?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(ts, r.TABLESPACE_NAME, r.USED_MB, r.TOTAL_MB);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
}
function getTsSamples(tablespace, sinceTs) {
  if (!db) return [];
  return db.prepare(`SELECT ts, used_mb, total_mb FROM ts_usage WHERE tablespace = ? AND ts >= ? ORDER BY ts`)
    .all(tablespace, sinceTs);
}

// ---- 메모(주석) — scope('sql' 등) + ref(SQL_ID 등) 별 팀 메모 ----
function getNote(scope, ref) {
  if (!db) return null;
  return db.prepare(`SELECT scope, ref, note, usr_id, ts FROM notes WHERE scope = ? AND ref = ?`).get(scope, ref) || null;
}
function listNotes(scope) {
  if (!db) return [];
  return db.prepare(`SELECT ref, note, usr_id, ts FROM notes WHERE scope = ? ORDER BY ts DESC`).all(scope);
}
function setNote(scope, ref, note, usrId) {
  if (!db) return;
  const txt = String(note || '').trim();
  if (!txt) { db.prepare(`DELETE FROM notes WHERE scope = ? AND ref = ?`).run(scope, ref); return; }
  db.prepare(`INSERT OR REPLACE INTO notes (scope, ref, note, usr_id, ts) VALUES (?,?,?,?,?)`)
    .run(scope, ref, txt.slice(0, 2000), usrId || '-', Date.now());
}
function deleteNote(scope, ref) {
  if (!db) return;
  db.prepare(`DELETE FROM notes WHERE scope = ? AND ref = ?`).run(scope, ref);
}

// ---- 정리 ----
function prune() {
  if (!db) return;
  // 고빈도/캐시성 데이터는 RETAIN_DAYS(기본 7일)
  const cut = Date.now() - RETAIN_DAYS * 86400000;
  for (const t of ['ash', 'alert_log', 'tune_calls', 'tune_cache']) {
    try { db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cut); } catch (_) {}
  }
  // 감사 로그 · 블로킹 감지 이력 · CPU 스파이크 이력 · 데드락 · TS 사용량은 LOG_RETAIN_DAYS(기본 30일) 보관 후 삭제
  const logCut = Date.now() - LOG_RETAIN_DAYS * 86400000;
  for (const t of ['audit_log', 'lock_events', 'spike_events', 'deadlocks', 'ts_usage']) {
    try { db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(logCut); } catch (_) {}
  }
  // 기준선 비교(어제 vs 오늘)를 위해 metrics 는 최소 3일 보관
  const metricCut = Date.now() - Math.max(RETAIN_DAYS, 3) * 86400000;
  try { db.prepare(`DELETE FROM metrics WHERE ts < ?`).run(metricCut); } catch (_) {}
}

module.exports = {
  init, ok, insertMetric, getMetrics, getMetricsBetween, insertAsh, ashTopSql, ashTopEvents, ashTopSessions, ashTimeline,
  insertSpike, getSpikes, insertLock, getLocks,
  listRecipients, addRecipient, removeRecipient, logAlert, getAlertLog,
  addAudit, getAudit, getSetting, setSetting,
  getTuneCache, setTuneCache, addTuneCall, tuneCallsSince, lastTuneCall,
  insertDeadlocks, getDeadlocks, ashHeatmap, insertTsUsage, getTsSamples,
  getNote, listNotes, setNote, deleteNote, prune
};
