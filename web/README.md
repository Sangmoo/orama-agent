# ORAMON Web

Oracle 11g 실시간 모니터링 **웹 대시보드**. 팀원이 브라우저로 바로 접속해서 씁니다.
(기존 `oramon` Rust TUI 스켈레톤의 웹 버전 — `crates/` 는 그대로 두고 `web/` 에 별도 구현)

## 화면

| 탭 | 내용 |
|----|------|
| **개요** | 인스턴스/DB 정보 + 성능 지표 14종 + **각 지표별 최근 1시간 sparkline**(`v$sysmetric_history`) + 세션 요약 |
| **대시보드** | **Grafana 스타일 실시간 차트** — 상태 타일 6종 + 시계열 라인차트 6종(CPU/AAS/활성세션/Exec/Reads/Txn) + **최근 CPU 스파이크 이력** |
| **ASH** | **자체 액티브 세션 히스토리** — 구간(5~60분)별 Top SQL / 대기이벤트 / 세션 + AAS 추이 차트. **Diagnostic Pack 라이선스 불필요** |
| **세션** | `v$session` 전체 목록. 활성 강조, 대기 이벤트 색상, 블로커 표시, 필터, SID 클릭 → **세션 상세**(v$sesstat), SQL_ID 클릭 → 전문/실행계획, **KILL**(dba) |
| **Top SQL** | `v$sqlarea` 누적 Elapsed Top 30. 실행수/CPU/Buffer Gets/Disk Reads, SQL_ID 클릭 → **전문 + 실행계획**(`v$sql_plan`) |
| **대기 이벤트** | 시스템 대기 클래스(누적) + 현재 활성 세션 대기(실시간) + 블로킹 세션 트리 |
| **진행 작업** | `v$session_longops` 대형작업(RMAN/인덱스/정렬) 진행률 바 + 남은시간. 진행중이 위로 정렬 |
| **락/데드락** | **실시간 블로킹**(Blocker KILL 버튼) + **블로킹 감지 이력**(blocker/waiter SQL_ID 자동 기록) + **실제 데드락 이력**(alert log ORA-00060) |
| **용량** | 테이블스페이스 사용률 + **아카이브 로그 생성률 차트**(24h) + **세그먼트 Top 공간소비**(`dba_segments`) |
| **설정** | **이메일 알림** on/off · SMTP 상태 · 테스트 발송 · **수신자 등록/삭제** · 발송 로그 |

- SID 클릭 → **세션 상세**(모듈/서버/현재SQL/대기 + v$sesstat 통계), SQL_ID 클릭 → **[SQL 전문] / [실행계획]** 탭
- **표 헤더 클릭 → 컬럼 정렬**(오름/내림, 자동 새로고침에도 유지)
- 대시보드에 **기준선 비교(어제 vs 오늘)** 차트 — 지표·구간 선택 (24시간 이상 수집 시 어제 곡선 표시)
- 각 표 우측 상단 **CSV** 버튼으로 현재 데이터 내보내기 (Excel 한글 호환 BOM 포함)
- 자동 새로고침 주기 + 마지막 탭을 **localStorage 로 기억**
- 접속 상태 표시등(녹색=접속됨 / 빨강=실패), 헤더에 로그인 사용자·모드(readonly/DBA) 표시

## 로그인 인증

- `AUTH_ENABLED=true`(기본)면 **로그인 필요**. 계정은 **`T_USR`/`T_EMP` 부서 `212003`, `USE_YN='Y'`** 사용자, 아이디는 `USR_ID`.
- 비밀번호는 **SQL 내에서 `CRYPTO_DECRYPT(U.PWD)` 로 bind 비교** → 앱은 복호화된 비밀번호를 절대 전달받거나 로그에 남기지 않습니다.
- 세션은 HttpOnly 쿠키(`oramon_sid`), 무활동 `AUTH_IDLE_MIN`(기본 8시간) 후 만료. 서버 재시작 시 재로그인.
- **감사 로그**: 로그인·KILL·설정변경(임계치/알림/수신자)을 누가 했는지 SQLite 에 기록 → 설정 탭 하단에서 조회.
- `AUTH_ENABLED=false` 로 두면 인증 없이 열립니다(사내 폐쇄망 등).

## 운영 안정성

- **DB 재접속 복원력**: 웹서버가 먼저 뜨고 Oracle 접속은 **재시도 루프**로 붙습니다. 리스너가 늦게 떠도, 운영 중 순단돼도 스스로 회복(`poolPingInterval` 로 끊긴 커넥션 자동 폐기).
- 리버스 프록시로 **HTTPS** 를 앞단에 두는 것을 권장(로그인·KILL 이 평문으로 오가지 않게).

## 임계치 런타임 조정

설정 탭에서 **CPU 스파이크 % · 블로킹 초 · TS 포화 %** 를 조정하면 즉시 수집기에 반영되고 SQLite 에 저장되어 재시작에도 유지됩니다(`.env` 기본값을 override).

## 영구 저장 (SQLite · `data/oramon.db`)

지표 시계열·ASH 샘플·스파이크/블로킹 이벤트·알림 수신자를 **SQLite(Node 22 내장 `node:sqlite`, 네이티브 의존성 없음)** 에 저장합니다.
서버를 재시작해도 차트·이력이 유지되고, `RETAIN_DAYS`(기본 7일) 지난 데이터는 자동 정리됩니다.

## 이메일 알림 (SMTP)

수집기가 **CPU 스파이크 · 블로킹 · 테이블스페이스 포화**를 감지하면 등록된 수신자에게
**원인 SQL_ID 와 SQL 전문을 포함한** 메일을 보냅니다.

설정:
1. `.env` 에 SMTP 접속정보 입력 — `SMTP_HOST`, `SMTP_PORT`(587/465), `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
2. `ALERT_ENABLED=true` (또는 **설정 탭**에서 토글)
3. **설정 탭**에서 수신자 이메일 등록 → **테스트 메일 발송**으로 확인

> 수신자는 SQLite 에 저장되어 재시작에도 유지됩니다. 발송 이력은 설정 탭 하단 로그에서 확인.

## 백그라운드 수집기 (collector.js)

서버가 뜨면 주기적으로(기본 10초) DB 를 샘플링하며 세 가지 일을 합니다:

1. **차트용 시계열 적재** — 지표/세션 수를 메모리 링버퍼에 보관(기본 3시간치). 대시보드 차트가 이걸 그림.
2. **CPU 스파이크 로그** — Host CPU 가 임계치(`CPU_SPIKE_PCT`, 기본 85%)를 넘는 순간
   **당시 활성 세션 + 실행 중 SQL 스냅샷**을 `data/spikes.log` 에 기록. 대시보드에서 "상세"로 원인 SQL 확인.
3. **블로킹 감지 로그** — 블로킹이 `BLOCK_ALERT_SEC`(기본 30초) 이상 지속되면
   blocker/waiter 의 **SQL_ID 를 `data/locks.log`** 에 기록.

데드락(ORA-00060) 이력은 alert log(`v$diag_alert_ext`)를 스캔하는데 **매우 느려서(수십초)**
백그라운드로 30분마다 수집해 캐시합니다. UI 는 즉시 캐시를 반환하므로 멈추지 않습니다.

> 참고: 진짜 데드락은 Oracle 이 3초 내 자동 해소해 KILL 대상이 남지 않습니다. alert log 에는 SQL_ID 도
> 없어(트레이스 파일에만 있음) 실무의 "행 걸림"은 대부분 **블로킹 락**입니다. 그래서 SQL_ID + KILL 이
> 필요한 실전 대응은 **락/데드락 탭의 실시간 블로킹 표**에서 합니다.

## Grafana 연동 (선택)

앱 내장 대시보드로 충분하지만, 진짜 Grafana 를 쓰고 싶으면 **Prometheus 노출 엔드포인트**가 준비돼 있습니다:

```
GET /metrics   →  oramon_host_cpu_pct, oramon_avg_active_sessions,
                  oramon_sessions_active/blocked/total, ... (Prometheus 포맷)
```

Prometheus 가 이 엔드포인트를 scrape → Grafana 데이터소스로 연결하면 됩니다.

## 사전 준비

1. **Node.js** (v18+ 권장, 현재 v22 확인됨)
2. **Oracle Instant Client** — Oracle 11g 는 `oracledb` Thin 모드 미지원이라 **Thick 모드(Instant Client) 필수**
   - 경로: `.env` 의 `ORACLE_CLIENT_PATH` (예: `C:\oracle\instantclient_23_7`)

## 설치 & 실행

```bash
cd web
npm install
cp .env.example .env   # 접속정보 입력 (Windows: copy .env.example .env)
npm start
```

브라우저에서 **http://localhost:3900** 접속.
같은 네트워크의 팀원은 `http://<이서버IP>:3900` 으로 접속 가능.

## .env 설정

```ini
ORACLE_CLIENT_PATH=C:\oracle\instantclient_23_7
DB_HOST=192.168.0.10
DB_PORT=1521
DB_SID=ORCL              # service_name 아니라 SID 방식
DB_USER=monitor_user
DB_PASSWORD='p@ss#w0rd$'    # ★ # $ 등 특수문자 있으면 반드시 작은따옴표
POOL_MIN=2
POOL_MAX=8
PORT=3900
SHOW_BACKGROUND=false       # true 면 백그라운드 프로세스 세션도 표시
```

> ⚠️ **비밀번호 따옴표 주의**: node `dotenv` 는 따옴표 없는 값의 `#` 를 주석으로 잘라냅니다.
> `p@ss#w0rd$` 를 그냥 두면 `p@ss` 로 읽혀 ORA-01017(비밀번호 부적합)이 납니다. **작은따옴표 필수.**

## 구조

```
web/
├── server.js         # Express 서버 + REST API (/api/*)
├── db.js             # oracledb 커넥션 풀 (Thick 모드, SID 접속, SET_MODULE='ORAMON')
├── queries.js        # v$ 뷰 SQL 모음 (SELECT 전용, 11g 문법)
├── .env / .env.example
└── public/
    ├── index.html    # 탭 UI
    ├── style.css     # 다크 테마
    └── app.js        # fetch + 렌더 + 자동 새로고침 + SQL 모달
```

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/health` | 접속 상태 |
| GET | `/api/overview` | 인스턴스 + DB + 지표 + 세션요약 |
| GET | `/api/sessions` | 세션 목록 + 요약 |
| GET | `/api/topsql` | Top SQL 30 |
| GET | `/api/sql/:id` | 특정 SQL_ID 전체 텍스트 |
| GET | `/api/plan/:id` | 특정 SQL_ID 실행계획(`v$sql_plan`) |
| GET | `/api/waits` | 대기 클래스 + 활성 대기 |
| GET | `/api/blocking` | 블로킹 세션 |
| GET | `/api/longops` | 진행/최근 대형작업(`v$session_longops`) |
| GET | `/api/tablespaces` | 테이블스페이스 사용률 + 포화 예상(`PREDICT`: 증가율 회귀 D-day) |
| GET | `/api/history` | 대시보드 시계열(수집기 링버퍼) |
| GET | `/api/events/cpu` | CPU 스파이크 이력(원인 세션·SQL 스냅샷) |
| GET | `/api/events/locks` | 블로킹 감지 이력(blocker/waiter SQL_ID) |
| GET | `/api/deadlocks` | 실제 데드락 이력(alert log → **SQLite 영구 저장**, 즉시 반환). `?refresh=1` 백그라운드 재수집 |
| GET | `/api/ash` | 자체 ASH 집계 `?minutes=15` (top SQL/이벤트/세션 + 타임라인) |
| GET | `/api/ash/heatmap` | ASH 액티비티 히트맵 `?minutes=15&buckets=48` (버킷 × 대기클래스 매트릭스) |
| GET | `/api/incidents` | 인시던트 통합 타임라인 `?days=7` (스파이크·블로킹·데드락·KILL·보안·알림 병합) |
| GET | `/api/status` | 라이브 상태(탭 배지용, DB 히트 없이 수집기 최신 샘플) |
| POST | `/api/ai/summary` | 현재 스냅샷 AI 요약(Claude, 120초 캐시) |
| GET | `/api/archivelog` | 아카이브 로그 생성률(24h) |
| GET | `/api/segments` | 세그먼트 Top 공간소비(`dba_segments`) |
| GET | `/api/session/:sid` | 세션 상세(v$session + v$sesstat) |
| GET/POST/DELETE | `/api/recipients` | 알림 수신자 목록/추가/삭제 |
| GET | `/api/alerts/config` | 알림 설정·SMTP 상태·발송 로그·임계치 |
| POST | `/api/alerts/toggle` | 알림 on/off `{enabled}` |
| POST | `/api/alerts/test` | 테스트 메일 발송 |
| POST | `/api/settings/thresholds` | 감지 임계치 런타임 조정 `{cpuSpike,blockSec,tsPct}` |
| GET | `/api/baseline` | 기준선 비교 `?metric=cpu&minutes=180` (오늘/어제) |
| GET | `/api/audit` | 감사 로그(로그인·KILL·설정변경) |
| GET | `/api/tune/config` | AI 튜닝 설정·모델·일일 한도/사용량 |
| POST | `/api/tune/:id` | AI 튜닝 제안 — **SSE 스트리밍**(`thinking`/`delta`/`done`/`cached`/`error`). `?force=1` 캐시 무시 재생성 |
| POST | `/api/login` · `/api/logout` · GET `/api/me` | 로그인/로그아웃/현재 사용자 (인증 불필요). 로그인은 계정+IP 기준 연속 실패 시 일시 잠금(429) |
| GET | `/metrics` | Prometheus 포맷 지표(Grafana 연동용, 인증 불필요) |
| POST | `/api/kill` | 세션 종료 `{sid, serial}` — **dba 모드에서만**, 감사로그 기록 |

> `/api/login`·`/api/logout`·`/api/me`·`/metrics` 를 제외한 모든 `/api/*` 는 로그인 세션이 필요합니다(미인증 시 401).

모든 응답: `{ ok: true, data, ts }` 또는 `{ ok: false, error, ts }`. 단 `POST /api/tune/:id` 는 `text/event-stream`(SSE)으로 `data: {type,...}` 이벤트를 흘려보냅니다.

### 세션 KILL 사용법

기본은 `readonly` 라 KILL 버튼이 안 보입니다. 켜려면:

1. `.env` 에서 `ORAMON_MODE=dba` 로 변경 후 서버 재시작
2. 접속 계정에 `ALTER SYSTEM` 권한 필요 (없으면 ORA-01031 등 에러를 그대로 표시)
3. 세션 탭 각 행의 **KILL** 버튼 → 확인 다이얼로그 → `ALTER SYSTEM KILL SESSION '<sid>,<serial>' IMMEDIATE`

> sid/serial 은 서버에서 정수 검증 후 조합(SQL 인젝션 차단). ORAMON 자기 세션에는 버튼이 안 뜹니다.

## 설계 노트

- **읽기 전용(readonly)**: 모든 쿼리는 SELECT 전용. KILL/GATHER 등 destructive 액션 없음.
- **자기 세션 식별**: 커넥션마다 `DBMS_APPLICATION_INFO.SET_MODULE('ORAMON')` — 세션 목록에서 모니터 자신 구분.
- **커넥션 풀 반납**: `db.query()` 가 finally 에서 항상 `conn.close()` — 커넥션 누수 방지.
- **권한 부족 graceful 처리**: DBA_ 뷰(테이블스페이스) 권한 없으면 안내 문구 표시, 다른 탭은 정상.

## 다음 단계 (아이디어)

- 대기 이벤트 delta(초당 rate) — 누적값 대신 "지금" 기준 *(보류 중)*
- 다중 인스턴스 프로파일 전환
- 알림 채널 확장(Slack/Teams Webhook)
- 일일 상태 요약 메일(다이제스트)

## 라이선스 주의

- **ASH 는 `v$active_session_history`(Diagnostic Pack 유료) 를 쓰지 않고** 수집기가 직접 샘플링해 만든 자체 구현이라 라이선스 부담이 없습니다.
- `v$sql_monitor`, `dba_hist_*`(AWR) 등 Diagnostic/Tuning Pack 뷰는 사용하지 않습니다.
