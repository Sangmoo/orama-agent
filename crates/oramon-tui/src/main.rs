mod ui;

use anyhow::{Context, Result};
use oramon_collector as collector;
use oramon_core::Config;
use oramon_oracle::OraclePool;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    // ---- 1. 로그 초기화 ----
    // TUI 가 화면을 잡기 전에 stderr 로만 로그를 보낸다.
    // (파일로 보내려면 tracing-appender 로 스왑)
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("oramon=info")))
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    // ---- 2. .env 로드 & 파싱 ----
    let cfg = Config::load().context("설정 로드 실패")?;
    info!("설정: {}", cfg.summary());
    let cfg = Arc::new(cfg);

    // ---- 3. Oracle 풀 생성 + 헬스체크 ----
    let pool = OraclePool::connect(&cfg).await
        .context("Oracle 접속 실패 — DSN / 계정 / Instant Client 확인")?;
    pool.ping().await.context("SELECT 1 실패")?;
    let pool = Arc::new(pool);

    // ---- 4. 백그라운드 폴링 기동 ----
    let snapshots = collector::spawn(pool.clone(), cfg.clone());

    // ---- 5. TUI 실행 (여기서 화면을 잡음) ----
    ui::run(cfg.clone(), snapshots).await?;

    Ok(())
}
