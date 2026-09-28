// =============================================================================
// SQL guard for ad-hoc telemetry queries (issue #535, epic #528)
// =============================================================================
//
// DEFENCE IN DEPTH, NOT THE CONTROL. Every explorer/assistant/export query runs
// as GreptimeDB's `readonly` user, which the server itself refuses INSERT,
// DROP, ALTER, SET and friends (spike #529). This guard exists for two
// reasons that user cannot cover:
//
//   1. ONE STATEMENT. The simple query protocol executes EVERY statement in a
//      multi-statement string (spike #529). `GreptimeClient` refuses the
//      result after the fact; this refuses the text before it is sent, so a
//      second statement never runs at all.
//   2. GOOD ERRORS. "Only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN are
//      allowed" is a better answer to `DELETE FROM …` than the server's
//      "User is not authorized to perform this action".
//
// It is a small lexer, not a parser: it knows where single-quoted strings
// ('' escapes), double-quoted identifiers ("" escapes — telemetry columns are
// named like "span_attributes.http.route"), backtick identifiers, `--` line
// comments and `/* */` block comments begin and end, and nothing else. That
// is exactly enough to find a `;` or a comment that is really one, to find
// the first keyword, and to find a top-level LIMIT (`applyRowCap`).
// GreptimeDB has no dollar quoting, so none is handled.
//
// Pure functions; no Nest, no I/O.
// =============================================================================

export type TelemetryStatementKind = 'select' | 'show' | 'describe' | 'explain';

export interface AnalyzedStatement {
  kind: TelemetryStatementKind;
  /** The statement with comments removed and trailing `;`/whitespace trimmed. */
  normalized: string;
}

/** Why a statement was refused. The message is shown to the user as-is. */
export class TelemetrySqlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetrySqlRejectedError';
  }
}

const ALLOWED: Record<string, TelemetryStatementKind> = {
  SELECT: 'select',
  WITH: 'select',
  SHOW: 'show',
  DESCRIBE: 'describe',
  DESC: 'describe',
  EXPLAIN: 'explain',
};

const ALLOWED_TEXT = 'SELECT, WITH, SHOW, DESCRIBE and EXPLAIN';

/**
 * Removes comments outside quotes, keeping everything else byte-for-byte.
 * A comment is replaced by one space so `SELECT/**\/1` does not become
 * `SELECT1`. Throws on an unterminated string, identifier or block comment:
 * what follows it cannot be classified safely.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'" || ch === '"' || ch === '`') {
      const end = endOfQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '-' && next === '-') {
      const newline = sql.indexOf('\n', i + 2);
      i = newline === -1 ? n : newline; // keep the newline itself
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) {
        throw new TelemetrySqlRejectedError('The query has an unterminated /* comment.');
      }
      i = close + 2;
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Classifies one read-only statement, or throws `TelemetrySqlRejectedError`
 * with a message fit to show the user.
 */
export function analyzeStatement(sql: string): AnalyzedStatement {
  const stripped = stripSqlComments(sql);
  const normalized = trimTrailingTerminators(stripped);

  if (normalized === '') {
    throw new TelemetrySqlRejectedError('The query is empty.');
  }

  if (indexOfUnquoted(normalized, ';') !== -1) {
    throw new TelemetrySqlRejectedError('Only one SQL statement may be run at a time.');
  }

  // `(SELECT 1) UNION (SELECT 2)` — a leading parenthesis opens a query.
  const body = normalized.replace(/^[\s(]+/, '');
  const keyword = /^[A-Za-z_]+/.exec(body)?.[0]?.toUpperCase() ?? '';
  const kind = ALLOWED[keyword];

  if (!kind) {
    throw new TelemetrySqlRejectedError(
      keyword
        ? `${keyword} statements are not allowed. Telemetry queries are read-only: only ${ALLOWED_TEXT} are allowed.`
        : `The query must start with ${ALLOWED_TEXT}.`,
    );
  }

  if (kind === 'explain' && /^EXPLAIN\s+(\(|VERBOSE\s+)?ANALYZE\b/i.test(body)) {
    throw new TelemetrySqlRejectedError(
      'EXPLAIN ANALYZE is not allowed: it runs the whole query. Use EXPLAIN to see the plan.',
    );
  }

  return { kind, normalized };
}

/**
 * How `applyRowCap` bounded a statement:
 *
 *   appended     no top-level LIMIT: ` LIMIT <cap>` was added at the end (or
 *                just before a top-level OFFSET);
 *   clamped      a top-level `LIMIT <n>` with n >= cap: n was replaced by cap;
 *   kept         a top-level `LIMIT <n>` with n < cap: already bounded below
 *                the cap, sent unchanged;
 *   client-only  the statement could not be bounded safely in its text
 *                (`LIMIT ALL`, `LIMIT <expression>`, `FETCH FIRST`, or a
 *                SHOW/DESCRIBE/EXPLAIN): sent unchanged, and the caller's
 *                slice to `maxRows` (plus the query timeout) is the only cap.
 */
export type RowCapStrategy = 'appended' | 'clamped' | 'kept' | 'client-only';

export interface RowCappedStatement {
  sql: string;
  strategy: RowCapStrategy;
}

/**
 * The statement to send, bounded so the SERVER stops after `cap` rows (pass
 * `maxRows + 1`: the extra row is how truncation is detected).
 *
 * WHY NOT A WRAPPER (issue #554). The obvious `SELECT * FROM (<sql>) AS q
 * LIMIT n` — and a CTE wrapper too — does NOT preserve the inner ORDER BY on
 * GreptimeDB v1.2.1 (verified live, deterministically; `UNION ALL … ORDER BY`
 * included). SQL leaves a subquery's order unspecified and the planner takes
 * it at its word. So the LIMIT is applied to the statement itself, at the top
 * level, where it composes with the statement's own ORDER BY (and, after a
 * top-level `UNION … ORDER BY`, with the whole union).
 *
 * "Top level" is found with the same quote-aware scan as the rest of this
 * file (comments are already gone from `normalized`), counting parentheses:
 * a LIMIT inside a subquery, CTE or string literal is not the statement's.
 */
export function applyRowCap(statement: AnalyzedStatement, cap: number): RowCappedStatement {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new RangeError(`cap must be a positive integer, got ${cap}`);
  }

  const sql = statement.normalized;

  // SHOW, DESCRIBE and EXPLAIN take no LIMIT; their output is small.
  if (statement.kind !== 'select') {
    return { sql, strategy: 'client-only' };
  }

  const words = topLevelWords(sql);
  const find = (word: string) => words.filter((w) => w.upper === word).at(-1);

  // `FETCH FIRST n ROWS ONLY` is the standard spelling of LIMIT; rewriting
  // it is not worth the risk for how rarely it is written.
  if (find('FETCH')) {
    return { sql, strategy: 'client-only' };
  }

  const limit = find('LIMIT');

  if (!limit) {
    const offset = find('OFFSET');
    if (offset) {
      // `… OFFSET m` → `… LIMIT cap OFFSET m`, the form every dialect accepts.
      return {
        sql: `${sql.slice(0, offset.start)}LIMIT ${cap} ${sql.slice(offset.start)}`,
        strategy: 'appended',
      };
    }
    // After ORDER BY, and after a whole `UNION … ORDER BY`, this limits the
    // statement's final, ordered result.
    return { sql: `${sql} LIMIT ${cap}`, strategy: 'appended' };
  }

  // `LIMIT <integer>`, then nothing but an optional `OFFSET <integer> [ROW[S]]`
  // (the `OFFSET m LIMIT n` order leaves nothing after the literal at all).
  const rest = sql.slice(limit.end);
  const literal = /^(\s+)(\d+)(?=(\s+OFFSET\s+\d+(\s+ROWS?)?)?\s*$)/i.exec(rest);

  if (!literal) {
    return { sql, strategy: 'client-only' };
  }

  if (BigInt(literal[2]) < BigInt(cap)) {
    return { sql, strategy: 'kept' };
  }

  const at = limit.end + literal[1].length;

  return {
    sql: `${sql.slice(0, at)}${cap}${sql.slice(at + literal[2].length)}`,
    strategy: 'clamped',
  };
}

// -----------------------------------------------------------------------------

/** Index just past the quoted run starting at `start` (a `'`, `"` or backtick). */
function endOfQuoted(sql: string, start: number): number {
  const quote = sql[start];
  let i = start + 1;

  while (i < sql.length) {
    if (sql[i] === quote) {
      // A doubled quote is an escaped one and does not close the run.
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }

  throw new TelemetrySqlRejectedError(
    quote === "'"
      ? 'The query has an unterminated string literal.'
      : 'The query has an unterminated quoted identifier.',
  );
}

function indexOfUnquoted(sql: string, target: string): number {
  let found = -1;

  scanUnquoted(sql, (ch, i) => {
    if (ch !== target) return undefined;
    found = i;
    return 'stop';
  });

  return found;
}

interface TopLevelWord {
  upper: string;
  start: number;
  end: number;
}

/**
 * The bare words (keywords and unquoted identifiers) outside every quote and
 * parenthesis, in order. A word after `.` (`t.limit`) is a qualified name,
 * not a keyword; a numeric literal such as `1e5` contributes no word.
 */
function topLevelWords(sql: string): TopLevelWord[] {
  const words: TopLevelWord[] = [];
  let depth = 0;

  scanUnquoted(sql, (ch, i) => {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (/[A-Za-z0-9_]/.test(ch) && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      const end = i + /^[A-Za-z0-9_$]*/.exec(sql.slice(i))![0].length;
      if (depth === 0 && /[A-Za-z_]/.test(ch) && sql[i - 1] !== '.') {
        words.push({ upper: sql.slice(i, end).toUpperCase(), start: i, end });
      }
      return end;
    }
    return undefined;
  });

  return words;
}

/**
 * Walks `sql` calling `visit` for every character outside a quoted run (the
 * runs themselves are skipped whole). `visit` returns `'stop'` to end the
 * walk, an index to resume from, or nothing to move on by one.
 */
function scanUnquoted(sql: string, visit: (ch: string, i: number) => 'stop' | number | undefined): void {
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'" || ch === '"' || ch === '`') {
      i = endOfQuoted(sql, i);
      continue;
    }

    const next = visit(ch, i);
    if (next === 'stop') return;
    i = typeof next === 'number' ? next : i + 1;
  }
}

/** Trims whitespace and any number of trailing `;` (with whitespace between). */
function trimTrailingTerminators(sql: string): string {
  return sql.replace(/[\s;]+$/, '').trim();
}
