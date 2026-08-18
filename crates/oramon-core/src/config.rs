//! `.env` 또는 환경변수에서 접속·수집 설정을 로드한다.
//!
//! 사용 예:
//! ```ignore
//! let cfg = oramon_core::Config::load()?;
//! ```

use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    // ---- Oracle ----
    pub oramon_dsn: String,
    pub oramon_user: String,
    pub oramon_password: String,

    #[serde(default)]
    pub oramon_as_sysdba: bool,

    #[serde(default = "default_profile")]
    pub oramon_profile: String,

    // ---- Pool ----
    #[serde(default = "default_pool_min")]
    pub oramon_pool_min: u32,
    #[serde(default = "default_pool_max")]
    pub oramon_pool_max: u32,

    // ---- Intervals (ms) ----
    #[serde(default = "default_fast")]
    pub oramon_interval_fast_ms: u64,
    #[serde(default = "default_med")]
    pub oramon_interval_med_ms: u64,
    #[serde(default = "default_slow")]
    pub oramon_interval_slow_ms: u64,

    // ---- Safety ----
    #[serde(default = "default_mode")]
    pub oramon_mode: SafetyMode,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SafetyMode {
    Readonly,
    Dba,
}

fn default_profile() -> String { "default".into() }
fn default_pool_min() -> u32 { 2 }
fn default_pool_max() -> u32 { 8 }
fn default_fast() -> u64 { 1_000 }
fn default_med()  -> u64 { 10_000 }
fn default_slow() -> u64 { 60_000 }
fn default_mode() -> SafetyMode { SafetyMode::Readonly }

impl Config {
    /// 우선순위:
    ///   1. 이미 export 된 환경변수
    ///   2. 현재 디렉토리의 .env
    ///   3. 실행파일과 같은 위치의 .env
    pub fn load() -> anyhow::Result<Self> {
        // 1) 현재 디렉토리 .env 시도 (없으면 무시)
        let _ = dotenvy::dotenv();

        // 2) 실행파일 옆 .env 시도 (배포 형태 대응)
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let candidate = dir.join(".env");
                if candidate.exists() {
                    let _ = dotenvy::from_path(&candidate);
                }
            }
        }

        let cfg: Config = envy::from_env().map_err(|e| {
            anyhow::anyhow!(
                "설정 로드 실패 ({e}). \
                 .env 를 만들거나 환경변수 ORAMON_DSN, ORAMON_USER, ORAMON_PASSWORD 를 설정하세요. \
                 템플릿은 .env.example 참고."
            )
        })?;

        cfg.validate()?;
        Ok(cfg)
    }

    /// 특정 경로의 .env 를 명시적으로 로드하고 싶을 때 (테스트/CI 용)
    pub fn load_from(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        dotenvy::from_path(path.as_ref())?;
        let cfg: Config = envy::from_env()?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> anyhow::Result<()> {
        if self.oramon_dsn.trim().is_empty() {
            anyhow::bail!("ORAMON_DSN 이 비어 있습니다");
        }
        if self.oramon_user.trim().is_empty() {
            anyhow::bail!("ORAMON_USER 가 비어 있습니다");
        }
        if self.oramon_pool_min > self.oramon_pool_max {
            anyhow::bail!(
                "ORAMON_POOL_MIN({}) 이 ORAMON_POOL_MAX({}) 보다 큽니다",
                self.oramon_pool_min, self.oramon_pool_max
            );
        }
        Ok(())
    }

    /// 로그·화면에 뿌릴 안전한 요약 (비밀번호 제외)
    pub fn summary(&self) -> String {
        format!(
            "profile={} dsn={} user={} sysdba={} mode={:?} pool={}~{}",
            self.oramon_profile, self.oramon_dsn, self.oramon_user,
            self.oramon_as_sysdba, self.oramon_mode,
            self.oramon_pool_min, self.oramon_pool_max
        )
    }
}
