// =============================================================
//  ORAMON - 백그라운드 수집기
//  - 주기적으로 지표/세션/블로킹 샘플링 -> 링버퍼 (대시보드 차트용)
//  - CPU 스파이크 감지 -> 원인 스냅샷을 파일 로그로 기록
//  - 블로킹 락 감지     -> blocker/waiter SQL_ID 를 파일 로그로 기록
// =============================================================
const fs = require('fs');
const path = require('path');
const db = require('./db');
const Q = require('./queries');
const store = require('./store');
const mailer = require('./mailer');

const DATA_DIR = path.join(__dirname, 'data');
const SPIKE_LOG = path.join(DATA_DIR, 'spikes.log');
const LOCK_LOG = path.join(DATA_DIR, 'locks.log');

// 설정 (.env) — SAMPLE_MS/MAX_POINTS 는 고정, 임계치는 런타임 조정 가능
const SAMPLE_MS = parseInt(process.env.COLLECT_INTERVAL_MS || '10000', 10);
const MAX_POINTS = parseInt(process.env.HISTORY_POINTS || '1080', 10);   // 10s*1080 = 3시간
const th = {                                                            // 런타임 조정 가능한 임계치
  cpuSpike: parseFloat(process.env.CPU_SPIKE_PCT || '85'),               // CPU 스파이크(%)
  blockSec: parseInt(process.env.BLOCK_ALERT_SEC || '30', 10),           // 블로킹 이력(초)
  tsPct: parseFloat(process.env.TS_ALERT_PCT || '90')                    // 테이블스페이스 포화(%)
};
const TS_ALERT_COOLDOWN = 6 * 60 * 60 * 1000;                            // TS 알림 쿨다운(6시간)
let lastTsAlert = 0;

// 상태
const history = [];          // [{t, cpu, aas, execs, preads, utxn, dbcpu, sessActive, sessBlocked, sessTotal}]
let spikeState = null;       // 진행 중인 스파이크 {start, peak, ...}
const lockSeen = new Map();  // key(blocker,waiter) -> lastLoggedTs (중복 방지)
let blockingEnrichedOk = true; // dba_objects 접근 가능 여부 캐시
let timer = null;
let dlTimer = null;
let tsTimer = null;
let pruneTimer = null;

// 데드락(alert log) 백그라운드 캐시 — 스캔이 느려서 UI 를 막지 않도록 별도 보관
const DL_REFRESH_MS = parseInt(process.env.DEADLOCK_REFRESH_MS || '1800000', 10); // 30분
const deadlockCache = { list: [], fetchedAt: null, loading: false, error: null };

function ensureDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}
function appendLog(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch (e) { console.error('[collector] 로그 기록 실패:', e.message); }
}
// 파일 마지막 N줄 파싱
function tailJson(file, limit) {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// SQL 전문 조회 (알림용, 실패해도 무시)
async function fetchSqlText(sqlId) {
  if (!sqlId) return null;
  try {
    const rows = await db.query(Q.SQL_FULLTEXT, { sql_id: sqlId });
    return rows[0] ? rows[0].SQL_TEXT : null;
  } catch { return null; }
}

// 테이블스페이스 포화 체크 + 알림 (쿨다운)
async function checkTablespaces() {
  if (!mailer.isEnabled()) return;
  if (Date.now() - lastTsAlert < TS_ALERT_COOLDOWN) return;
  try {
    const rows = await db.query(Q.TABLESPACES);
    const over = rows.filter((r) => (r.USED_PCT || 0) >= th.tsPct);
    if (over.length) {
      lastTsAlert = Date.now();
      mailer.alertTablespace(over);
      console.log(`[collector] 📦 테이블스페이스 포화 알림: ${over.map((r) => r.TABLESPACE_NAME + ' ' + r.USED_PCT + '%').join(', ')}`);
    }
  } catch (_) { /* 권한 없으면 무시 */ }
}

async function getBlocking() {
  if (blockingEnrichedOk) {
    try { return await db.query(Q.BLOCKING_ENRICHED); }
    catch (e) { blockingEnrichedOk = false; console.warn('[collector] dba_objects 접근 불가 -> 간이 블로킹 쿼리 사용'); }
  }
  return db.query(Q.BLOCKING_SIMPLE).catch(() => []);
}

async function sample() {
  try {
    const [mrow] = await db.query(Q.METRIC_SNAPSHOT).catch(() => [{}]);
    const summary = (await db.query(Q.SESSION_SUMMARY).catch(() => [{}]))[0] || {};
    const m = mrow || {};
    const point = {
      t: Date.now(),
      cpu: m.CPU ?? null, aas: m.AAS ?? null, execs: m.EXECS ?? null,
      preads: m.PREADS ?? null, utxn: m.UTXN ?? null, dbcpu: m.DBCPU ?? null,
      sessActive: summary.ACTIVE ?? null, sessBlocked: summary.BLOCKED ?? null, sessTotal: summary.TOTAL ?? null
    };
    history.push(point);
    if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);
    store.insertMetric(point);

    // ASH: 현재 활성 USER 세션 스냅샷 저장 (라이선스 프리 자체 ASH)
    try {
      const active = await db.query(Q.ASH_SAMPLE);
      store.insertAsh(point.t, active);
    } catch (e) { console.error('[collector] ASH 샘플 실패:', e.message); }

    await detectSpike(point);
    await detectBlocking();
  } catch (e) {
    console.error('[collector] 샘플 실패:', e.message);
  }
}

// ---- CPU 스파이크 감지 ----
async function detectSpike(point) {
  const cpu = point.cpu;
  if (cpu == null) return;

  if (cpu >= th.cpuSpike) {
    if (!spikeState) {
      // 스파이크 시작 -> 원인 스냅샷 캡처
      const active = await db.query(Q.ACTIVE_SNAPSHOT).catch(() => []);
      // sql_id 별 활성 세션 수 집계 (원인 SQL 추정)
      const bySql = {};
      for (const s of active) {
        const k = s.SQL_ID || '(no sql)';
        bySql[k] = bySql[k] || { sql_id: s.SQL_ID, count: 0, sample_text: s.SQL_TEXT, event: s.EVENT };
        bySql[k].count++;
      }
      const topSql = Object.values(bySql).sort((a, b) => b.count - a.count).slice(0, 8);
      spikeState = { start: point.t, peak: cpu, peakAt: point.t };
      const event = {
        ts: point.t,
        started: new Date(point.t).toISOString(),
        cpu: cpu,
        aas: point.aas,
        activeSessions: active.length,
        topSql,
        sessions: active.slice(0, 20)
      };
      appendLog(SPIKE_LOG, event);
      store.insertSpike(event);
      console.log(`[collector] ⚠ CPU 스파이크 감지: ${cpu}% (활성 ${active.length}, top SQL ${topSql[0] ? topSql[0].sql_id : '-'})`);
      // 이메일 알림 (원인 SQL 전문 포함)
      if (mailer.isEnabled()) {
        const sqlText = await fetchSqlText(topSql[0] && topSql[0].sql_id);
        mailer.alertSpike(event, sqlText);
      }
    } else if (cpu > spikeState.peak) {
      spikeState.peak = cpu; spikeState.peakAt = point.t;
    }
  } else if (cpu < th.cpuSpike - 10 && spikeState) {
    // 스파이크 해제 -> 지속시간/피크를 마지막 이벤트에 후행 기록
    appendLog(SPIKE_LOG, {
      ts: point.t, resolve: true, of: spikeState.start,
      peak: spikeState.peak, durationSec: Math.round((point.t - spikeState.start) / 1000)
    });
    console.log(`[collector] ✓ CPU 스파이크 해제: 피크 ${spikeState.peak}%, ${Math.round((point.t - spikeState.start) / 1000)}초`);
    spikeState = null;
  }
}

// ---- 블로킹 락 감지 ----
async function detectBlocking() {
  const rows = await getBlocking();
  const now = Date.now();
  for (const r of rows) {
    if ((r.WAIT_SEC || 0) < th.blockSec) continue;
    const key = `${r.BLOCKER_SID}:${r.WAITER_SID}`;
    const last = lockSeen.get(key) || 0;
    if (now - last < 5 * 60 * 1000) continue; // 같은 조합은 5분에 한 번만 기록
    lockSeen.set(key, now);
    const event = {
      ts: now, detected: new Date(now).toISOString(),
      wait_sec: r.WAIT_SEC,
      waiter: { sid: r.WAITER_SID, serial: r.WAITER_SERIAL, user: r.WAITER_USER, sql_id: r.WAITER_SQL, event: r.WAITER_EVENT },
      blocker: { sid: r.BLOCKER_SID, serial: r.BLOCKER_SERIAL, user: r.BLOCKER_USER, sql_id: r.BLOCKER_SQL, status: r.BLOCKER_STATUS, machine: r.BLOCKER_MACHINE, program: r.BLOCKER_PROGRAM },
      locked_obj: r.LOCKED_OBJ || null
    };
    appendLog(LOCK_LOG, event);
    store.insertLock(event);
    console.log(`[collector] ⛔ 블로킹 감지: blocker ${r.BLOCKER_SID} (${r.BLOCKER_SQL}) -> waiter ${r.WAITER_SID} (${r.WAITER_SQL}), ${r.WAIT_SEC}s`);
    // 이메일 알림 (blocker SQL 전문 포함)
    if (mailer.isEnabled()) {
      const sqlText = await fetchSqlText(r.BLOCKER_SQL);
      mailer.alertBlock(event, sqlText);
    }
  }
  // 오래된 lockSeen 정리
  for (const [k, v] of lockSeen) if (now - v > 30 * 60 * 1000) lockSeen.delete(k);
}

// ---- 데드락(alert log) 백그라운드 수집 ----
async function fetchDeadlocks() {
  if (deadlockCache.loading) return;
  deadlockCache.loading = true;
  try {
    const rows = await db.query(Q.DEADLOCKS, {}, { callTimeout: 90000 }); // 느림(수십초) — 90초 넘으면 취소
    // 최신순 정렬 후 상위 100
    rows.sort((a, b) => (b.TS instanceof Date ? b.TS.getTime() : 0) - (a.TS instanceof Date ? a.TS.getTime() : 0));
    deadlockCache.list = rows.slice(0, 100).map((r) => {
      const m = /More info in file (\S+)/.exec(r.MESSAGE_TEXT || '');
      return { t: r.T, trace: m ? m[1] : null };
    });
    deadlockCache.fetchedAt = Date.now();
    deadlockCache.error = null;
    console.log(`[collector] 데드락 이력 수집 완료: ${deadlockCache.list.length}건 (최신 ${deadlockCache.list[0] ? deadlockCache.list[0].t : '-'})`);
  } catch (e) {
    deadlockCache.error = e.message;
    console.warn('[collector] 데드락 이력 수집 실패:', e.message);
  } finally {
    deadlockCache.loading = false;
  }
}
function getDeadlocks() { return deadlockCache; }
function refreshDeadlocks() { fetchDeadlocks(); return deadlockCache; }

// ---- 공개 API ----
function start() {
  ensureDir();
  if (timer) return;
  loadThresholds(); // SQLite 에 저장된 임계치 override 반영
  sample(); // 즉시 1회
  timer = setInterval(sample, SAMPLE_MS);
  // 데드락 이력은 시작 5초 뒤 1회 + 주기적으로 (백그라운드)
  setTimeout(fetchDeadlocks, 5000);
  dlTimer = setInterval(fetchDeadlocks, DL_REFRESH_MS);
  // 테이블스페이스 포화 체크(5분) + 오래된 데이터 정리(1시간)
  tsTimer = setInterval(checkTablespaces, 5 * 60 * 1000);
  setTimeout(checkTablespaces, 20000);
  pruneTimer = setInterval(() => store.prune(), 60 * 60 * 1000);
  console.log(`[collector] 시작: ${SAMPLE_MS}ms 주기, CPU 스파이크 ${th.cpuSpike}%, 블로킹 ${th.blockSec}s, TS 알림 ${th.tsPct}%`);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (dlTimer) { clearInterval(dlTimer); dlTimer = null; }
  if (tsTimer) { clearInterval(tsTimer); tsTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}
function getHistory(limit) {
  // SQLite 우선(재시작에도 유지), 없으면 메모리
  if (store.ok()) {
    const rows = store.getMetrics();
    return limit ? rows.slice(-limit) : rows;
  }
  return limit ? history.slice(-limit) : history.slice();
}
function getCpuEvents(limit = 100) { return store.ok() ? store.getSpikes(limit) : tailJson(SPIKE_LOG, limit); }
function getLockEvents(limit = 100) { return store.ok() ? store.getLocks(limit) : tailJson(LOCK_LOG, limit); }
function getConfig() {
  return { SAMPLE_MS, MAX_POINTS, CPU_SPIKE_PCT: th.cpuSpike, BLOCK_SEC: th.blockSec, TS_ALERT_PCT: th.tsPct };
}
// 런타임 임계치 조정 + SQLite 영구화
function setThresholds(o) {
  if (o.cpuSpike != null && !isNaN(o.cpuSpike)) th.cpuSpike = Math.max(1, Math.min(100, +o.cpuSpike));
  if (o.blockSec != null && !isNaN(o.blockSec)) th.blockSec = Math.max(1, +o.blockSec);
  if (o.tsPct != null && !isNaN(o.tsPct)) th.tsPct = Math.max(1, Math.min(100, +o.tsPct));
  store.setSetting('thresholds', JSON.stringify({ cpuSpike: th.cpuSpike, blockSec: th.blockSec, tsPct: th.tsPct }));
  return getConfig();
}
function loadThresholds() {
  try {
    const s = store.getSetting('thresholds');
    if (s) Object.assign(th, JSON.parse(s));
  } catch (_) {}
}

module.exports = {
  start, stop, getHistory, getCpuEvents, getLockEvents, getBlocking, getConfig,
  getDeadlocks, refreshDeadlocks, setThresholds
};
