// =============================================================
//  ORAMON - Oracle 11g 모니터링 SQL 모음
//  모든 쿼리는 SELECT 전용, Oracle 11g 문법 (ROWNUM, no FETCH FIRST)
// =============================================================

// 인스턴스 / DB 기본 정보
const INSTANCE = `
  SELECT i.instance_name,
         i.host_name,
         i.version,
         i.status,
         i.database_status,
         TO_CHAR(i.startup_time, 'YYYY-MM-DD HH24:MI:SS') AS startup_time,
         ROUND((SYSDATE - i.startup_time), 1) AS uptime_days
    FROM v$instance i`;

// v$database (권한 없으면 앱에서 graceful 처리)
const DATABASE = `
  SELECT name AS db_name,
         open_mode,
         log_mode,
         database_role,
         TO_CHAR(created, 'YYYY-MM-DD') AS created
    FROM v$database`;

// 핵심 성능 지표 (group_id=2 : 60초 롱 인터벌, 중복 없음)
const SYSMETRICS = `
  SELECT metric_name, ROUND(value, 2) AS value, metric_unit
    FROM v$sysmetric
   WHERE group_id = 2
     AND metric_name IN (
       'Host CPU Utilization (%)',
       'Database CPU Time Ratio',
       'Average Active Sessions',
       'Executions Per Sec',
       'User Transaction Per Sec',
       'Physical Reads Per Sec',
       'Physical Writes Per Sec',
       'Logons Per Sec',
       'Current OS Load',
       'Buffer Cache Hit Ratio',
       'Library Cache Hit Ratio',
       'SQL Service Response Time',
       'Database Time Per Sec',
       'Redo Generated Per Sec'
     )`;

// 세션 요약 카운트
const SESSION_SUMMARY = `
  SELECT COUNT(*)                                          AS total,
         SUM(CASE WHEN status = 'ACTIVE'   THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END) AS inactive,
         SUM(CASE WHEN username IS NOT NULL THEN 1 ELSE 0 END) AS user_sessions,
         SUM(CASE WHEN blocking_session IS NOT NULL THEN 1 ELSE 0 END) AS blocked
    FROM v$session`;

// 세션 목록. :show_bg 가 'Y' 면 백그라운드 포함
const SESSIONS = `
  SELECT * FROM (
    SELECT s.sid,
           s.serial#              AS serial,
           s.username,
           s.status,
           s.osuser,
           s.machine,
           s.program,
           s.type,
           s.event,
           s.wait_class,
           s.seconds_in_wait      AS wait_sec,
           s.blocking_session     AS blocker,
           s.sql_id,
           s.module,
           s.action,
           s.last_call_et         AS last_call_et,
           TO_CHAR(s.logon_time, 'YYYY-MM-DD HH24:MI:SS') AS logon_time
      FROM v$session s
     WHERE (s.username IS NOT NULL OR :show_bg = 'Y')
     ORDER BY CASE WHEN s.status = 'ACTIVE' THEN 0 ELSE 1 END,
              CASE WHEN s.blocking_session IS NOT NULL THEN 0 ELSE 1 END,
              s.last_call_et DESC
  ) WHERE ROWNUM <= 300`;

// Top SQL (누적 elapsed 기준)
const TOP_SQL = `
  SELECT * FROM (
    SELECT sql_id,
           executions,
           ROUND(elapsed_time / 1000000, 2)                                  AS elapsed_sec,
           ROUND(elapsed_time / 1000000 / DECODE(executions, 0, 1, executions), 4) AS sec_per_exec,
           ROUND(cpu_time / 1000000, 2)                                      AS cpu_sec,
           buffer_gets,
           disk_reads,
           rows_processed,
           parsing_schema_name                                              AS schema,
           SUBSTR(TRIM(sql_text), 1, 300)                                   AS sql_text
      FROM v$sqlarea
     WHERE executions > 0
     ORDER BY elapsed_time DESC
  ) WHERE ROWNUM <= 30`;

// 특정 sql_id 전체 텍스트
const SQL_FULLTEXT = `
  SELECT sql_fulltext AS sql_text
    FROM v$sqlarea
   WHERE sql_id = :sql_id AND ROWNUM = 1`;

// 시스템 대기 클래스 (Idle 제외, 누적)
const WAIT_CLASS = `
  SELECT * FROM (
    SELECT wait_class,
           total_waits,
           ROUND(time_waited / 100, 1)                                       AS time_waited_sec,
           ROUND(time_waited / DECODE(total_waits, 0, 1, total_waits) * 10, 2) AS avg_ms
      FROM v$system_wait_class
     WHERE wait_class <> 'Idle'
     ORDER BY time_waited DESC
  ) WHERE ROWNUM <= 12`;

// 현재 대기중인 활성 세션의 대기 이벤트 Top
const ACTIVE_WAITS = `
  SELECT * FROM (
    SELECT s.event,
           s.wait_class,
           COUNT(*)                 AS sessions,
           ROUND(AVG(s.seconds_in_wait), 1) AS avg_wait_sec
      FROM v$session s
     WHERE s.status = 'ACTIVE'
       AND s.wait_class <> 'Idle'
       AND s.event IS NOT NULL
     GROUP BY s.event, s.wait_class
     ORDER BY COUNT(*) DESC, AVG(s.seconds_in_wait) DESC
  ) WHERE ROWNUM <= 15`;

// 블로킹 트리 (blocker → waiter)
const BLOCKING = `
  SELECT w.sid            AS waiter_sid,
         w.serial#        AS waiter_serial,
         w.username       AS waiter_user,
         w.event          AS waiter_event,
         w.seconds_in_wait AS wait_sec,
         w.sql_id         AS waiter_sql,
         b.sid            AS blocker_sid,
         b.serial#        AS blocker_serial,
         b.username       AS blocker_user,
         b.status         AS blocker_status
    FROM v$session w
    JOIN v$session b ON w.blocking_session = b.sid
   WHERE w.blocking_session IS NOT NULL`;

// 테이블스페이스 사용률 (DBA_ 뷰 권한 필요 - 없으면 앱에서 graceful 처리)
const TABLESPACES = `
  SELECT df.tablespace_name,
         ROUND(df.total_bytes / 1024 / 1024, 0)                    AS total_mb,
         ROUND((df.total_bytes - NVL(fs.free_bytes, 0)) / 1024 / 1024, 0) AS used_mb,
         ROUND(NVL(fs.free_bytes, 0) / 1024 / 1024, 0)             AS free_mb,
         ROUND((df.total_bytes - NVL(fs.free_bytes, 0)) / df.total_bytes * 100, 1) AS used_pct
    FROM (SELECT tablespace_name, SUM(bytes) AS total_bytes
            FROM dba_data_files GROUP BY tablespace_name) df,
         (SELECT tablespace_name, SUM(bytes) AS free_bytes
            FROM dba_free_space GROUP BY tablespace_name) fs
   WHERE df.tablespace_name = fs.tablespace_name(+)
   ORDER BY used_pct DESC`;

// 지표 시계열 (최근 ~1시간, 분당 1포인트). sparkline 용
const METRIC_HISTORY = `
  SELECT metric_name,
         TO_CHAR(end_time, 'HH24:MI') AS t,
         ROUND(value, 2)              AS value
    FROM v$sysmetric_history
   WHERE metric_name IN (
     'Host CPU Utilization (%)',
     'Average Active Sessions',
     'Executions Per Sec',
     'User Transaction Per Sec',
     'Physical Reads Per Sec',
     'Database CPU Time Ratio'
   )
   ORDER BY metric_name, end_time`;

// SQL 실행계획 (가장 낮은 child_number 커서 기준)
const SQL_PLAN = `
  SELECT id,
         depth,
         LPAD(' ', depth * 2, ' ') || operation
           || DECODE(options, NULL, '', ' ' || options) AS op,
         object_owner,
         object_name,
         cost,
         cardinality,
         bytes,
         access_predicates,
         filter_predicates
    FROM v$sql_plan
   WHERE sql_id = :sql_id
     AND child_number = (SELECT MIN(child_number) FROM v$sql_plan WHERE sql_id = :sql_id)
   ORDER BY id`;

// 진행 중/최근 대형 작업 (RMAN, 인덱스 빌드, 대량 정렬 등)
const LONGOPS = `
  SELECT * FROM (
    SELECT sid,
           serial#                                       AS serial,
           username,
           opname,
           target,
           sofar,
           totalwork,
           units,
           ROUND(sofar / NULLIF(totalwork, 0) * 100, 1)  AS pct,
           time_remaining,
           elapsed_seconds,
           TO_CHAR(start_time, 'HH24:MI:SS')             AS start_t,
           sql_id
      FROM v$session_longops
     WHERE totalwork > 0
     ORDER BY DECODE(NVL(time_remaining, 0), 0, 1, 0),  -- 진행중(남은시간>0) 먼저
              start_time DESC
  ) WHERE ROWNUM <= 30`;

// 수집기용 지표 스냅샷 (한 행에 주요 지표)
const METRIC_SNAPSHOT = `
  SELECT
    MAX(DECODE(metric_name, 'Host CPU Utilization (%)',  ROUND(value, 2))) AS cpu,
    MAX(DECODE(metric_name, 'Average Active Sessions',   ROUND(value, 2))) AS aas,
    MAX(DECODE(metric_name, 'Executions Per Sec',        ROUND(value, 2))) AS execs,
    MAX(DECODE(metric_name, 'Physical Reads Per Sec',    ROUND(value, 2))) AS preads,
    MAX(DECODE(metric_name, 'User Transaction Per Sec',  ROUND(value, 2))) AS utxn,
    MAX(DECODE(metric_name, 'Database CPU Time Ratio',   ROUND(value, 2))) AS dbcpu
  FROM v$sysmetric WHERE group_id = 2`;

// CPU 스파이크 순간 스냅샷: 활성 세션 + 실행 중 SQL
const ACTIVE_SNAPSHOT = `
  SELECT * FROM (
    SELECT s.sid,
           s.serial#           AS serial,
           s.username,
           s.sql_id,
           s.event,
           s.wait_class,
           s.last_call_et,
           s.machine,
           s.program,
           SUBSTR(a.sql_text, 1, 160) AS sql_text
      FROM v$session s
      LEFT JOIN v$sqlarea a ON s.sql_id = a.sql_id
     WHERE s.status = 'ACTIVE' AND s.type = 'USER'
     ORDER BY DECODE(s.wait_class, 'Idle', 1, 0), s.last_call_et
  ) WHERE ROWNUM <= 25`;

// 블로킹 (락 대상 객체 포함) — dba_objects 권한 필요
const BLOCKING_ENRICHED = `
  SELECT w.sid            AS waiter_sid,
         w.serial#        AS waiter_serial,
         w.username       AS waiter_user,
         w.sql_id         AS waiter_sql,
         w.event          AS waiter_event,
         w.seconds_in_wait AS wait_sec,
         o.object_name    AS locked_obj,
         b.sid            AS blocker_sid,
         b.serial#        AS blocker_serial,
         b.username       AS blocker_user,
         b.status         AS blocker_status,
         NVL(b.sql_id, b.prev_sql_id) AS blocker_sql,
         b.machine        AS blocker_machine,
         b.program        AS blocker_program
    FROM v$session w
    JOIN v$session b ON w.blocking_session = b.sid
    LEFT JOIN dba_objects o ON w.row_wait_obj# = o.object_id
   WHERE w.blocking_session IS NOT NULL`;

// 블로킹 fallback (dba_objects 권한 없을 때)
const BLOCKING_SIMPLE = `
  SELECT w.sid            AS waiter_sid,
         w.serial#        AS waiter_serial,
         w.username       AS waiter_user,
         w.sql_id         AS waiter_sql,
         w.event          AS waiter_event,
         w.seconds_in_wait AS wait_sec,
         NULL             AS locked_obj,
         b.sid            AS blocker_sid,
         b.serial#        AS blocker_serial,
         b.username       AS blocker_user,
         b.status         AS blocker_status,
         NVL(b.sql_id, b.prev_sql_id) AS blocker_sql,
         b.machine        AS blocker_machine,
         b.program        AS blocker_program
    FROM v$session w
    JOIN v$session b ON w.blocking_session = b.sid
   WHERE w.blocking_session IS NOT NULL`;

// 실제 데드락 이력 (alert log의 ORA-00060)
//   주의: v$diag_alert_ext 는 alert log(XML) 전체를 파싱하므로 느립니다(수십초).
//   그래서 ROWNUM 을 WHERE 절에 두어 N건 찾으면 즉시 멈추게 하고(정렬 없음),
//   최신순 정렬은 수집기(collector)가 JS 에서 처리 + 백그라운드 캐시로 UI 를 막지 않습니다.
//   30일 보관 필터는 수집기(collector)가 JS 에서 적용합니다 — ROWNUM 조기 종료를 유지해
//   느린 alert log 전체 스캔을 피하기 위함(SQL 에 날짜 predicate 를 넣으면 조기 종료가 무력화됨).
const DEADLOCKS = `
  SELECT TO_CHAR(originating_timestamp, 'YYYY-MM-DD HH24:MI:SS') AS t,
         originating_timestamp AS ts,
         message_text
    FROM v$diag_alert_ext
   WHERE message_text LIKE '%ORA-00060%'
     AND ROWNUM <= 50`;

// ASH 샘플: 현재 활성 USER 세션 전부 (수집기가 매 tick 저장)
const ASH_SAMPLE = `
  SELECT s.sid,
         s.serial#     AS serial,
         s.username,
         s.sql_id,
         s.event,
         s.wait_class,
         s.machine,
         s.program
    FROM v$session s
   WHERE s.status = 'ACTIVE' AND s.type = 'USER' AND s.username IS NOT NULL`;

// 아카이브 로그 생성률 (최근 24시간, 시간별)
const ARCHIVE_LOG_RATE = `
  SELECT TO_CHAR(completion_time, 'MM-DD HH24') AS hr,
         COUNT(*)                               AS logs,
         ROUND(SUM(blocks * block_size) / 1024 / 1024, 1) AS mb
    FROM v$archived_log
   WHERE completion_time > SYSDATE - 1
   GROUP BY TO_CHAR(completion_time, 'MM-DD HH24')
   ORDER BY hr`;

// 세그먼트 Top 공간 소비
const TOP_SEGMENTS = `
  SELECT * FROM (
    SELECT owner, segment_name, segment_type, tablespace_name,
           ROUND(bytes / 1024 / 1024, 1) AS mb
      FROM dba_segments
     ORDER BY bytes DESC
  ) WHERE ROWNUM <= 30`;

// 세션 상세 (단건)
const SESSION_ROW = `
  SELECT sid, serial# AS serial, username, status, osuser, machine, program,
         module, action, type, server, service_name,
         TO_CHAR(logon_time, 'YYYY-MM-DD HH24:MI:SS') AS logon_time,
         last_call_et, sql_id, prev_sql_id, event, wait_class, seconds_in_wait,
         blocking_session, row_wait_obj#, logon_time
    FROM v$session WHERE sid = :sid AND ROWNUM = 1`;

// 세션 통계 (v$sesstat + v$statname)
const SESSION_STAT = `
  SELECT n.name, s.value
    FROM v$sesstat s JOIN v$statname n ON s.statistic# = n.statistic#
   WHERE s.sid = :sid
     AND n.name IN ('session logical reads','physical reads','session pga memory',
                    'session uga memory','CPU used by this session','db block gets',
                    'consistent gets','execute count','parse count (total)',
                    'user commits','sorts (memory)','sorts (disk)','table scans (long tables)')
   ORDER BY n.name`;

// 로그인 인증: 부서 212003 활성 사용자 + 비밀번호(CRYPTO_DECRYPT)를 SQL 내에서 bind 로 비교.
//   앱은 복호화된 비밀번호를 절대 전달받지 않는다. 일치 시 USR_ID 1행 반환, 불일치 시 0행.
const AUTH_LOGIN = `
  SELECT U.USR_ID
    FROM T_USR U, T_EMP E
   WHERE U.USR_ID = E.EMP_ID
     AND E.DEPT_CD = '212003'
     AND U.USE_YN = 'Y'
     AND UPPER(U.USR_ID) = UPPER(:usr_id)
     AND CRYPTO_DECRYPT(U.PWD) = :pw
     AND ROWNUM = 1`;

// ---- AI 튜닝 제안용 스키마 컨텍스트 ----
// 특정 SQL 실행 통계
const SQLSTAT_BY_ID = `
  SELECT executions,
         ROUND(elapsed_time / 1000000, 2) AS elapsed_sec,
         ROUND(elapsed_time / 1000000 / DECODE(executions, 0, 1, executions), 4) AS sec_per_exec,
         ROUND(cpu_time / 1000000, 2) AS cpu_sec,
         buffer_gets, disk_reads, rows_processed, parsing_schema_name
    FROM v$sqlarea WHERE sql_id = :sql_id AND ROWNUM = 1`;

// 실행계획에 등장하는 실제 테이블(인덱스 제외)
const PLAN_TABLES = `
  SELECT DISTINCT object_owner, object_name
    FROM v$sql_plan
   WHERE sql_id = :sql_id
     AND object_owner IS NOT NULL
     AND object_type LIKE 'TABLE%'`;

// 테이블 컬럼 (dba_ → 권한 없으면 all_ fallback 은 advisor 에서 처리)
const TABLE_COLUMNS = `
  SELECT column_name, data_type, data_length, data_precision, data_scale, nullable
    FROM dba_tab_columns
   WHERE owner = :owner AND table_name = :tbl
   ORDER BY column_id`;
const TABLE_COLUMNS_ALL = `
  SELECT column_name, data_type, data_length, data_precision, data_scale, nullable
    FROM all_tab_columns
   WHERE owner = :owner AND table_name = :tbl
   ORDER BY column_id`;

// 테이블 인덱스 (컬럼 리스트 포함)
const TABLE_INDEXES = `
  SELECT i.index_name, i.uniqueness,
         LISTAGG(c.column_name, ',') WITHIN GROUP (ORDER BY c.column_position) AS cols
    FROM dba_indexes i
    JOIN dba_ind_columns c ON i.owner = c.index_owner AND i.index_name = c.index_name
   WHERE i.table_owner = :owner AND i.table_name = :tbl
   GROUP BY i.index_name, i.uniqueness`;
const TABLE_INDEXES_ALL = `
  SELECT i.index_name, i.uniqueness,
         LISTAGG(c.column_name, ',') WITHIN GROUP (ORDER BY c.column_position) AS cols
    FROM all_indexes i
    JOIN all_ind_columns c ON i.owner = c.index_owner AND i.index_name = c.index_name
   WHERE i.table_owner = :owner AND i.table_name = :tbl
   GROUP BY i.index_name, i.uniqueness`;

// 테이블 통계
const TABLE_STATS = `
  SELECT num_rows, blocks, TO_CHAR(last_analyzed, 'YYYY-MM-DD') AS last_analyzed
    FROM dba_tables WHERE owner = :owner AND table_name = :tbl`;
const TABLE_STATS_ALL = `
  SELECT num_rows, blocks, TO_CHAR(last_analyzed, 'YYYY-MM-DD') AS last_analyzed
    FROM all_tables WHERE owner = :owner AND table_name = :tbl`;

module.exports = {
  INSTANCE, DATABASE, SYSMETRICS, SESSION_SUMMARY, SESSIONS,
  TOP_SQL, SQL_FULLTEXT, WAIT_CLASS, ACTIVE_WAITS, BLOCKING, TABLESPACES,
  METRIC_HISTORY, SQL_PLAN, LONGOPS,
  METRIC_SNAPSHOT, ACTIVE_SNAPSHOT, BLOCKING_ENRICHED, BLOCKING_SIMPLE, DEADLOCKS,
  ASH_SAMPLE, ARCHIVE_LOG_RATE, TOP_SEGMENTS, SESSION_ROW, SESSION_STAT,
  AUTH_LOGIN,
  SQLSTAT_BY_ID, PLAN_TABLES, TABLE_COLUMNS, TABLE_COLUMNS_ALL,
  TABLE_INDEXES, TABLE_INDEXES_ALL, TABLE_STATS, TABLE_STATS_ALL
};
