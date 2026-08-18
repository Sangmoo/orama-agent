//! 백그라운드 폴링 태스크. 결과는 `tokio::sync::watch` 로 UI 에 흘려보낸다.
//! watch 는 최신값만 유지 → backpressure 걱정 없음.

use anyhow::Result;
use oramon_core::Config;
use oramon_core::model::{DbBanner, SessionRow};
use oramon_oracle::{queries, OraclePool};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tracing::{error, info};

pub struct Snapshots {
    pub banner:   watch::Receiver<Option<DbBanner>>,
    pub sessions: watch::Receiver<Vec<SessionRow>>,
    pub error:    watch::Receiver<Option<String>>,
}

pub fn spawn(pool: Arc<OraclePool>, cfg: Arc<Config>) -> Snapshots {
    let (banner_tx,   banner_rx)   = watch::channel(None);
    let (sessions_tx, sessions_rx) = watch::channel(Vec::<SessionRow>::new());
    let (error_tx,    error_rx)    = watch::channel(None);

    // ---- 배너: 1회만 (거의 안 바뀜) ----
    {
        let pool = pool.clone();
        let err  = error_tx.clone();
        tokio::spawn(async move {
            match pool.query(|c| queries::fetch_banner(c)).await {
                Ok(b) => {
                    info!("연결 성공: {} {} ({})", b.instance_name, b.version, b.edition);
                    let _ = banner_tx.send(Some(b));
                }
                Err(e) => {
                    error!("배너 조회 실패: {e:#}");
                    let _ = err.send(Some(format!("배너 조회 실패: {e}")));
                }
            }
        });
    }

    // ---- 세션 목록: fast 주기 ----
    {
        let pool = pool.clone();
        let err  = error_tx.clone();
        let interval = Duration::from_millis(cfg.oramon_interval_fast_ms);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                match pool.query(|c| queries::fetch_sessions(c, 200)).await {
                    Ok(rows) => {
                        let _ = sessions_tx.send(rows);
                        let _ = err.send(None);
                    }
                    Err(e) => {
                        error!("세션 조회 실패: {e:#}");
                        let _ = err.send(Some(format!("세션 조회 실패: {e}")));
                    }
                }
            }
        });
    }

    Snapshots { banner: banner_rx, sessions: sessions_rx, error: error_rx }
}

pub async fn health_check(pool: &OraclePool) -> Result<()> {
    pool.ping().await
}
