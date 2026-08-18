//! v$뷰 조회 SQL 들. 각 함수는 spawn_blocking 안에서 도는 걸 가정한다.
//!
//! 11g EE 기준. RAC 대응 위해 v$ → gv$ 로 전환하는 옵션은 추후 추가.

use anyhow::Result;
use chrono::{TimeZone, Utc};
use oramon_core::model::{DbBanner, SessionRow};

pub fn fetch_banner(conn: &oracle::Connection) -> Result<DbBanner> {
    let sql = "
        SELECT i.instance_name,
               i.host_name,
               i.version,
               i.startup_time,
               d.database_role,
               (SELECT banner FROM v$version WHERE ROWNUM = 1) AS full_banner
          FROM v$instance i, v$database d
    ";
    let mut stmt = conn.statement(sql).build()?;
    let row = stmt.query_row(&[])?;

    let instance_name: String = row.get("INSTANCE_NAME")?;
    let host_name: String     = row.get("HOST_NAME")?;
    let version: String       = row.get("VERSION")?;
    let startup_time: chrono::NaiveDateTime = row.get("STARTUP_TIME")?;
    let database_role: String = row.get("DATABASE_ROLE")?;
    let full_banner: String   = row.get("FULL_BANNER")?;

    let edition = if full_banner.contains("Enterprise") { "EE" }
                  else if full_banner.contains("Standard") { "SE" }
                  else { "?" }.to_string();

    Ok(DbBanner {
        instance_name,
        host_name,
        version,
        edition,
        startup_time: Utc.from_utc_datetime(&startup_time),
        database_role,
    })
}

pub fn fetch_sessions(conn: &oracle::Connection, limit: u32) -> Result<Vec<SessionRow>> {
    // 자기 자신(ORAMON) 은 제외. 진짜 유저 세션만.
    // 주의: Oracle 11g 는 FETCH FIRST 미지원 → ROWNUM 으로 상한 처리.
    let sql = "
        SELECT * FROM (
            SELECT s.sid,
                   s.serial#          AS serial_no,
                   s.inst_id,
                   s.username,
                   s.status,
                   s.osuser,
                   s.machine,
                   s.program,
                   s.module,
                   s.sql_id,
                   s.event,
                   s.wait_class,
                   s.blocking_session,
                   s.logon_time
              FROM gv$session s
             WHERE s.type = 'USER'
               AND NVL(s.module, ' ') <> 'ORAMON'
             ORDER BY DECODE(s.status,'ACTIVE',0,1),
                      s.last_call_et DESC
        ) WHERE ROWNUM <= :lim
    ";

    let mut stmt = conn.statement(sql).build()?;
    let rows = stmt.query(&[&limit])?;

    let mut out = Vec::new();
    for r in rows {
        let r = r?;
        let logon: Option<chrono::NaiveDateTime> = r.get("LOGON_TIME").ok();
        out.push(SessionRow {
            sid:              r.get::<_, u32>("SID")?,
            serial:           r.get::<_, u32>("SERIAL_NO")?,
            inst_id:          r.get::<_, u32>("INST_ID")?,
            username:         r.get("USERNAME").ok(),
            status:           r.get("STATUS")?,
            osuser:           r.get("OSUSER").ok(),
            machine:          r.get("MACHINE").ok(),
            program:          r.get("PROGRAM").ok(),
            module:           r.get("MODULE").ok(),
            sql_id:           r.get("SQL_ID").ok(),
            event:            r.get("EVENT").ok(),
            wait_class:       r.get("WAIT_CLASS").ok(),
            blocking_session: r.get::<_, Option<u32>>("BLOCKING_SESSION").ok().flatten(),
            logon_time:       logon.map(|d| Utc.from_utc_datetime(&d)),
        });
    }
    Ok(out)
}
