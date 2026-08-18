// =============================================================
//  ORAMON - Oracle 커넥션 풀 (oracledb Thick 모드)
//  Oracle 11g 는 Thin 모드 미지원 -> Instant Client 필수
// =============================================================
const oracledb = require('oracledb');

let initialized = false;
let poolReady = false;

// 결과를 {컬럼:값} 객체 배열로 받기
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB]; // CLOB(sql_fulltext 등) 문자열로

// SID 방식 접속 문자열 구성
function buildConnectString() {
  const { DB_HOST, DB_PORT, DB_SID } = process.env;
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${DB_HOST})(PORT=${DB_PORT}))` +
         `(CONNECT_DATA=(SID=${DB_SID})))`;
}

// 커넥션마다 ORAMON 표식 남기기 (top SQL 에서 자기 자신 필터링용)
async function sessionCallback(conn, requestedTag, cb) {
  try {
    await conn.execute(
      `BEGIN DBMS_APPLICATION_INFO.SET_MODULE('ORAMON', 'monitor'); END;`
    );
  } catch (_) { /* 권한/환경 문제여도 무시 */ }
  cb();
}

async function init() {
  if (initialized) return;

  // Thick 모드 활성화 (Instant Client 경로)
  const libDir = process.env.ORACLE_CLIENT_PATH;
  try {
    if (libDir) {
      oracledb.initOracleClient({ libDir });
    } else {
      oracledb.initOracleClient();
    }
  } catch (e) {
    // 이미 초기화된 경우(재시작 아님) 외의 에러는 그대로 던짐
    if (!/already been initialized/i.test(e.message)) {
      throw new Error(`Instant Client 초기화 실패 (ORACLE_CLIENT_PATH 확인): ${e.message}`);
    }
  }

  await oracledb.createPool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectString: buildConnectString(),
    poolMin: parseInt(process.env.POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.POOL_MAX || '8', 10),
    poolIncrement: 1,
    poolTimeout: 60,
    poolPingInterval: 60,   // 유휴 커넥션을 꺼내기 전 ping → 끊긴 커넥션 자동 폐기
    queueTimeout: 30000,    // 풀 고갈 시 30초 대기 후 실패(무한 대기 방지)
    sessionCallback
  });

  initialized = true;
  poolReady = true;
}

// 기동 시 접속 실패해도 계속 재시도 (리스너 늦게 뜨는 경우 대비)
async function initWithRetry(onConnect) {
  let delay = 3000;
  for (;;) {
    try {
      await init();
      await ping();
      console.log('[db] Oracle 접속 성공');
      if (onConnect) onConnect();
      return;
    } catch (e) {
      console.error(`[db] 접속 실패 (${Math.round(delay / 1000)}초 후 재시도): ${e.message}`);
      initialized = false; poolReady = false;
      try { await oracledb.getPool().close(0); } catch (_) {}
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 30000);
    }
  }
}

// SELECT 실행 헬퍼. 항상 커넥션을 풀에 반납한다.
//   opts.callTimeout(ms) 를 주면 오래 걸리는 쿼리를 강제 취소한다(예: alert log 스캔).
async function query(sql, binds = {}, opts = {}) {
  const conn = await oracledb.getConnection();
  try {
    if (opts.callTimeout) conn.callTimeout = opts.callTimeout;
    const result = await conn.execute(sql, binds, opts);
    return result.rows || [];
  } finally {
    try { await conn.close(); } catch (_) { /* noop */ }
  }
}

// SELECT 이외(ALTER SYSTEM 등) 실행. 개입(KILL) 전용.
async function exec(sql, binds = {}) {
  const conn = await oracledb.getConnection();
  try {
    await conn.execute(sql, binds);
    return true;
  } finally {
    try { await conn.close(); } catch (_) { /* noop */ }
  }
}

// 접속 상태 점검 (SELECT 1)
async function ping() {
  const rows = await query(`SELECT 1 AS ok FROM dual`);
  return rows.length > 0;
}

async function close() {
  if (poolReady) {
    try { await oracledb.getPool().close(5); } catch (_) { /* noop */ }
    poolReady = false;
  }
}

function isReady() { return poolReady; }

module.exports = { init, initWithRetry, query, exec, ping, close, isReady, buildConnectString };
