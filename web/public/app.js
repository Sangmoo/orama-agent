// =============================================================
//  ORAMON Web - 프론트엔드 로직
// =============================================================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let currentTab = 'overview';
let timer = null;
let mode = 'readonly';
let lastData = { sessions: [], topsql: [] };

// ---- Toast ----
function toast(msg, kind) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast ' + (kind || '');
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---- Sparkline SVG 생성 ----
function sparkline(values) {
  if (!values || values.length < 2) return '';
  const w = 100, h = 26, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = pad + (i / (n - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const area = `${pad},${h} ${pts.join(' ')} ${w - pad},${h}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon class="fillarea" points="${area}"></polygon>
    <polyline points="${pts.join(' ')}"></polyline>
  </svg>`;
}

// ---- 유틸 ----
async function getJSON(url) {
  try {
    const r = await fetch(url);
    if (r.status === 401) { showLogin(); return { ok: false, error: '로그인 필요', auth: false }; }
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
const num = (n) => (n == null ? '' : Number(n).toLocaleString());
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour12: false });

function waitClassClass(wc) {
  if (!wc) return '';
  const k = wc.toLowerCase().replace(/[^a-z]/g, '');
  return 'wc-' + k;
}

// ---- 큰 라인차트 SVG (대시보드) ----
function lineChart(points, opts) {
  opts = opts || {};
  const vals = points.filter((v) => v != null && !isNaN(v));
  if (vals.length < 2) return '<svg viewBox="0 0 300 110"><text x="150" y="58" text-anchor="middle" class="cp-axis">데이터 수집 중…</text></svg>';
  const w = 300, h = 110, padL = 30, padR = 6, padT = 8, padB = 16;
  let min = Math.min(...vals), max = Math.max(...vals);
  if (opts.min != null) min = opts.min;
  if (opts.max != null) max = Math.max(max, opts.max);
  if (min === max) max = min + 1;
  const n = points.length;
  const X = (i) => padL + (i / (n - 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
  const pts = [];
  points.forEach((v, i) => { if (v != null && !isNaN(v)) pts.push(X(i).toFixed(1) + ',' + Y(v).toFixed(1)); });
  const first = points.findIndex((v) => v != null && !isNaN(v));
  const area = `${X(first).toFixed(1)},${h - padB} ${pts.join(' ')} ${X(n - 1).toFixed(1)},${h - padB}`;
  const color = opts.color || 'var(--accent)';
  const grid = [0.25, 0.5, 0.75].map((f) => {
    const y = padT + f * (h - padT - padB);
    return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${grid}
    <text x="2" y="${padT + 4}" class="cp-axis">${fmtShort(max)}</text>
    <text x="2" y="${h - padB}" class="cp-axis">${fmtShort(min)}</text>
    <polygon points="${area}" fill="${color}" opacity="0.10"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
function fmtShort(n) {
  if (n == null) return '';
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return (Math.round(n * 100) / 100).toString();
}

// 여러 시리즈 겹쳐그리기 (기준선 비교). series=[{points:[{x0..1,y}], color, dashed}]
function multiLineChart(series, opts) {
  opts = opts || {};
  const all = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v != null && !isNaN(v));
  if (all.length < 2) return '<svg viewBox="0 0 300 110"><text x="150" y="58" text-anchor="middle" class="cp-axis">데이터 부족</text></svg>';
  const w = 300, h = 110, padL = 30, padR = 6, padT = 8, padB = 16;
  let min = Math.min(...all), max = Math.max(...all);
  if (opts.min != null) min = opts.min;
  if (min === max) max = min + 1;
  const X = (x) => padL + x * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
  const grid = [0.25, 0.5, 0.75].map((f) => {
    const y = padT + f * (h - padT - padB);
    return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
  }).join('');
  const lines = series.map((s) => {
    const pts = s.points.filter((p) => p.y != null && !isNaN(p.y)).map((p) => X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1));
    return pts.length < 2 ? '' : `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.5" vector-effect="non-scaling-stroke" ${s.dashed ? 'stroke-dasharray="3,3"' : ''}/>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}
    <text x="2" y="${padT + 4}" class="cp-axis">${fmtShort(max)}</text>
    <text x="2" y="${h - padB}" class="cp-axis">${fmtShort(min)}</text>
    ${lines}</svg>`;
}
async function loadBaseline() {
  const metric = $('#baseMetric').value, minutes = $('#baseWindow').value;
  const res = await getJSON(`/api/baseline?metric=${metric}&minutes=${minutes}`);
  if (!res.ok) return;
  const d = res.data;
  const span = (d.now - d.from) || 1;
  const norm = (arr) => arr.map((p) => ({ x: (p.t - d.from) / span, y: p.v }));
  $('#baseChart').innerHTML = multiLineChart([
    { points: norm(d.today), color: 'var(--accent)', dashed: false },
    { points: norm(d.yesterday), color: 'var(--muted)', dashed: true }
  ], { min: 0 });
  $('#baseNotice').textContent = d.yesterday.length ? '' : '어제 같은 시간대 데이터가 아직 없습니다 (24시간 이상 수집되면 자동 표시).';
}
if ($('#baseMetric')) { $('#baseMetric').addEventListener('change', loadBaseline); $('#baseWindow').addEventListener('change', loadBaseline); }

// ---- CSV 내보내기 ----
const csvReg = {}; // name -> {headers:[], rows:[[...]]}
function registerCsv(name, headers, rows) { csvReg[name] = { headers, rows }; }
function toCsvValue(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(name) {
  const d = csvReg[name];
  if (!d || !d.rows.length) { toast('내보낼 데이터가 없습니다', 'err'); return; }
  const lines = [d.headers.map(toCsvValue).join(',')];
  for (const r of d.rows) lines.push(r.map(toCsvValue).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url; a.download = `oramon_${name}_${stamp}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${name}.csv 내보냄`, 'ok');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.csv-btn');
  if (b) downloadCsv(b.dataset.csv);
});

// ---- 표 컬럼 정렬 (전 탭 공통, 자동 새로고침에도 유지) ----
const sortState = new WeakMap(); // table -> {col, dir}
function cellVal(td) {
  if (!td) return '';
  const t = td.textContent.trim().replace(/,/g, '').replace('%', '');
  const n = parseFloat(t);
  return (t !== '' && !isNaN(n) && /^-?[\d.]+$/.test(t)) ? n : td.textContent.trim().toLowerCase();
}
let sorting = false; // 재정렬 중 MutationObserver 재진입 방지 (무한루프 차단)
function sortTable(table) {
  const st = sortState.get(table);
  const tbody = table.tBodies[0];
  if (!st || !tbody || sorting) return;
  const rows = [...tbody.rows].filter((r) => !r.querySelector('.empty'));
  if (rows.length < 2) return;
  rows.sort((a, b) => {
    const x = cellVal(a.cells[st.col]), y = cellVal(b.cells[st.col]);
    if (x < y) return -st.dir; if (x > y) return st.dir; return 0;
  });
  sorting = true;
  rows.forEach((r) => tbody.appendChild(r));
  sorting = false;
}
document.addEventListener('click', (e) => {
  const th = e.target.closest('.table-wrap table thead th');
  if (!th) return;
  const table = th.closest('table');
  const col = [...th.parentNode.children].indexOf(th);
  const cur = sortState.get(table);
  const dir = (cur && cur.col === col) ? -cur.dir : 1;
  sortState.set(table, { col, dir });
  table.querySelectorAll('thead th').forEach((h) => h.classList.remove('sort-asc', 'sort-desc'));
  th.classList.add(dir > 0 ? 'sort-asc' : 'sort-desc');
  // 자동 새로고침으로 tbody 가 재생성돼도 정렬 유지.
  // 재정렬(appendChild)이 다시 옵저버를 트리거하지 않도록 콜백에서 disconnect→sort→reconnect.
  if (!table.__sortObs && tbodyOf(table)) {
    const obs = new MutationObserver(() => {
      obs.disconnect();
      sortTable(table);
      const tb = tbodyOf(table);
      if (tb) obs.observe(tb, { childList: true });
    });
    obs.observe(tbodyOf(table), { childList: true });
    table.__sortObs = obs;
  }
  sortTable(table);
});
function tbodyOf(t) { return t.tBodies[0]; }

// ---- UI 상태 기억 (localStorage) ----
function restoreUiPrefs() {
  const iv = localStorage.getItem('oramon_interval');
  if (iv !== null && $('#intervalSel').querySelector(`option[value="${iv}"]`)) $('#intervalSel').value = iv;
  const tab = localStorage.getItem('oramon_tab');
  if (tab && $(`.tab[data-tab="${tab}"]`)) {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.panel').forEach((x) => x.classList.remove('active'));
    $(`.tab[data-tab="${tab}"]`).classList.add('active');
    currentTab = tab;
    $('#tab-' + tab).classList.add('active');
  }
}

// ---- 탭 전환 ----
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  currentTab = t.dataset.tab;
  $('#tab-' + currentTab).classList.add('active');
  localStorage.setItem('oramon_tab', currentTab);
  refresh();
}));

// ---- 헬스 ----
async function health() {
  const res = await getJSON('/api/health');
  const dot = $('#connDot'), txt = $('#connText'), tag = $('#profileTag');
  if (res.ok && res.data.connected) {
    dot.className = 'dot ok';
    mode = res.data.mode || 'readonly';
    txt.textContent = '접속됨' + (mode === 'dba' ? ' · DBA' : '');
    tag.textContent = res.data.profile;
  } else {
    dot.className = 'dot bad';
    txt.textContent = '접속 실패: ' + (res.error || '연결 불가');
  }
}

// ---- 개요 ----
const METRIC_THRESH = {
  'Host CPU Utilization (%)': [75, 90],
  'Database CPU Time Ratio': [200, 300],
  'Average Active Sessions': [999, 9999],
  'Current OS Load': [8, 16],
};
function renderOverview(d) {
  // 인스턴스 카드
  const i = d.instance || {};
  const db = d.database || {};
  const s = d.summary || {};
  const cards = [
    ['인스턴스', i.INSTANCE_NAME, ''],
    ['호스트', i.HOST_NAME, ''],
    ['버전', i.VERSION, ''],
    ['상태', i.STATUS, (i.STATUS === 'OPEN' ? 'status-open' : '')],
    ['DB', db.DB_NAME, ''],
    ['Open Mode', db.OPEN_MODE, ''],
    ['Log Mode', db.LOG_MODE, ''],
    ['기동 시각', i.STARTUP_TIME, ''],
    ['가동일수', i.UPTIME_DAYS != null ? i.UPTIME_DAYS + '일' : '', ''],
    ['전체 세션', s.TOTAL != null ? num(s.TOTAL) : '', ''],
    ['활성/차단', (s.ACTIVE != null ? s.ACTIVE : '-') + ' / ' + (s.BLOCKED != null ? s.BLOCKED : '-'),
      (s.BLOCKED > 0 ? 'status-crit' : '')],
  ];
  $('#instBox').innerHTML = cards.filter(c => c[1] != null && c[1] !== '')
    .map(([k, v, cls]) => `<div class="inst-card"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`)
    .join('');

  // 지표 (+ sparkline)
  const metrics = Array.isArray(d.metrics) ? d.metrics : [];
  const history = d.history || {};
  $('#metricGrid').innerHTML = metrics.map((m) => {
    const name = m.METRIC_NAME, val = m.VALUE, unit = m.METRIC_UNIT || '';
    const th = METRIC_THRESH[name];
    let lvl = '';
    let pct = null;
    if (unit.includes('%') || /\(%\)/.test(name)) { pct = Math.min(100, Math.max(0, val)); }
    if (th) { if (val >= th[1]) lvl = 'crit'; else if (val >= th[0]) lvl = 'warn'; }
    // 히스토리가 있으면 sparkline, 없으면 게이지 바
    const spark = history[name] ? sparkline(history[name]) : '';
    const bar = spark ? spark
      : (pct != null ? `<div class="bar"><span style="width:${pct}%"></span></div>` : '');
    return `<div class="metric ${lvl}">
      <div class="mname">${esc(name)}</div>
      <div><span class="mval">${num(val)}</span><span class="munit">${esc(unit.includes('%') ? '%' : '')}</span></div>
      ${bar}
    </div>`;
  }).join('') || '<div class="empty">지표 없음</div>';
}

// ---- 세션 ----
function renderSessions(d) {
  const s = d.summary || {};
  $('#sessChips').innerHTML = [
    `<span class="chip">전체 <b>${num(s.TOTAL)}</b></span>`,
    `<span class="chip active">활성 <b>${num(s.ACTIVE)}</b></span>`,
    `<span class="chip">유휴 <b>${num(s.INACTIVE)}</b></span>`,
    `<span class="chip ${s.BLOCKED > 0 ? 'blocked' : ''}">차단됨 <b>${num(s.BLOCKED)}</b></span>`,
  ].join('');
  lastData.sessions = d.list || [];
  registerCsv('sessions',
    ['SID', 'SERIAL', 'USERNAME', 'STATUS', 'EVENT', 'WAIT_CLASS', 'WAIT_SEC', 'BLOCKER', 'SQL_ID', 'MACHINE', 'PROGRAM', 'MODULE', 'LOGON_TIME'],
    lastData.sessions.map((r) => [r.SID, r.SERIAL, r.USERNAME, r.STATUS, r.EVENT, r.WAIT_CLASS, r.WAIT_SEC, r.BLOCKER, r.SQL_ID, r.MACHINE, r.PROGRAM, r.MODULE, r.LOGON_TIME]));
  drawSessionRows();
}
function drawSessionRows() {
  const f = $('#sessFilter').value.trim().toLowerCase();
  const rows = lastData.sessions.filter((r) => {
    if (!f) return true;
    return [r.USERNAME, r.PROGRAM, r.SQL_ID, r.MACHINE, r.MODULE, r.EVENT]
      .some((v) => v && String(v).toLowerCase().includes(f));
  });
  const tb = $('#sessTable tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="13" class="empty">세션 없음</td></tr>'; return; }
  tb.innerHTML = rows.map((r) => {
    const stCls = 'st-' + String(r.STATUS || '').toLowerCase();
    const sqlCell = r.SQL_ID ? `<span class="sqlid" data-sql="${esc(r.SQL_ID)}">${esc(r.SQL_ID)}</span>` : '';
    const blk = r.BLOCKER ? `<span class="blocker-cell">${esc(r.BLOCKER)}</span>` : '';
    // 액션: dba 모드 + 유저세션 + ORAMON 자기 자신 아님
    let action = '<span class="mode-ro">—</span>';
    if (mode === 'dba' && r.USERNAME && r.MODULE !== 'ORAMON') {
      action = `<button class="kill-btn" data-sid="${esc(r.SID)}" data-serial="${esc(r.SERIAL)}" data-user="${esc(r.USERNAME)}">KILL</button>`;
    }
    return `<tr>
      <td><span class="sid-link" data-sid="${esc(r.SID)}">${esc(r.SID)}</span></td>
      <td class="mono">${esc(r.SERIAL)}</td>
      <td>${esc(r.USERNAME)}</td>
      <td class="${stCls}">${esc(r.STATUS)}</td>
      <td class="${waitClassClass(r.WAIT_CLASS)}">${esc(r.EVENT)}</td>
      <td class="${waitClassClass(r.WAIT_CLASS)}">${esc(r.WAIT_CLASS)}</td>
      <td class="mono">${r.WAIT_SEC != null ? num(r.WAIT_SEC) : ''}</td>
      <td>${blk}</td>
      <td>${sqlCell}</td>
      <td>${esc(r.MACHINE)}</td>
      <td>${esc(r.PROGRAM)}</td>
      <td>${esc(r.MODULE)}</td>
      <td>${action}</td>
    </tr>`;
  }).join('');
  bindSqlLinks();
  bindKillButtons();
  bindSidLinks();
}
$('#sessFilter').addEventListener('input', drawSessionRows);

// ---- 세션 KILL (공용) ----
async function doKill(sid, serial, user, btn) {
  if (!confirm(`세션을 강제 종료합니다.\n\n  SID: ${sid},${serial}\n  사용자: ${user || '-'}\n\nALTER SYSTEM KILL SESSION 을 실행합니다. 진행할까요?`)) return;
  const label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const r = await fetch('/api/kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, serial })
  }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) { toast(`세션 ${sid},${serial} 종료 요청 완료`, 'ok'); refresh(); }
  else { toast('종료 실패: ' + (r.error || '알 수 없음'), 'err'); if (btn) { btn.disabled = false; btn.textContent = label; } }
}
function bindKillButtons() {
  $$('.kill-btn').forEach((btn) => btn.onclick = () => doKill(btn.dataset.sid, btn.dataset.serial, btn.dataset.user, btn));
}

// ---- Top SQL ----
function renderTopSql(d) {
  lastData.topsql = d.list || [];
  registerCsv('topsql',
    ['SQL_ID', 'EXECUTIONS', 'ELAPSED_SEC', 'SEC_PER_EXEC', 'CPU_SEC', 'BUFFER_GETS', 'DISK_READS', 'ROWS', 'SCHEMA', 'SQL_TEXT'],
    lastData.topsql.map((r) => [r.SQL_ID, r.EXECUTIONS, r.ELAPSED_SEC, r.SEC_PER_EXEC, r.CPU_SEC, r.BUFFER_GETS, r.DISK_READS, r.ROWS_PROCESSED, r.SCHEMA, r.SQL_TEXT]));
  drawSqlRows();
}
function drawSqlRows() {
  const f = $('#sqlFilter').value.trim().toLowerCase();
  const rows = lastData.topsql.filter((r) => {
    if (!f) return true;
    return [r.SQL_ID, r.SCHEMA, r.SQL_TEXT].some((v) => v && String(v).toLowerCase().includes(f));
  });
  const tb = $('#sqlTable tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="10" class="empty">SQL 없음</td></tr>'; return; }
  tb.innerHTML = rows.map((r) => `<tr>
    <td><span class="sqlid" data-sql="${esc(r.SQL_ID)}">${esc(r.SQL_ID)}</span></td>
    <td class="mono">${num(r.EXECUTIONS)}</td>
    <td class="mono">${num(r.ELAPSED_SEC)}</td>
    <td class="mono">${num(r.SEC_PER_EXEC)}</td>
    <td class="mono">${num(r.CPU_SEC)}</td>
    <td class="mono">${num(r.BUFFER_GETS)}</td>
    <td class="mono">${num(r.DISK_READS)}</td>
    <td class="mono">${num(r.ROWS_PROCESSED)}</td>
    <td>${esc(r.SCHEMA)}</td>
    <td class="sqltext" title="${esc(r.SQL_TEXT)}">${esc(r.SQL_TEXT)}</td>
  </tr>`).join('');
  bindSqlLinks();
}
$('#sqlFilter').addEventListener('input', drawSqlRows);

// ---- 대기 이벤트 ----
function renderWaits(d) {
  const wc = Array.isArray(d.classes) ? d.classes : [];
  $('#waitClassTable tbody').innerHTML = wc.length ? wc.map((r) => `<tr>
    <td class="${waitClassClass(r.WAIT_CLASS)}">${esc(r.WAIT_CLASS)}</td>
    <td class="mono">${num(r.TOTAL_WAITS)}</td>
    <td class="mono">${num(r.TIME_WAITED_SEC)}</td>
    <td class="mono">${num(r.AVG_MS)}</td>
  </tr>`).join('') : '<tr><td colspan="4" class="empty">데이터 없음</td></tr>';

  const aw = d.active || [];
  $('#activeWaitTable tbody').innerHTML = aw.length ? aw.map((r) => `<tr>
    <td class="${waitClassClass(r.WAIT_CLASS)}">${esc(r.EVENT)}</td>
    <td>${esc(r.WAIT_CLASS)}</td>
    <td class="mono">${num(r.SESSIONS)}</td>
    <td class="mono">${num(r.AVG_WAIT_SEC)}</td>
  </tr>`).join('') : '<tr><td colspan="4" class="empty">현재 대기 중인 활성 세션 없음</td></tr>';
}
async function loadBlocking() {
  const res = await getJSON('/api/blocking');
  const list = (res.ok && res.data.list) || [];
  $('#blockTable tbody').innerHTML = list.length ? list.map((r) => `<tr>
    <td class="mono">${esc(r.WAITER_SID)}</td>
    <td>${esc(r.WAITER_USER)}</td>
    <td class="wc-application">${esc(r.WAITER_EVENT)}</td>
    <td class="mono">${num(r.WAIT_SEC)}</td>
    <td class="blocker-cell">${esc(r.BLOCKER_SID)}</td>
    <td>${esc(r.BLOCKER_USER)}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="empty">블로킹 없음 ✓</td></tr>';
}

// ---- 테이블스페이스 ----
function renderTablespaces(d) {
  const list = d.list || [];
  registerCsv('tablespaces', ['TABLESPACE', 'USED_PCT', 'TOTAL_MB', 'USED_MB', 'FREE_MB'],
    list.map((r) => [r.TABLESPACE_NAME, r.USED_PCT, r.TOTAL_MB, r.USED_MB, r.FREE_MB]));
  const tb = $('#tsTable tbody');
  tb.innerHTML = list.length ? list.map((r) => {
    const p = r.USED_PCT || 0;
    const cls = p >= 90 ? 'crit' : p >= 75 ? 'warn' : '';
    return `<tr>
      <td>${esc(r.TABLESPACE_NAME)}</td>
      <td><div class="pct-cell">
        <div class="pct-bar ${cls}"><span style="width:${Math.min(100, p)}%"></span></div>
        <span class="pct-num">${num(p)}%</span>
      </div></td>
      <td class="mono">${num(r.TOTAL_MB)}</td>
      <td class="mono">${num(r.USED_MB)}</td>
      <td class="mono">${num(r.FREE_MB)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">데이터 없음</td></tr>';
  $('#tsNotice').textContent = d.error || '';
}

// ---- SQL 모달 (전문 + 실행계획) ----
function showMtab(which) {
  $$('.mtab').forEach((b) => b.classList.toggle('active', b.dataset.mtab === which));
  $('#modalBody').classList.toggle('active', which === 'text');
  $('#modalPlan').classList.toggle('active', which === 'plan');
  $('#modalTune').classList.toggle('active', which === 'tune');
}
$$('.mtab').forEach((b) => b.onclick = () => showMtab(b.dataset.mtab));

function renderPlan(plan) {
  const tb = $('#planTable tbody');
  if (!plan || !plan.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">실행계획 없음 (커서가 공유풀에서 밀려났을 수 있음)</td></tr>';
    $('#planPred').innerHTML = '';
    return;
  }
  tb.innerHTML = plan.map((p) => `<tr>
    <td class="mono">${esc(p.ID)}</td>
    <td>${esc(p.OP)}</td>
    <td class="mono">${esc([p.OBJECT_OWNER, p.OBJECT_NAME].filter(Boolean).join('.'))}</td>
    <td class="mono">${p.COST != null ? num(p.COST) : ''}</td>
    <td class="mono">${p.CARDINALITY != null ? num(p.CARDINALITY) : ''}</td>
    <td class="mono">${p.BYTES != null ? num(p.BYTES) : ''}</td>
  </tr>`).join('');
  // 접근/필터 조건자
  const preds = plan.filter((p) => p.ACCESS_PREDICATES || p.FILTER_PREDICATES)
    .map((p) => {
      let s = `Id ${p.ID}:`;
      if (p.ACCESS_PREDICATES) s += `\n  <b>access</b> ${esc(p.ACCESS_PREDICATES)}`;
      if (p.FILTER_PREDICATES) s += `\n  <b>filter</b> ${esc(p.FILTER_PREDICATES)}`;
      return s;
    }).join('\n');
  $('#planPred').innerHTML = preds ? ('Predicate Information:\n' + preds) : '';
}

function bindSqlLinks() {
  $$('.sqlid').forEach((el) => el.onclick = async () => {
    const id = el.dataset.sql;
    $('#modalTitle').textContent = 'SQL_ID: ' + id;
    $('#modalBody').textContent = '불러오는 중…';
    $('#planTable tbody').innerHTML = '<tr><td colspan="6" class="empty">불러오는 중…</td></tr>';
    $('#planPred').innerHTML = '';
    resetTune(id);
    showMtab('text');
    $('#modalBack').classList.add('show');
    const [txt, plan] = await Promise.all([
      getJSON('/api/sql/' + encodeURIComponent(id)),
      getJSON('/api/plan/' + encodeURIComponent(id))
    ]);
    $('#modalBody').textContent = (txt.ok && txt.data.sql_text)
      ? txt.data.sql_text
      : '(SQL 텍스트를 찾을 수 없습니다 - 커서가 공유풀에서 밀려났을 수 있음)';
    renderPlan(plan.ok ? plan.data.plan : []);
  });
}
$('#modalClose').onclick = () => $('#modalBack').classList.remove('show');
$('#modalBack').onclick = (e) => { if (e.target.id === 'modalBack') $('#modalBack').classList.remove('show'); };

// ---- 복사 (clipboard API + 비보안(http) 폴백) ----
async function copyText(str, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(str); ok = true; }
  catch (_) {
    try { const ta = document.createElement('textarea'); ta.value = str; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e) { ok = false; }
  }
  if (btn) { const t = btn.textContent; btn.textContent = ok ? '복사됨 ✓' : '실패'; setTimeout(() => { btn.textContent = t; }, 1200); }
  else toast(ok ? '복사됨' : '복사 실패', ok ? 'ok' : 'err');
}
// 코드블록 복사 (이벤트 위임)
document.addEventListener('click', (e) => {
  const b = e.target.closest('.copy-code');
  if (!b) return;
  const code = b.parentElement.querySelector('pre code') || b.parentElement.querySelector('pre');
  if (code) copyText(code.innerText, b);
});
// 모달 헤더: 현재 탭 전체 복사
let tuneAdviceRaw = '';
$('#modalCopy').onclick = () => {
  const active = (document.querySelector('.mtab.active') || {}).dataset ? document.querySelector('.mtab.active').dataset.mtab : 'text';
  let text = '';
  if (active === 'text') text = $('#modalBody').textContent;
  else if (active === 'plan') text = ($('#planTable').innerText + '\n' + $('#planPred').textContent).trim();
  else if (active === 'tune') text = tuneAdviceRaw || $('#tuneBody').innerText;
  copyText((text || '').trim(), $('#modalCopy'));
};

// ---- AI 튜닝 제안 ----
let tuneSqlId = null;
let tuneConfig = { configured: false, model: '', effort: '', limits: {} };
async function loadTuneConfig() { const r = await getJSON('/api/tune/config'); if (r.ok) tuneConfig = r.data; }
loadTuneConfig();

function tuneMetaText() {
  if (!tuneConfig.configured) return 'ANTHROPIC_API_KEY 미설정 (.env)';
  const L = tuneConfig.limits || {};
  const used = L.usedToday != null ? ` · 오늘 ${L.usedToday}/${L.dailyLimit}회` : '';
  return `모델 ${tuneConfig.model} · effort ${tuneConfig.effort}${used}`;
}
function resetTune(sqlId) {
  tuneSqlId = sqlId;
  loadTuneConfig().then(() => { $('#tuneMeta').textContent = tuneMetaText(); });
  $('#tuneMeta').textContent = tuneMetaText();
  $('#tuneRun').disabled = !tuneConfig.configured;
  $('#tuneBody').innerHTML = tuneConfig.configured
    ? '<div class="tune-empty">SQL 전문·실행계획·테이블 스키마를 모아 Claude에게 튜닝 제안을 요청합니다. 위 버튼을 눌러주세요.<br><span style="font-size:11px">같은 SQL은 캐시되어 재호출 없이 즉시 표시됩니다(비용 절감).</span></div>'
    : '<div class="tune-empty">.env 에 ANTHROPIC_API_KEY 를 설정하면 AI 튜닝 제안을 사용할 수 있습니다.</div>';
}
// 아주 가벼운 마크다운 → HTML (코드블록/헤더/볼드/리스트/인라인코드), XSS 방지 위해 먼저 이스케이프
function renderMarkdown(md) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const codeBlocks = [];
  md = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push('<div class="codeblk"><button type="button" class="copy-code" title="코드 복사">복사</button><pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre></div>');
    return ' @@CODE' + (codeBlocks.length - 1) + '@@ ';
  });
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const cells = (row) => row.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim());
  const lines = md.split('\n');
  let html = '', inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const cb = raw.match(/^\s*@@CODE(\d+)@@\s*$/);
    if (cb) { closeLists(); html += codeBlocks[+cb[1]]; continue; }
    if (/^\s*\|.*\|\s*$/.test(raw) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      closeLists();
      const head = cells(raw);
      let j = i + 2; const body = [];
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { body.push(cells(lines[j])); j++; }
      html += '<table class="md-table"><thead><tr>' + head.map((h) => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of body) html += '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>';
      html += '</tbody></table>';
      i = j - 1; continue;
    }
    const line = raw.trim();
    if (!line) { closeLists(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { closeLists(); const n = m[1].length; html += '<h' + n + '>' + inline(m[2]) + '</h' + n + '>'; }
    else if ((m = line.match(/^[-*]\s+(.*)/))) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += '<li>' + inline(m[1]) + '</li>'; }
    else if ((m = line.match(/^\d+\.\s+(.*)/))) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += '<li>' + inline(m[1]) + '</li>'; }
    else { closeLists(); html += '<p>' + inline(line) + '</p>'; }
  }
  closeLists();
  return html;
}
function renderTuneResult(d, secs) {
  tuneAdviceRaw = d.advice || '';
  const badge = d.cached
    ? `<div class="tune-cachebar">💾 캐시된 제안 · ${new Date(d.cachedAt).toLocaleString('ko-KR', { hour12: false })} 생성 <button id="tuneRegen" class="mini-btn">🔄 새로 생성</button></div>`
    : '';
  const foot = `<p style="color:var(--muted);font-size:11px;margin-top:16px">분석 테이블: ${d.tables.join(', ') || '없음'} · ${d.model}${d.cached ? ' · 캐시' : (secs != null ? ` · ${secs}초` : '')}${d.usage ? ` · 토큰 in ${d.usage.input}/out ${d.usage.output}` : ''}</p>`;
  $('#tuneBody').innerHTML = badge + renderMarkdown(d.advice) + foot;
  bindSqlLinks();
  const regen = document.getElementById('tuneRegen');
  if (regen) regen.onclick = () => runTune(true);
  loadTuneConfig().then(() => { $('#tuneMeta').textContent = tuneMetaText(); });
}
async function runTune(force) {
  if (!tuneSqlId) return;
  const t0 = Date.now();
  $('#tuneRun').disabled = true;
  $('#tuneBody').innerHTML = '<div class="tune-loading"><span class="spin">✨</span> 분석 준비 중… (캐시 있으면 즉시)</div>';
  let resp;
  try { resp = await fetch('/api/tune/' + encodeURIComponent(tuneSqlId) + (force ? '?force=1' : ''), { method: 'POST' }); }
  catch (e) { $('#tuneBody').innerHTML = `<div class="tune-empty">요청 실패: ${esc(e.message)}</div>`; $('#tuneRun').disabled = false; return; }
  if (resp.status === 401) { showLogin(); $('#tuneRun').disabled = false; return; }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', acc = '', streaming = false, doneData = null, cachedData = null, errorMsg = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 2);
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
      if (ev.type === 'cached') cachedData = ev.data;
      else if (ev.type === 'thinking') { $('#tuneBody').innerHTML = '<div class="tune-loading"><span class="spin">🧠</span> 스키마·실행계획 분석 중… (잠시 후 답변이 흐릅니다)</div>'; }
      else if (ev.type === 'delta') {
        if (!streaming) { streaming = true; $('#tuneBody').innerHTML = '<pre class="tune-stream"></pre>'; }
        acc += ev.text;
        const p = $('#tuneBody .tune-stream');
        if (p) { p.textContent = acc; p.scrollTop = p.scrollHeight; }
      } else if (ev.type === 'done') doneData = ev.data;
      else if (ev.type === 'error') errorMsg = ev.error;
    }
  }
  $('#tuneRun').disabled = false;
  if (errorMsg) { $('#tuneBody').innerHTML = `<div class="tune-empty">${esc(errorMsg)}</div>`; return; }
  const d = doneData || cachedData;
  if (!d) { $('#tuneBody').innerHTML = '<div class="tune-empty">응답이 없습니다.</div>'; return; }
  renderTuneResult(d, ((Date.now() - t0) / 1000).toFixed(0));
}
$('#tuneRun').onclick = () => runTune(false);

// ---- 진행 작업 (longops) ----
async function loadLongops() {
  const res = await getJSON('/api/longops');
  const list = (res.ok && res.data.list) || [];
  registerCsv('longops', ['SID', 'SERIAL', 'USER', 'OPNAME', 'TARGET', 'SOFAR', 'TOTALWORK', 'UNITS', 'PCT', 'ELAPSED_SEC', 'TIME_REMAINING', 'SQL_ID', 'START'],
    list.map((r) => [r.SID, r.SERIAL, r.USERNAME, r.OPNAME, r.TARGET, r.SOFAR, r.TOTALWORK, r.UNITS, r.PCT, r.ELAPSED_SECONDS, r.TIME_REMAINING, r.SQL_ID, r.START_T]));
  const tb = $('#longopsTable tbody');
  if (!list.length) { tb.innerHTML = '<tr><td colspan="11" class="empty">진행/최근 대형 작업 없음</td></tr>'; return; }
  tb.innerHTML = list.map((r) => {
    const pct = r.PCT != null ? r.PCT : 0;
    const running = r.TIME_REMAINING > 0;
    const done = pct >= 100 || !running;
    const sqlCell = r.SQL_ID ? `<span class="sqlid" data-sql="${esc(r.SQL_ID)}">${esc(r.SQL_ID)}</span>` : '';
    return `<tr class="${running ? 'lop-running' : ''}">
      <td class="mono">${esc(r.SID)},${esc(r.SERIAL)}</td>
      <td>${esc(r.USERNAME)}</td>
      <td>${esc(r.OPNAME)}</td>
      <td class="mono">${esc(r.TARGET || '')}</td>
      <td><div class="lop-bar">
        <div class="lop-track ${done ? 'done' : ''}"><span style="width:${Math.min(100, pct)}%"></span></div>
        <span class="lop-num">${num(Math.min(100, pct))}%</span>
      </div></td>
      <td class="mono">${num(r.SOFAR)} / ${num(r.TOTALWORK)}</td>
      <td>${esc(r.UNITS || '')}</td>
      <td class="mono">${num(r.ELAPSED_SECONDS)}</td>
      <td class="mono">${running ? num(r.TIME_REMAINING) : ''}</td>
      <td>${sqlCell}</td>
      <td class="mono">${esc(r.START_T)}</td>
    </tr>`;
  }).join('');
  bindSqlLinks();
}

// ---- 대시보드 (Grafana 스타일) ----
const CHART_DEFS = [
  { key: 'cpu', title: 'Host CPU %', color: 'var(--accent)', min: 0, max: 100, unit: '%' },
  { key: 'aas', title: 'Average Active Sessions', color: 'var(--purple)', min: 0 },
  { key: 'sessActive', title: '활성 세션 수', color: 'var(--green)', min: 0 },
  { key: 'execs', title: 'Executions / sec', color: 'var(--accent)', min: 0 },
  { key: 'preads', title: 'Physical Reads / sec', color: 'var(--amber)', min: 0 },
  { key: 'utxn', title: 'User Transactions / sec', color: 'var(--purple)', min: 0 }
];
async function loadDashboard() {
  const [h, cpuEv] = await Promise.all([getJSON('/api/history'), getJSON('/api/events/cpu')]);
  const points = (h.ok && h.data.points) || [];
  const cfg = (h.ok && h.data.config) || {};
  const last = points[points.length - 1] || {};
  const tiles = [
    { k: 'CPU', v: last.cpu != null ? num(last.cpu) + '%' : '-', lvl: last.cpu >= 85 ? 'crit' : last.cpu >= 70 ? 'warn' : 'good' },
    { k: '활성 세션', v: num(last.sessActive), lvl: '' },
    { k: '차단 세션', v: num(last.sessBlocked), lvl: last.sessBlocked > 0 ? 'crit' : 'good' },
    { k: '전체 세션', v: num(last.sessTotal), lvl: '' },
    { k: 'AAS', v: num(last.aas), lvl: last.aas >= 10 ? 'warn' : '' },
    { k: 'Exec/s', v: num(last.execs), lvl: '' }
  ];
  $('#statRow').innerHTML = tiles.map((t) => `<div class="stat-tile ${t.lvl}"><div class="st-k">${esc(t.k)}</div><div class="st-v">${t.v}</div></div>`).join('');
  $('#chartGrid').innerHTML = CHART_DEFS.map((def) => {
    const series = points.map((p) => p[def.key]);
    const nowv = series[series.length - 1];
    return `<div class="chart-panel">
      <div class="cp-head"><span class="cp-title">${esc(def.title)}</span><span class="cp-now" style="color:${def.color}">${nowv != null ? num(nowv) + (def.unit || '') : '-'}</span></div>
      ${lineChart(series, { color: def.color, min: def.min, max: def.max })}
    </div>`;
  }).join('');
  $('#dashFoot').textContent = `수집 간격 ${(cfg.SAMPLE_MS || 0) / 1000}s · 보관 ${points.length}포인트(최대 ${cfg.MAX_POINTS || '-'}) · CPU 스파이크 임계치 ${cfg.CPU_SPIKE_PCT || '-'}% · Prometheus: /metrics`;

  const events = ((cpuEv.ok && cpuEv.data.events) || []).filter((e) => !e.resolve);
  window.__spikes = events;
  registerCsv('spikes', ['시각', 'CPU%', 'AAS', '활성세션', 'TopSQL'],
    events.map((e) => [e.started, e.cpu, e.aas, e.activeSessions, e.topSql && e.topSql[0] ? e.topSql[0].sql_id : '']));
  const tb = $('#spikeTable tbody');
  tb.innerHTML = events.length ? events.map((e, i) => {
    const top = e.topSql && e.topSql[0];
    return `<tr>
      <td class="mono">${esc(new Date(e.ts).toLocaleString('ko-KR', { hour12: false }))}</td>
      <td class="mono st-active">${num(e.cpu)}</td>
      <td class="mono">${num(e.aas)}</td>
      <td class="mono">${num(e.activeSessions)}</td>
      <td>${top ? `<span class="sqlid" data-sql="${esc(top.sql_id)}">${esc(top.sql_id || '(no sql)')}</span> <span class="mono">×${top.count}</span>` : '-'}</td>
      <td><button class="mini-btn spike-detail" data-i="${i}">상세</button></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">기록된 CPU 스파이크 없음 (임계치 미도달)</td></tr>';
  bindSqlLinks();
  $$('.spike-detail').forEach((b) => b.onclick = () => showSpike(window.__spikes[b.dataset.i]));
  $('#spikeNotice').textContent = `Host CPU 가 ${cfg.CPU_SPIKE_PCT || 85}% 를 넘는 순간의 활성 세션·SQL 스냅샷을 자동으로 남깁니다.`;
  loadBaseline();
}
function showSpike(e) {
  if (!e) return;
  const rows = (e.sessions || []).map((s) => `<tr>
    <td class="mono">${esc(s.SID)}</td><td>${esc(s.USERNAME)}</td>
    <td>${s.SQL_ID ? `<span class="sqlid" data-sql="${esc(s.SQL_ID)}">${esc(s.SQL_ID)}</span>` : ''}</td>
    <td class="${waitClassClass(s.WAIT_CLASS)}">${esc(s.EVENT)}</td>
    <td>${esc(s.MACHINE)}</td><td class="sqltext" title="${esc(s.SQL_TEXT)}">${esc(s.SQL_TEXT)}</td></tr>`).join('');
  const tops = (e.topSql || []).map((t) => `<tr>
    <td>${t.sql_id ? `<span class="sqlid" data-sql="${esc(t.sql_id)}">${esc(t.sql_id)}</span>` : '(no sql)'}</td>
    <td class="mono">${t.count}</td><td class="sqltext" title="${esc(t.sample_text)}">${esc(t.sample_text)}</td></tr>`).join('');
  $('#spikeTitle').textContent = `CPU 스파이크 · ${new Date(e.ts).toLocaleString('ko-KR', { hour12: false })} · ${num(e.cpu)}%`;
  $('#spikeBody').innerHTML = `
    <div class="kv">CPU <b>${num(e.cpu)}%</b> · AAS <b>${num(e.aas)}</b> · 활성 세션 <b>${num(e.activeSessions)}</b></div>
    <h4>원인 추정 Top SQL (활성 세션 수 기준)</h4>
    <table><thead><tr><th>SQL_ID</th><th>세션수</th><th>SQL</th></tr></thead><tbody>${tops || '<tr><td colspan="3" class="empty">없음</td></tr>'}</tbody></table>
    <h4>당시 활성 세션 (상위 20)</h4>
    <table><thead><tr><th>SID</th><th>사용자</th><th>SQL_ID</th><th>이벤트</th><th>머신</th><th>SQL</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">없음</td></tr>'}</tbody></table>`;
  $('#spikeBack').classList.add('show');
  bindSqlLinks();
}
$('#spikeClose').onclick = () => $('#spikeBack').classList.remove('show');
$('#spikeBack').onclick = (e) => { if (e.target.id === 'spikeBack') $('#spikeBack').classList.remove('show'); };

// ---- 락 / 데드락 ----
async function loadLocks() {
  const [blk, hist, dl] = await Promise.all([
    getJSON('/api/blocking'), getJSON('/api/events/locks'), getJSON('/api/deadlocks')
  ]);
  // 1) 실시간 블로킹
  const live = (blk.ok && blk.data.list) || [];
  registerCsv('liveblock',
    ['WAIT_SEC', 'WAITER_SID', 'WAITER_USER', 'WAITER_SQL', 'EVENT', 'LOCKED_OBJ', 'BLOCKER_SID', 'BLOCKER_USER', 'BLOCKER_SQL', 'BLOCKER_STATUS'],
    live.map((r) => [r.WAIT_SEC, r.WAITER_SID, r.WAITER_USER, r.WAITER_SQL, r.WAITER_EVENT, r.LOCKED_OBJ, r.BLOCKER_SID, r.BLOCKER_USER, r.BLOCKER_SQL, r.BLOCKER_STATUS]));
  $('#liveBlockTable tbody').innerHTML = live.length ? live.map((r) => {
    const action = (mode === 'dba')
      ? `<button class="kill-btn" data-sid="${esc(r.BLOCKER_SID)}" data-serial="${esc(r.BLOCKER_SERIAL)}" data-user="${esc(r.BLOCKER_USER)}">Blocker KILL</button>`
      : '<span class="mode-ro">—</span>';
    return `<tr>
      <td class="mono st-killed">${num(r.WAIT_SEC)}</td>
      <td class="mono">${esc(r.WAITER_SID)},${esc(r.WAITER_SERIAL)}</td>
      <td>${esc(r.WAITER_USER)}</td>
      <td>${r.WAITER_SQL ? `<span class="sqlid" data-sql="${esc(r.WAITER_SQL)}">${esc(r.WAITER_SQL)}</span>` : ''}</td>
      <td class="wc-application">${esc(r.WAITER_EVENT)}</td>
      <td class="mono">${esc(r.LOCKED_OBJ || '')}</td>
      <td class="blocker-cell">${esc(r.BLOCKER_SID)},${esc(r.BLOCKER_SERIAL)}</td>
      <td>${esc(r.BLOCKER_USER)}</td>
      <td>${r.BLOCKER_SQL ? `<span class="sqlid" data-sql="${esc(r.BLOCKER_SQL)}">${esc(r.BLOCKER_SQL)}</span>` : ''}</td>
      <td>${esc(r.BLOCKER_STATUS)}</td>
      <td>${action}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="11" class="empty">현재 블로킹 세션 없음 ✓</td></tr>';

  // 2) 블로킹 감지 이력 (수집기 로그)
  const events = (hist.ok && hist.data.events) || [];
  $('#lockHistSub').textContent = `(${events.length}건 · blocker/waiter SQL_ID 자동 기록)`;
  registerCsv('lockhist',
    ['감지시각', 'WAIT_SEC', 'WAITER_SID', 'WAITER_SQL', 'BLOCKER_SID', 'BLOCKER_USER', 'BLOCKER_SQL', 'LOCKED_OBJ'],
    events.map((e) => [e.detected, e.wait_sec, e.waiter && e.waiter.sid, e.waiter && e.waiter.sql_id, e.blocker && e.blocker.sid, e.blocker && e.blocker.user, e.blocker && e.blocker.sql_id, e.locked_obj]));
  $('#lockHistTable tbody').innerHTML = events.length ? events.map((e) => {
    const w = e.waiter || {}, b = e.blocker || {};
    return `<tr>
      <td class="mono">${esc(new Date(e.ts).toLocaleString('ko-KR', { hour12: false }))}</td>
      <td class="mono">${num(e.wait_sec)}</td>
      <td class="mono">${esc(w.sid)}</td>
      <td>${w.sql_id ? `<span class="sqlid" data-sql="${esc(w.sql_id)}">${esc(w.sql_id)}</span>` : ''}</td>
      <td class="blocker-cell">${esc(b.sid)}</td>
      <td>${esc(b.user)}</td>
      <td>${b.sql_id ? `<span class="sqlid" data-sql="${esc(b.sql_id)}">${esc(b.sql_id)}</span>` : ''}</td>
      <td class="mono">${esc(e.locked_obj || '')}</td>
      <td><span class="mode-ro" title="과거 이력이라 KILL 불가(serial 재사용 위험). 실시간 블로킹 표에서 KILL 하세요.">기록</span></td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">감지된 블로킹 이력 없음</td></tr>';

  // 3) 실제 데드락 이력 (alert log)
  const dld = (dl.ok && dl.data) || {};
  const dlist = dld.list || [];
  registerCsv('deadlocks', ['발생시각', '트레이스파일'], dlist.map((d) => [d.t, d.trace]));
  $('#deadlockTable tbody').innerHTML = dlist.length ? dlist.map((d) => `<tr>
    <td class="mono st-killed">${esc(d.t)}</td><td class="mono sqltext" title="${esc(d.trace)}">${esc(d.trace || '')}</td>
  </tr>`).join('') : `<tr><td colspan="2" class="empty">${dld.loading ? 'alert log 수집 중… (수십초 소요, 잠시 후 다시 확인)' : '최근 데드락 기록 없음'}</td></tr>`;
  let note = '';
  if (dld.error) note = '⚠ ' + dld.error;
  else if (dld.loading && !dlist.length) note = 'alert log(v$diag_alert_ext) 스캔은 느려서 백그라운드로 수집합니다. 잠시 후 자동 표시됩니다.';
  else if (dld.fetchedAt) note = `마지막 수집: ${new Date(dld.fetchedAt).toLocaleString('ko-KR', { hour12: false })} · ORA-00060 은 alert log 에만 남고 SQL_ID 가 없어 트레이스 파일을 참고합니다. 실시간 SQL_ID 는 위의 블로킹 표를 보세요.`;
  $('#dlNotice').textContent = note;

  bindSqlLinks();
  bindKillButtons();
}
$('#dlRefresh').onclick = async () => {
  toast('alert log 재수집 시작 (백그라운드, 수십초)', 'ok');
  await getJSON('/api/deadlocks?refresh=1');
  setTimeout(() => { if (currentTab === 'locks') loadLocks(); }, 3000);
};

// ---- ASH (자체 액티브 세션 히스토리) ----
//   주의: ASH 데이터는 SQLite 에서 오므로 컬럼명이 소문자다 (Oracle 은 대문자).
const emptyRow = (c) => `<tr><td colspan="${c}" class="empty">데이터 없음 (수집 대기 중)</td></tr>`;
async function loadAsh() {
  const minutes = parseInt($('#ashWindow').value, 10);
  const res = await getJSON('/api/ash?minutes=' + minutes);
  if (!res.ok) return;
  const d = res.data;
  $('#ashTimeline').innerHTML = lineChart(d.timeline.map((p) => p.aas), { color: 'var(--purple)', min: 0 });

  const totSql = d.topSql.reduce((a, b) => a + b.samples, 0) || 1;
  registerCsv('ashsql', ['SQL_ID', 'SAMPLES', 'SESSIONS'], d.topSql.map((r) => [r.sql_id, r.samples, r.sessions]));
  $('#ashSqlTable tbody').innerHTML = d.topSql.length ? d.topSql.map((r) => `<tr>
    <td><span class="sqlid" data-sql="${esc(r.sql_id)}">${esc(r.sql_id)}</span></td>
    <td class="mono">${num(r.samples)}</td><td class="mono">${num(r.sessions)}</td>
    <td class="mono">${(r.samples / totSql * 100).toFixed(1)}%</td></tr>`).join('') : emptyRow(4);

  const totEvt = d.topEvents.reduce((a, b) => a + b.samples, 0) || 1;
  registerCsv('ashevt', ['EVENT', 'WAIT_CLASS', 'SAMPLES'], d.topEvents.map((r) => [r.event, r.wait_class, r.samples]));
  $('#ashEvtTable tbody').innerHTML = d.topEvents.length ? d.topEvents.map((r) => `<tr>
    <td class="${waitClassClass(r.wait_class)}">${esc(r.event)}</td><td>${esc(r.wait_class)}</td>
    <td class="mono">${num(r.samples)}</td><td class="mono">${(r.samples / totEvt * 100).toFixed(1)}%</td></tr>`).join('') : emptyRow(4);

  registerCsv('ashsess', ['SID', 'USER', 'MACHINE', 'SAMPLES', 'SQLS'], d.topSessions.map((r) => [r.sid, r.username, r.machine, r.samples, r.sqls]));
  $('#ashSessTable tbody').innerHTML = d.topSessions.length ? d.topSessions.map((r) => `<tr>
    <td><span class="sid-link" data-sid="${esc(r.sid)}">${esc(r.sid)}</span></td><td>${esc(r.username)}</td>
    <td>${esc(r.machine)}</td><td class="mono">${num(r.samples)}</td><td class="mono">${num(r.sqls)}</td></tr>`).join('') : emptyRow(5);

  bindSqlLinks(); bindSidLinks();
}
$('#ashWindow').addEventListener('change', loadAsh);

// ---- 용량 (테이블스페이스 + 아카이브 + 세그먼트) ----
async function loadCapacity() {
  const [ts, arc, seg] = await Promise.all([
    getJSON('/api/tablespaces'), getJSON('/api/archivelog'), getJSON('/api/segments')
  ]);
  if (ts.ok) renderTablespaces(ts.data);

  const alist = (arc.ok && arc.data.list) || [];
  registerCsv('archivelog', ['HR', 'LOGS', 'MB'], alist.map((r) => [r.HR, r.LOGS, r.MB]));
  $('#arcChart').innerHTML = lineChart(alist.map((r) => r.MB), { color: 'var(--amber)', min: 0 });
  const totMb = alist.reduce((a, b) => a + (b.MB || 0), 0);
  $('#arcTotal').textContent = totMb ? num(Math.round(totMb)) + ' MB / 24h' : '';
  $('#arcNotice').textContent = (arc.ok && arc.data.error) ? arc.data.error : '';

  const slist = (seg.ok && seg.data.list) || [];
  registerCsv('segments', ['OWNER', 'SEGMENT', 'TYPE', 'TABLESPACE', 'MB'], slist.map((r) => [r.OWNER, r.SEGMENT_NAME, r.SEGMENT_TYPE, r.TABLESPACE_NAME, r.MB]));
  $('#segTable tbody').innerHTML = slist.length ? slist.map((r) => `<tr>
    <td>${esc(r.OWNER)}</td><td class="mono">${esc(r.SEGMENT_NAME)}</td><td>${esc(r.SEGMENT_TYPE)}</td>
    <td class="mono">${esc(r.TABLESPACE_NAME)}</td><td class="mono">${num(r.MB)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">데이터 없음</td></tr>';
  $('#segNotice').textContent = (seg.ok && seg.data.error) ? seg.data.error : '';
}

// ---- 설정 (알림) ----
async function loadSettings() {
  const [cfg, rec] = await Promise.all([getJSON('/api/alerts/config'), getJSON('/api/recipients')]);
  if (cfg.ok) {
    const c = cfg.data;
    $('#alertToggle').checked = c.enabled;
    $('#alertState').textContent = c.enabled ? '켜짐' : '꺼짐';
    $('#smtpState').textContent = c.configured ? 'SMTP 연결 설정됨' : '미설정 (.env SMTP_HOST)';
    $('#smtpState').style.color = c.configured ? 'var(--green)' : 'var(--amber)';
    $('#alertLogTable tbody').innerHTML = (c.log && c.log.length) ? c.log.map((l) => `<tr>
      <td class="mono">${esc(new Date(l.ts).toLocaleString('ko-KR', { hour12: false }))}</td>
      <td>${esc(l.kind)}</td><td class="sqltext" title="${esc(l.subject)}">${esc(l.subject)}</td>
      <td class="${l.ok ? 'st-active' : 'st-killed'}">${l.ok ? '성공' : '실패'}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">발송 이력 없음</td></tr>';
    // 임계치 입력 채우기
    const t = c.thresholds || {};
    if (document.activeElement !== $('#thCpu')) $('#thCpu').value = t.CPU_SPIKE_PCT ?? '';
    if (document.activeElement !== $('#thBlock')) $('#thBlock').value = t.BLOCK_SEC ?? '';
    if (document.activeElement !== $('#thTs')) $('#thTs').value = t.TS_ALERT_PCT ?? '';
  }
  if (rec.ok) renderRecipients(rec.data.list);
  // 감사 로그
  const aud = await getJSON('/api/audit');
  const list = (aud.ok && aud.data.list) || [];
  registerCsv('audit', ['시각', '사용자', '액션', '대상', '비고'], list.map((a) => [new Date(a.ts).toLocaleString('ko-KR', { hour12: false }), a.usr_id, a.action, a.target, a.detail]));
  $('#auditTable tbody').innerHTML = list.length ? list.map((a) => `<tr>
    <td class="mono">${esc(new Date(a.ts).toLocaleString('ko-KR', { hour12: false }))}</td>
    <td>${esc(a.usr_id)}</td>
    <td class="${a.action === 'KILL' ? 'st-killed' : ''}">${esc(a.action)}</td>
    <td class="mono">${esc(a.target || '')}</td><td class="mono">${esc(a.detail || '')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">기록 없음</td></tr>';
}
$('#thSave').onclick = async () => {
  const body = { cpuSpike: parseFloat($('#thCpu').value), blockSec: parseInt($('#thBlock').value, 10), tsPct: parseFloat($('#thTs').value) };
  const r = await fetch('/api/settings/thresholds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  toast(r.ok ? '임계치 저장됨 (즉시 반영)' : '저장 실패: ' + (r.error || ''), r.ok ? 'ok' : 'err');
};
function renderRecipients(list) {
  $('#recipList').innerHTML = list.length
    ? list.map((e) => `<li>${esc(e)}<button data-email="${esc(e)}" title="삭제">✕</button></li>`).join('')
    : '<li class="empty">등록된 수신자 없음</li>';
  $$('#recipList button').forEach((b) => b.onclick = async () => {
    const r = await fetch('/api/recipients/' + encodeURIComponent(b.dataset.email), { method: 'DELETE' }).then((x) => x.json()).catch(() => ({ ok: false }));
    if (r.ok) { renderRecipients(r.data.list); toast('수신자 삭제', 'ok'); }
  });
}
$('#recipAdd').onclick = async () => {
  const email = $('#recipInput').value.trim();
  if (!email) return;
  const r = await fetch('/api/recipients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  if (r.ok) { $('#recipInput').value = ''; renderRecipients(r.data.list); toast('수신자 추가', 'ok'); }
  else toast(r.error || '추가 실패', 'err');
};
$('#recipInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#recipAdd').click(); });
$('#alertToggle').addEventListener('change', async (e) => {
  const r = await fetch('/api/alerts/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) }).then((x) => x.json()).catch(() => ({ ok: false }));
  if (r.ok) { $('#alertState').textContent = r.data.enabled ? '켜짐' : '꺼짐'; toast('알림 ' + (r.data.enabled ? '켜짐' : '꺼짐'), 'ok'); }
});
$('#alertTest').onclick = async () => {
  toast('테스트 메일 발송 중…');
  const r = await fetch('/api/alerts/test', { method: 'POST' }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  toast(r.ok ? `테스트 메일 발송 완료 (${r.data.sent}명)` : '실패: ' + (r.error || ''), r.ok ? 'ok' : 'err');
  if (currentTab === 'settings') loadSettings();
};

// ---- 세션 상세 모달 ----
function bindSidLinks() {
  $$('.sid-link').forEach((el) => el.onclick = () => showSessionDetail(el.dataset.sid));
}
async function showSessionDetail(sid) {
  $('#sessTitle').textContent = 'SID ' + sid + ' 상세';
  $('#sessDetailBody').innerHTML = '불러오는 중…';
  $('#sessBack').classList.add('show');
  const res = await getJSON('/api/session/' + encodeURIComponent(sid));
  if (!res.ok) { $('#sessDetailBody').textContent = '조회 실패'; return; }
  const s = res.data.session, stats = res.data.stats || [];
  if (!s) { $('#sessDetailBody').innerHTML = '<div class="empty">세션이 존재하지 않습니다 (이미 종료됨)</div>'; return; }
  const statRows = stats.map((x) => `<tr><td>${esc(x.NAME)}</td><td class="mono">${num(x.VALUE)}</td></tr>`).join('');
  const kill = (mode === 'dba' && s.USERNAME) ? `<button class="kill-btn" data-sid="${esc(s.SID)}" data-serial="${esc(s.SERIAL)}" data-user="${esc(s.USERNAME)}">KILL</button>` : '';
  $('#sessDetailBody').innerHTML = `
    <div class="kv" style="margin-bottom:10px">${esc(s.USERNAME)} · <b>${esc(s.STATUS)}</b> · ${esc(s.MACHINE)} · ${esc(s.PROGRAM)} ${kill}</div>
    <table>
      <tr><td class="kv">SID,Serial</td><td><b>${esc(s.SID)},${esc(s.SERIAL)}</b></td></tr>
      <tr><td class="kv">OS User</td><td>${esc(s.OSUSER)}</td></tr>
      <tr><td class="kv">Module / Action</td><td>${esc(s.MODULE)} / ${esc(s.ACTION)}</td></tr>
      <tr><td class="kv">서버/서비스</td><td>${esc(s.SERVER)} / ${esc(s.SERVICE_NAME)}</td></tr>
      <tr><td class="kv">로그온</td><td>${esc(s.LOGON_TIME)} (경과 ${num(s.LAST_CALL_ET)}s)</td></tr>
      <tr><td class="kv">현재/직전 SQL</td><td>${s.SQL_ID ? `<span class="sqlid" data-sql="${esc(s.SQL_ID)}">${esc(s.SQL_ID)}</span>` : '-'} / ${s.PREV_SQL_ID ? `<span class="sqlid" data-sql="${esc(s.PREV_SQL_ID)}">${esc(s.PREV_SQL_ID)}</span>` : '-'}</td></tr>
      <tr><td class="kv">대기</td><td class="${waitClassClass(s.WAIT_CLASS)}">${esc(s.EVENT)} (${esc(s.WAIT_CLASS)}) ${num(s.SECONDS_IN_WAIT)}s</td></tr>
      <tr><td class="kv">Blocker</td><td>${s.BLOCKING_SESSION != null ? '<span class="blocker-cell">' + esc(s.BLOCKING_SESSION) + '</span>' : '-'}</td></tr>
    </table>
    <h4>세션 통계 (v$sesstat)</h4>
    <table><thead><tr><th>통계</th><th>값</th></tr></thead><tbody>${statRows || '<tr><td colspan="2" class="empty">없음</td></tr>'}</tbody></table>`;
  bindSqlLinks(); bindKillButtons();
}
$('#sessDetailClose').onclick = () => $('#sessBack').classList.remove('show');
$('#sessBack').onclick = (e) => { if (e.target.id === 'sessBack') $('#sessBack').classList.remove('show'); };

// ---- 새로고침 오케스트레이션 ----
async function refresh() {
  health();
  let res;
  if (currentTab === 'overview') {
    res = await getJSON('/api/overview'); if (res.ok) renderOverview(res.data);
  } else if (currentTab === 'dashboard') {
    loadDashboard();
  } else if (currentTab === 'ash') {
    loadAsh();
  } else if (currentTab === 'capacity') {
    loadCapacity();
  } else if (currentTab === 'settings') {
    loadSettings();
  } else if (currentTab === 'locks') {
    loadLocks();
  } else if (currentTab === 'sessions') {
    res = await getJSON('/api/sessions'); if (res.ok) renderSessions(res.data);
  } else if (currentTab === 'topsql') {
    res = await getJSON('/api/topsql'); if (res.ok) renderTopSql(res.data);
  } else if (currentTab === 'waits') {
    res = await getJSON('/api/waits'); if (res.ok) renderWaits(res.data);
    loadBlocking();
  } else if (currentTab === 'longops') {
    loadLongops();
  }
  $('#lastUpd').textContent = fmtTime(Date.now());
}

function setInterval_(ms) {
  if (timer) { clearInterval(timer); timer = null; }
  if (ms > 0) timer = setInterval(refresh, ms);
}
$('#intervalSel').addEventListener('change', (e) => { setInterval_(parseInt(e.target.value, 10)); localStorage.setItem('oramon_interval', e.target.value); });
$('#refreshBtn').addEventListener('click', refresh);

// ---- 인증 / 시작 ----
function showLogin() {
  $('#loginBack').classList.add('show');
  if (timer) { clearInterval(timer); timer = null; }
  $('#userBox').style.display = 'none';
  setTimeout(() => $('#loginId').focus(), 50);
}
function hideLogin() { $('#loginBack').classList.remove('show'); }

let appStarted = false;
function startApp() {
  hideLogin();
  if (typeof restoreUiPrefs === 'function') restoreUiPrefs();
  refresh();
  if (!appStarted) { setInterval_(parseInt($('#intervalSel').value, 10)); appStarted = true; }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usrId = $('#loginId').value.trim();
  const password = $('#loginPw').value;
  $('#loginErr').textContent = '';
  $('#loginBtn').disabled = true; $('#loginBtn').textContent = '로그인 중…';
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usrId, password }) })
    .then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  $('#loginBtn').disabled = false; $('#loginBtn').textContent = '로그인';
  if (r.ok) {
    $('#loginPw').value = '';
    $('#userBox').style.display = 'flex';
    $('#userName').textContent = r.data.usrId;
    startApp();
  } else {
    $('#loginErr').textContent = r.error || '로그인 실패';
  }
});
$('#logoutBtn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
};

async function initApp() {
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({ ok: false }));
  const authEnabled = me.ok && me.data.authEnabled;
  const user = me.ok && me.data.user;
  if (authEnabled && !user) { showLogin(); return; }
  if (user) { $('#userBox').style.display = 'flex'; $('#userName').textContent = user.usrId; }
  startApp();
}
initApp();
