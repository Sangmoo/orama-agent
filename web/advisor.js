// =============================================================
//  ORAMON - AI 튜닝 제안 (Claude API)
//  SQL 전문 + 실행계획 + 관련 테이블 스키마/통계를 모아 Claude 에 보내
//  튜닝 제안을 받는다. API 키는 서버 .env 에만 두고 클라이언트로 나가지 않는다.
// =============================================================
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const Q = require('./queries');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT_ALLOWED = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT = EFFORT_ALLOWED.includes((process.env.ANTHROPIC_EFFORT || '').toLowerCase())
  ? process.env.ANTHROPIC_EFFORT.toLowerCase() : 'medium';

let client = null;
function ready() {
  if (client) return true;
  if (!process.env.ANTHROPIC_API_KEY) return false;
  client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수 자동 사용
  return true;
}
function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

// dba_ 뷰 우선, 권한 없으면 all_ 로 fallback
async function tryQuery(primary, fallback, binds) {
  try { return await db.query(primary, binds); }
  catch (_) { try { return await db.query(fallback, binds); } catch (_) { return []; } }
}

// SQL 컨텍스트 수집
async function gatherContext(sqlId) {
  const [textRows, planRows, statRows, tableRows] = await Promise.all([
    db.query(Q.SQL_FULLTEXT, { sql_id: sqlId }).catch(() => []),
    db.query(Q.SQL_PLAN, { sql_id: sqlId }).catch(() => []),
    db.query(Q.SQLSTAT_BY_ID, { sql_id: sqlId }).catch(() => []),
    db.query(Q.PLAN_TABLES, { sql_id: sqlId }).catch(() => [])
  ]);
  const sqlText = textRows[0] ? textRows[0].SQL_TEXT : null;
  const stat = statRows[0] || null;

  // 관련 테이블 최대 8개까지 스키마/인덱스/통계 수집
  const tables = [];
  for (const t of tableRows.slice(0, 8)) {
    const owner = t.OBJECT_OWNER, tbl = t.OBJECT_NAME;
    const [cols, idx, tstat] = await Promise.all([
      tryQuery(Q.TABLE_COLUMNS, Q.TABLE_COLUMNS_ALL, { owner, tbl }),
      tryQuery(Q.TABLE_INDEXES, Q.TABLE_INDEXES_ALL, { owner, tbl }),
      tryQuery(Q.TABLE_STATS, Q.TABLE_STATS_ALL, { owner, tbl })
    ]);
    tables.push({ owner, table: tbl, columns: cols.slice(0, 80), indexes: idx, stats: tstat[0] || null });
  }
  return { sqlId, sqlText, plan: planRows, stat, tables };
}

// 컨텍스트를 프롬프트 텍스트로 직렬화
function buildContextText(ctx) {
  const lines = [];
  lines.push(`## SQL_ID: ${ctx.sqlId}`);
  if (ctx.stat) {
    const s = ctx.stat;
    lines.push(`## 실행 통계`);
    lines.push(`- 실행수: ${s.EXECUTIONS}, 총 Elapsed: ${s.ELAPSED_SEC}s, 초/실행: ${s.SEC_PER_EXEC}, CPU: ${s.CPU_SEC}s`);
    lines.push(`- Buffer Gets: ${s.BUFFER_GETS}, Disk Reads: ${s.DISK_READS}, Rows: ${s.ROWS_PROCESSED}, 파싱스키마: ${s.PARSING_SCHEMA_NAME}`);
  }
  lines.push(`\n## SQL 전문\n\`\`\`sql\n${(ctx.sqlText || '(조회 실패)').slice(0, 8000)}\n\`\`\``);

  if (ctx.plan && ctx.plan.length) {
    lines.push(`\n## 실행계획 (v$sql_plan)`);
    lines.push('```');
    for (const p of ctx.plan) {
      const obj = [p.OBJECT_OWNER, p.OBJECT_NAME].filter(Boolean).join('.');
      lines.push(`${String(p.ID).padStart(3)} | ${p.OP || ''} | ${obj} | cost=${p.COST ?? ''} rows=${p.CARDINALITY ?? ''} bytes=${p.BYTES ?? ''}`);
      if (p.ACCESS_PREDICATES) lines.push(`      access: ${p.ACCESS_PREDICATES}`);
      if (p.FILTER_PREDICATES) lines.push(`      filter: ${p.FILTER_PREDICATES}`);
    }
    lines.push('```');
  }

  if (ctx.tables.length) {
    lines.push(`\n## 관련 테이블 스키마`);
    for (const t of ctx.tables) {
      const st = t.stats ? ` (num_rows=${t.stats.NUM_ROWS ?? '?'}, blocks=${t.stats.BLOCKS ?? '?'}, 통계수집=${t.stats.LAST_ANALYZED ?? '없음'})` : '';
      lines.push(`\n### ${t.owner}.${t.table}${st}`);
      if (t.columns.length) {
        lines.push('컬럼: ' + t.columns.map((c) => {
          let type = c.DATA_TYPE;
          if (c.DATA_PRECISION != null) type += `(${c.DATA_PRECISION}${c.DATA_SCALE ? ',' + c.DATA_SCALE : ''})`;
          else if (['VARCHAR2', 'CHAR', 'NVARCHAR2'].includes(c.DATA_TYPE)) type += `(${c.DATA_LENGTH})`;
          return `${c.COLUMN_NAME} ${type}${c.NULLABLE === 'N' ? ' NOT NULL' : ''}`;
        }).join(', '));
      }
      if (t.indexes.length) {
        lines.push('인덱스:');
        for (const i of t.indexes) lines.push(`  - ${i.INDEX_NAME} (${i.COLS})${i.UNIQUENESS === 'UNIQUE' ? ' UNIQUE' : ''}`);
      } else {
        lines.push('인덱스: 없음');
      }
    }
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `당신은 Oracle 11g(11.2.0.4) 성능 튜닝 전문 DBA입니다.
주어진 SQL의 실행계획·테이블 스키마·인덱스·통계를 근거로 실질적인 튜닝 방안을 한국어 마크다운으로 제시하세요.

반드시 다음 순서로 답하세요:
1. **핵심 진단** — 이 SQL이 느리거나 자원을 많이 쓰는 근본 원인(예: Full Scan, 잘못된 조인 순서, 인덱스 부재, 통계 미수집, 카티션 곱 등)을 2~4개 짚습니다.
2. **인덱스 제안** — 필요한 인덱스가 있으면 CREATE INDEX 문을 코드블록으로 제시하고, 각 인덱스가 어떤 조건절/조인을 커버하는지 설명합니다. 이미 있는 인덱스면 새로 만들지 마세요.
3. **쿼리 재작성** — 재작성이 도움되면 개선된 SQL을 코드블록으로 제시합니다(11g 문법: FETCH FIRST 대신 ROWNUM 사용). 힌트가 유용하면 제안합니다.
4. **기타/주의** — 통계 재수집, 바인드 변수, 파티셔닝 등 부가 제안과 주의사항.

규칙:
- 근거 없는 추측은 피하고, 제공된 스키마/계획에 실제로 존재하는 컬럼·인덱스만 언급합니다.
- 운영 DB이므로 DROP/TRUNCATE 등 위험한 DDL은 제안하지 않습니다. CREATE INDEX 정도까지만.
- 간결하되 실행 가능한 구체적 제안 위주로. 일반론 나열 금지.
- SQL/DDL 은 반드시 마크다운 코드블록(\`\`\`sql)으로 감쌉니다.`;

// 튜닝 제안 생성
async function suggest(sqlId) {
  if (!ready()) throw new Error('ANTHROPIC_API_KEY 가 설정되지 않았습니다 (.env 확인).');
  const ctx = await gatherContext(sqlId);
  if (!ctx.sqlText) throw new Error('SQL 텍스트를 찾을 수 없습니다 (커서가 공유풀에서 밀려났을 수 있음).');
  const contextText = buildContextText(ctx);

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: EFFORT },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `다음 Oracle SQL을 튜닝해 주세요.\n\n${contextText}` }]
  });

  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return {
    sqlId,
    model: resp.model,
    effort: EFFORT,
    advice: text || '(응답이 비어 있습니다)',
    tables: ctx.tables.map((t) => `${t.owner}.${t.table}`),
    usage: resp.usage ? { input: resp.usage.input_tokens, output: resp.usage.output_tokens } : null
  };
}

module.exports = { suggest, isConfigured, MODEL, EFFORT };
