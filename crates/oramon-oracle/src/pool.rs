//! `oracle` 크레이트의 세션 풀을 tokio 환경에서 안전하게 쓰기 위한 래퍼.
//!
//! `oracle` 크레이트는 동기 API 라서, 실제 쿼리는 항상
//! `tokio::task::spawn_blocking` 안에서 실행한다. 그래야 UI tick(100ms)
//! 이 오라클 왕복시간에 붙잡히지 않는다.

use anyhow::{Context, Result};
use oramon_core::Config;
use oracle::pool::{Pool, PoolBuilder};
use std::sync::Arc;

#[derive(Clone)]
pub struct OraclePool {
    inner: Arc<Pool>,
    pub profile: String,
}

impl OraclePool {
    /// Config 로부터 풀을 만든다. 블로킹 호출이라 spawn_blocking 안에서 실행.
    pub async fn connect(cfg: &Config) -> Result<Self> {
        let cfg = cfg.clone();

        let pool = tokio::task::spawn_blocking(move || -> Result<Pool> {
            let mut builder = PoolBuilder::new(
                &cfg.oramon_user,
                &cfg.oramon_password,
                &cfg.oramon_dsn,
            );
            builder
                .min_connections(cfg.oramon_pool_min)
                .max_connections(cfg.oramon_pool_max);

            if cfg.oramon_as_sysdba {
                // oracle 0.6 의 PoolBuilder 는 SYSDBA 권한 접속을 지원하지 않는다.
                // (Privilege 는 단일 Connector 에서만 설정 가능)
                anyhow::bail!(
                    "SYSDBA 접속은 세션 풀에서 지원되지 않습니다. \
                     ORAMON_AS_SYSDBA=false 로 두고 일반 계정으로 접속하세요."
                );
            }

            let pool = builder
                .build()
                .with_context(|| {
                    format!(
                        "Oracle 풀 생성 실패 — dsn={} user={}",
                        cfg.oramon_dsn, cfg.oramon_user
                    )
                })?;
            Ok(pool)
        })
        .await??;

        Ok(Self {
            inner: Arc::new(pool),
            profile: cfg.oramon_profile.clone(),
        })
    }

    /// 임의 SQL 을 실행하고 결과를 F 로 매핑. 항상 spawn_blocking 안에서.
    pub async fn query<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&oracle::Connection) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let pool = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let conn = pool.get().context("풀에서 커넥션 획득 실패")?;
            // 이 도구가 낸 세션임을 표시 (top SQL 에서 자기 자신 제외 시 유용)
            let _ = conn.execute(
                "BEGIN dbms_application_info.set_module('ORAMON', :1); END;",
                &[&"monitor"],
            );
            f(&conn)
        })
        .await?
    }

    /// 헬스체크: SELECT 1 FROM DUAL
    pub async fn ping(&self) -> Result<()> {
        self.query(|c| {
            let mut stmt = c.statement("SELECT 1 FROM DUAL").build()?;
            let _row = stmt.query_row(&[])?;
            Ok(())
        })
        .await
    }
}
