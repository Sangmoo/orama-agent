//! DB 무관 도메인 모델. UI 와 collector 가 공유.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub sid: u32,
    pub serial: u32,
    pub inst_id: u32,
    pub username: Option<String>,
    pub status: String,             // ACTIVE / INACTIVE / KILLED
    pub osuser: Option<String>,
    pub machine: Option<String>,
    pub program: Option<String>,
    pub module: Option<String>,
    pub sql_id: Option<String>,
    pub event: Option<String>,      // 현재 wait event
    pub wait_class: Option<String>, // User I/O / Concurrency / ...
    pub blocking_session: Option<u32>,
    pub logon_time: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbBanner {
    pub instance_name: String,
    pub host_name: String,
    pub version: String,     // "11.2.0.4.0"
    pub edition: String,     // "EE" / "SE" 추정
    pub startup_time: DateTime<Utc>,
    pub database_role: String, // PRIMARY / PHYSICAL STANDBY / ...
}
