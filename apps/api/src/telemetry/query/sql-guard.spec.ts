import {
  analyzeStatement,
  stripSqlComments,
  TelemetrySqlRejectedError,
  applyRowCap,
  type RowCapStrategy,
  type TelemetryStatementKind,
} from './sql-guard';

function rejection(sql: string): string {
  try {
    analyzeStatement(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(TelemetrySqlRejectedError);
    return (error as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(sql)} to be rejected`);
}

describe('sql-guard', () => {
  describe('analyzeStatement — accepted', () => {
    const cases: [string, TelemetryStatementKind, string][] = [
      ['SELECT 1', 'select', 'SELECT 1'],
      ['select 1', 'select', 'select 1'],
      ['  \n\tSeLeCt 1  ', 'select', 'SeLeCt 1'],
      ['SELECT 1;', 'select', 'SELECT 1'],
      ['SELECT 1 ;  ; \n', 'select', 'SELECT 1'],
      ['(SELECT 1)', 'select', '(SELECT 1)'],
      ['((select 1) UNION ALL (select 2))', 'select', '((select 1) UNION ALL (select 2))'],
      ['WITH x AS (SELECT 1) SELECT * FROM x', 'select', 'WITH x AS (SELECT 1) SELECT * FROM x'],
      ['with recursive x as (select 1) select * from x', 'select', 'with recursive x as (select 1) select * from x'],
      ['SHOW TABLES', 'show', 'SHOW TABLES'],
      ['show create table opentelemetry_logs', 'show', 'show create table opentelemetry_logs'],
      ['DESCRIBE opentelemetry_traces', 'describe', 'DESCRIBE opentelemetry_traces'],
      ['DESC TABLE t', 'describe', 'DESC TABLE t'],
      ['desc t', 'describe', 'desc t'],
      ['EXPLAIN SELECT * FROM t', 'explain', 'EXPLAIN SELECT * FROM t'],
      ['explain verbose select 1', 'explain', 'explain verbose select 1'],
      // Semicolons inside literals and quoted identifiers are not terminators.
      ["SELECT ';' AS semi", 'select', "SELECT ';' AS semi"],
      ["SELECT 'it''s; fine'", 'select', "SELECT 'it''s; fine'"],
      ['SELECT "a;b" FROM t', 'select', 'SELECT "a;b" FROM t'],
      ['SELECT "we""ird;" FROM t', 'select', 'SELECT "we""ird;" FROM t'],
      ['SELECT `a;b` FROM t', 'select', 'SELECT `a;b` FROM t'],
      // Comment markers inside literals are text, not comments.
      ["SELECT '--not a comment; DROP TABLE t'", 'select', "SELECT '--not a comment; DROP TABLE t'"],
      ["SELECT '/* nor this */'", 'select', "SELECT '/* nor this */'"],
      ['SELECT "span_attributes.http.route" FROM opentelemetry_traces', 'select', 'SELECT "span_attributes.http.route" FROM opentelemetry_traces'],
      // Comments are removed.
      ['-- leading\nSELECT 1', 'select', 'SELECT 1'],
      ['/* leading */ SELECT 1', 'select', 'SELECT 1'],
      ['SELECT 1 -- trailing; DROP TABLE t', 'select', 'SELECT 1'],
      ['SELECT 1; -- trailing comment', 'select', 'SELECT 1'],
      ['SELECT/**/1', 'select', 'SELECT 1'],
      ['SELECT 1 /* a ; b */ + 2', 'select', 'SELECT 1   + 2'],
    ];

    it.each(cases)('%j → %s', (sql, kind, normalized) => {
      expect(analyzeStatement(sql)).toEqual({ kind, normalized });
    });
  });

  describe('analyzeStatement — refused', () => {
    it.each([
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'DELETE FROM t',
      'DROP TABLE t',
      'ALTER DATABASE public SET ttl = \'1d\'',
      'CREATE TABLE x (a INT)',
      'SET statement_timeout = 0',
      "COPY t TO '/tmp/x'",
      'ADMIN flush_table(\'t\')',
      'KILL 1',
      'TRUNCATE t',
      'drop table t',
    ])('%j as not read-only', (sql) => {
      const keyword = sql.split(/\s/)[0].toUpperCase();
      const message = rejection(sql);

      expect(message).toContain(`${keyword} statements are not allowed`);
      expect(message).toContain('SELECT, WITH, SHOW, DESCRIBE and EXPLAIN');
    });

    it.each([
      'SELECT 1; SELECT 2',
      'SELECT 1; DROP TABLE t',
      'SELECT 1;DROP TABLE t;',
      "SELECT 'a'; DELETE FROM t",
      // A comment does not hide a second statement: it is removed first.
      'SELECT 1 /* x */; DROP TABLE t',
      'SELECT 1 --x\n; DROP TABLE t',
      '/* ; */ SELECT 1; SELECT 2',
    ])('%j as more than one statement', (sql) => {
      expect(rejection(sql)).toBe('Only one SQL statement may be run at a time.');
    });

    it.each(['', '   ', ';', ' ; ; ', '-- only a comment', '/* only */', '--x\n;'])('%j as empty', (sql) => {
      expect(rejection(sql)).toBe('The query is empty.');
    });

    it.each([
      ["SELECT 'unterminated", 'unterminated string literal'],
      ['SELECT "unterminated', 'unterminated quoted identifier'],
      ['SELECT 1 /* unterminated', 'unterminated /* comment'],
      // A quote swallowing the rest must not let a `;` slip through unseen.
      ["SELECT 'x''; DROP TABLE t", 'unterminated string literal'],
    ])('%j as malformed (%s)', (sql, fragment) => {
      expect(rejection(sql)).toContain(fragment);
    });

    it('a statement that starts with no keyword', () => {
      expect(rejection('123')).toBe('The query must start with SELECT, WITH, SHOW, DESCRIBE and EXPLAIN.');
      expect(rejection('"t"')).toMatch(/must start with/);
    });

    it.each(['EXPLAIN ANALYZE SELECT 1', 'explain analyze select 1', 'EXPLAIN VERBOSE ANALYZE SELECT 1', 'EXPLAIN (ANALYZE) SELECT 1'])(
      '%j (it runs the query)',
      (sql) => {
        expect(rejection(sql)).toContain('EXPLAIN ANALYZE is not allowed');
      },
    );

    it('a keyword hidden behind a comment', () => {
      expect(rejection('/* SELECT */ DROP TABLE t')).toContain('DROP statements are not allowed');
      expect(rejection('-- SELECT\nDELETE FROM t')).toContain('DELETE statements are not allowed');
    });
  });

  describe('stripSqlComments', () => {
    it('keeps literals and identifiers verbatim', () => {
      expect(stripSqlComments(`SELECT '--', "/*", 'a''b' -- c\n`)).toBe(`SELECT '--', "/*", 'a''b'  \n`);
    });

    it('treats an unterminated line comment as running to the end', () => {
      expect(stripSqlComments('SELECT 1 -- x')).toBe('SELECT 1  ');
    });
  });

  describe('applyRowCap', () => {
    const cap = (sql: string, n = 101) => applyRowCap(analyzeStatement(sql), n);

    it.each<[string, string, string, RowCapStrategy]>([
      ['no LIMIT: appended', 'SELECT * FROM t', 'SELECT * FROM t LIMIT 101', 'appended'],
      [
        'appended after ORDER BY, so the order survives (#554)',
        'SELECT ts FROM t ORDER BY ts DESC',
        'SELECT ts FROM t ORDER BY ts DESC LIMIT 101',
        'appended',
      ],
      ['trailing semicolons trimmed first', 'SELECT 1 ;; ', 'SELECT 1 LIMIT 101', 'appended'],
      ['comments removed first', 'SELECT 1 -- limit 5', 'SELECT 1 LIMIT 101', 'appended'],
      [
        'appended after a top-level UNION ALL … ORDER BY',
        'SELECT a FROM t UNION ALL SELECT a FROM u ORDER BY a DESC',
        'SELECT a FROM t UNION ALL SELECT a FROM u ORDER BY a DESC LIMIT 101',
        'appended',
      ],
      [
        'a LIMIT inside a subquery is not the statement\'s',
        'SELECT * FROM (SELECT a FROM t ORDER BY a LIMIT 5000) s ORDER BY a',
        'SELECT * FROM (SELECT a FROM t ORDER BY a LIMIT 5000) s ORDER BY a LIMIT 101',
        'appended',
      ],
      [
        'a LIMIT inside a CTE is not the statement\'s',
        'WITH x AS (SELECT a FROM t LIMIT 3) SELECT * FROM x',
        'WITH x AS (SELECT a FROM t LIMIT 3) SELECT * FROM x LIMIT 101',
        'appended',
      ],
      [
        "'limit' in a string literal is ignored",
        "SELECT * FROM t WHERE msg = 'no limit 5'",
        "SELECT * FROM t WHERE msg = 'no limit 5' LIMIT 101",
        'appended',
      ],
      [
        'a quoted identifier named limit is ignored',
        'SELECT "limit", `LIMIT` FROM t',
        'SELECT "limit", `LIMIT` FROM t LIMIT 101',
        'appended',
      ],
      ['a qualified column named limit is ignored', 'SELECT t.limit FROM t', 'SELECT t.limit FROM t LIMIT 101', 'appended'],
      [
        'a top-level OFFSET alone: LIMIT inserted before it',
        'SELECT a FROM t ORDER BY a OFFSET 5',
        'SELECT a FROM t ORDER BY a LIMIT 101 OFFSET 5',
        'appended',
      ],
      ['LIMIT below the cap: kept', 'SELECT a FROM t ORDER BY a LIMIT 50', 'SELECT a FROM t ORDER BY a LIMIT 50', 'kept'],
      ['LIMIT one below the cap: kept', 'SELECT a FROM t LIMIT 100', 'SELECT a FROM t LIMIT 100', 'kept'],
      ['lower-case limit: kept', 'select a from t limit 20;', 'select a from t limit 20', 'kept'],
      ['LIMIT n OFFSET m below the cap: kept', 'SELECT a FROM t LIMIT 20 OFFSET 5', 'SELECT a FROM t LIMIT 20 OFFSET 5', 'kept'],
      ['OFFSET m LIMIT n below the cap: kept', 'SELECT a FROM t OFFSET 5 LIMIT 20', 'SELECT a FROM t OFFSET 5 LIMIT 20', 'kept'],
      ['LIMIT at the cap: clamped', 'SELECT a FROM t LIMIT 101', 'SELECT a FROM t LIMIT 101', 'clamped'],
      ['LIMIT above the cap: clamped', 'SELECT a FROM t ORDER BY a LIMIT 999999', 'SELECT a FROM t ORDER BY a LIMIT 101', 'clamped'],
      [
        'a huge LIMIT: clamped',
        'SELECT a FROM t LIMIT 99999999999999999999999',
        'SELECT a FROM t LIMIT 101',
        'clamped',
      ],
      [
        'LIMIT n OFFSET m above the cap: clamped, OFFSET kept',
        'SELECT a FROM t LIMIT 5000 OFFSET 7 ROWS',
        'SELECT a FROM t LIMIT 101 OFFSET 7 ROWS',
        'clamped',
      ],
      [
        'OFFSET m LIMIT n above the cap: clamped, OFFSET kept',
        'SELECT a FROM t OFFSET 7 LIMIT 5000',
        'SELECT a FROM t OFFSET 7 LIMIT 101',
        'clamped',
      ],
      [
        'the top-level LIMIT is clamped, the subquery one left alone',
        'SELECT * FROM (SELECT a FROM t LIMIT 9000) s LIMIT 9000',
        'SELECT * FROM (SELECT a FROM t LIMIT 9000) s LIMIT 101',
        'clamped',
      ],
      ['LIMIT ALL: client-only', 'SELECT a FROM t LIMIT ALL', 'SELECT a FROM t LIMIT ALL', 'client-only'],
      ['LIMIT <parameter>: client-only', 'SELECT a FROM t LIMIT $1', 'SELECT a FROM t LIMIT $1', 'client-only'],
      ['LIMIT <expression>: client-only', 'SELECT a FROM t LIMIT 10 + 5', 'SELECT a FROM t LIMIT 10 + 5', 'client-only'],
      [
        'LIMIT (<subquery>): client-only',
        'SELECT a FROM t LIMIT (SELECT 3)',
        'SELECT a FROM t LIMIT (SELECT 3)',
        'client-only',
      ],
      [
        'FETCH FIRST: client-only',
        'SELECT a FROM t FETCH FIRST 5 ROWS ONLY',
        'SELECT a FROM t FETCH FIRST 5 ROWS ONLY',
        'client-only',
      ],
      ['SHOW: client-only', 'SHOW TABLES', 'SHOW TABLES', 'client-only'],
      ['DESCRIBE: client-only', 'DESCRIBE t', 'DESCRIBE t', 'client-only'],
      ['EXPLAIN: client-only, never given a LIMIT', 'EXPLAIN SELECT 1', 'EXPLAIN SELECT 1', 'client-only'],
    ])('%s', (_name, sql, expected, strategy) => {
      expect(cap(sql)).toEqual({ sql: expected, strategy });
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses a cap of %p', (n) => {
      expect(() => cap('SELECT 1', n)).toThrow(RangeError);
    });
  });
});
