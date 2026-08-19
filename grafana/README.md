# ORAMON × Grafana 연동

ORAMON 웹서버는 `/metrics` 엔드포인트로 **Prometheus 포맷 지표**를 노출합니다(인증 불필요).
Prometheus 로 스크레이프하고, 여기 있는 대시보드 JSON 을 Grafana 에 임포트하면 바로 시각화됩니다.

앱 내장 대시보드로도 충분하지만, 이미 **Prometheus + Grafana** 스택을 쓰는 팀이라면 이 방법이 편합니다.

## 1. 노출 지표 (`GET /metrics`)

| 지표 | 설명 | 단위 |
|------|------|------|
| `oramon_host_cpu_pct` | 호스트 CPU 사용률 | % |
| `oramon_db_cpu_ratio` | Database CPU Time Ratio | % |
| `oramon_avg_active_sessions` | 평균 활성 세션(AAS) | — |
| `oramon_executions_per_sec` | 초당 실행수 | /s |
| `oramon_physical_reads_per_sec` | 초당 물리 읽기 | /s |
| `oramon_user_txn_per_sec` | 초당 사용자 트랜잭션 | /s |
| `oramon_sessions_active` | 활성 세션 수 | — |
| `oramon_sessions_blocked` | 블로킹 대기 세션 수 | — |
| `oramon_sessions_total` | 전체 세션 수 | — |

모두 gauge 이며, 값은 수집기 주기(`COLLECT_INTERVAL_MS`, 기본 10초)마다 갱신됩니다.

## 2. Prometheus 스크레이프 설정

`prometheus.yml` 에 잡을 추가합니다(ORAMON 서버 주소·포트로 교체):

```yaml
scrape_configs:
  - job_name: oramon
    metrics_path: /metrics
    scrape_interval: 10s          # 수집기 주기와 맞추면 좋음
    static_configs:
      - targets: ['ORAMON_HOST:3900']   # 예: 192.168.0.20:3900
```

Prometheus 재시작(또는 reload) 후 **Status → Targets** 에서 `oramon` 잡이 `UP` 인지 확인하세요.

## 3. Grafana 대시보드 임포트

1. Grafana → **Dashboards → New → Import**
2. `oramon-dashboard.json` 업로드(또는 내용 붙여넣기)
3. **Prometheus** 데이터소스 선택 → **Import**

대시보드(`ORAMON · Oracle 11g Overview`, uid `oramon-overview`) 구성:
- 상단 **Stat** 6개: Host CPU % · DB CPU Ratio · AAS · Active · Blocked(1건↑ 빨강) · Total 세션
- **CPU**(Host % + DB CPU Ratio) / **Throughput**(exec·reads·txn per sec)
- **AAS 추이** / **Sessions**(active·blocked·total, Blocked 는 빨강 강조)

> 임계선(예: CPU 85%)이나 알림 규칙은 Grafana 쪽에서 추가로 설정할 수 있습니다.
> 지표를 더 원하면 `web/server.js` 의 `/metrics` 핸들러에 `g('oramon_...', ...)` 를 추가하면 됩니다.
