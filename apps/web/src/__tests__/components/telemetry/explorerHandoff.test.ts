/**
 * The dashboard → explorer SQL handoff (issue #579, epic #576).
 */
import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_EXPLORER_PATH,
  acceptableHandoffSql,
  explorerHandoff,
  explorerSqlUrl,
  readExplorerHandoff,
} from '../../../components/telemetry/explorerHandoff';
import { TELEMETRY_SQL_MAX_LENGTH } from '../../../services/telemetry';

const params = (search = '') => new URLSearchParams(search);

describe('explorerHandoff', () => {
  it('builds the navigation to the explorer with the SQL in state', () => {
    expect(explorerHandoff('SELECT 1')).toEqual({ to: TELEMETRY_EXPLORER_PATH, state: { sql: 'SELECT 1' } });
  });

  it('round-trips a statement through ?sql=', () => {
    const sql = "SELECT * FROM t WHERE a = 'x&y' AND b LIKE '%?%'";
    const url = new URL(explorerSqlUrl(sql), 'http://localhost');
    expect(url.pathname).toBe(TELEMETRY_EXPLORER_PATH);
    expect(readExplorerHandoff(null, url.searchParams)).toBe(sql);
  });

  it('prefers state over ?sql=', () => {
    expect(readExplorerHandoff({ sql: 'SELECT 1' }, params('sql=SELECT%202'))).toBe('SELECT 1');
  });

  it('falls back to ?sql= when the state is unusable', () => {
    expect(readExplorerHandoff({ sql: 42 }, params('sql=SELECT%202'))).toBe('SELECT 2');
    expect(readExplorerHandoff('SELECT 1', params('sql=SELECT%202'))).toBe('SELECT 2');
  });

  it('answers null when nothing was handed over', () => {
    expect(readExplorerHandoff(null, params())).toBeNull();
    expect(readExplorerHandoff(undefined, params('other=1'))).toBeNull();
  });

  it('accepts exactly up to the API limit and ignores anything longer or blank', () => {
    expect(acceptableHandoffSql('x'.repeat(TELEMETRY_SQL_MAX_LENGTH))).toHaveLength(TELEMETRY_SQL_MAX_LENGTH);
    expect(acceptableHandoffSql('x'.repeat(TELEMETRY_SQL_MAX_LENGTH + 1))).toBeNull();
    expect(acceptableHandoffSql('   ')).toBeNull();
    expect(acceptableHandoffSql(null)).toBeNull();
  });
});
