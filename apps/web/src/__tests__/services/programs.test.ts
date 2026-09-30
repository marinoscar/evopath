/** `services/programs.ts` (E5.1): each route's method, path, body, query and If-Match. */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  activateProgram,
  archiveProgram,
  createProgram,
  deleteProgram,
  duplicateProgram,
  formatTargetLoad,
  getProgram,
  getProgramVersion,
  getTrainingSignals,
  getTrainingToday,
  listProgramChangeLog,
  listPrograms,
  listProgramVersions,
  markProgramChangesSeen,
  pauseProgram,
  programRefusalOf,
  replaceProgramStructure,
  revertProgram,
  signalsRefusalOf,
  startProgramWorkout,
  todayRefusalOf,
  updateProgram,
} from '../../services/programs';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface Seen {
  url?: string;
  method?: string;
  body?: unknown;
  ifMatch?: string | null;
}

function capture(method: Method, path: string, data: unknown = {}, status = 200, details?: unknown): Seen {
  const seen: Seen = {};
  server.use(
    http[method](`*/api${path}`, async ({ request }) => {
      seen.url = request.url;
      seen.method = request.method;
      seen.ifMatch = request.headers.get('If-Match');
      const text = await request.clone().text();
      seen.body = text ? JSON.parse(text) : undefined;
      if (status >= 400) {
        return HttpResponse.json({ statusCode: status, code: 'CONFLICT', message: 'No', details }, { status });
      }
      if (method === 'delete') return new HttpResponse(null, { status: 204 });
      return HttpResponse.json({ data }, { status });
    }),
  );
  return seen;
}

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('programs service', () => {
  it('lists with an optional status filter', async () => {
    const seen = capture('get', '/programs', []);
    await listPrograms({ status: 'active' });
    expect(new URL(seen.url!).search).toBe('?status=active');
  });

  it('creates, reads, edits the header and runs the lifecycle routes', async () => {
    const created = capture('post', '/programs', { id: P });
    await createProgram({ name: 'Plan', goal: 'strength' });
    expect(created.body).toEqual({ name: 'Plan', goal: 'strength' });

    const read = capture('get', `/programs/${P}`, { id: P });
    await expect(getProgram(P)).resolves.toEqual({ id: P });
    expect(read.method).toBe('GET');

    const patched = capture('patch', `/programs/${P}`);
    await updateProgram(P, { autonomy: 'ask_first' });
    expect(patched.body).toEqual({ autonomy: 'ask_first' });

    const activated = capture('post', `/programs/${P}/activate`);
    await activateProgram(P, '2026-10-01');
    expect(activated.body).toEqual({ startDate: '2026-10-01' });

    for (const [call, suffix] of [
      [pauseProgram, 'pause'],
      [archiveProgram, 'archive'],
      [duplicateProgram, 'duplicate'],
    ] as const) {
      const seen = capture('post', `/programs/${P}/${suffix}`);
      await call(P);
      expect(seen.method).toBe('POST');
    }

    const deleted = capture('delete', `/programs/${P}`);
    await deleteProgram(P);
    expect(deleted.method).toBe('DELETE');
  });

  it('sends the loaded version as If-Match on content writes', async () => {
    const put = capture('put', `/programs/${P}/structure`);
    const tree = { blocks: [{ position: 0, name: 'B', weeks: [{ weekNumber: 1, workouts: [] }] }] };
    await replaceProgramStructure(P, 4, tree);
    expect(put.ifMatch).toBe('4');
    expect(put.body).toEqual(tree);

    const revert = capture('post', `/programs/${P}/revert`);
    await revertProgram(P, 5, { changeLogId: LOG });
    expect(revert.ifMatch).toBe('5');
    expect(revert.body).toEqual({ changeLogId: LOG });
  });

  it('reads versions and the change log with keyset paging', async () => {
    const versions = capture('get', `/programs/${P}/versions`, []);
    await listProgramVersions(P);
    expect(versions.method).toBe('GET');

    const one = capture('get', `/programs/${P}/versions/3`, {});
    await getProgramVersion(P, 3);
    expect(one.method).toBe('GET');

    const log = capture('get', `/programs/${P}/change-log`, { items: [], nextCursor: null });
    await listProgramChangeLog(P, { status: 'applied', limit: 10, cursor: 'abc' });
    expect(new URL(log.url!).search).toBe('?status=applied&limit=10&cursor=abc');

    const seen = capture('post', `/programs/${P}/change-log/seen`, { updated: 2 });
    await expect(markProgramChangesSeen(P, LOG)).resolves.toEqual({ updated: 2 });
    expect(seen.body).toEqual({ upToId: LOG });
  });

  it('exposes the refusal reason of a stale write', async () => {
    capture('put', `/programs/${P}/structure`, null, 409, { reason: 'TRAINING_STALE_PLAN', currentVersion: 6 });
    const error = await replaceProgramStructure(P, 5, { blocks: [] }).catch((e: unknown) => e);
    expect(programRefusalOf(error)).toBe('TRAINING_STALE_PLAN');
    expect(programRefusalOf(new Error('x'))).toBeNull();
  });

  it('formats a target load in the user unit, or null when open', () => {
    expect(formatTargetLoad(100, 'kg')).toBe('100 kg');
    expect(formatTargetLoad(null, 'kg')).toBeNull();
  });

  it('reads today with the client date', async () => {
    const seen = capture('get', '/training/today', { kind: 'no_program', date: '2026-09-30' });
    const today = await getTrainingToday('2026-09-30');
    expect(seen.method).toBe('GET');
    expect(new URL(seen.url!).search).toBe('?date=2026-09-30');
    expect(today).toEqual({ kind: 'no_program', date: '2026-09-30' });
  });

  it('starts a planned workout with date and gymId', async () => {
    const seen = capture('post', `/program-workouts/${P}/start`, { workoutId: LOG, existing: false, planVersion: 2 }, 201);
    const result = await startProgramWorkout(P, { date: '2026-09-30', gymId: LOG });
    expect(seen.body).toEqual({ date: '2026-09-30', gymId: LOG });
    expect(result).toEqual({ workoutId: LOG, existing: false, planVersion: 2 });
  });

  it('names the in-progress refusal of a start', async () => {
    capture('post', `/program-workouts/${P}/start`, {}, 409, { reason: 'WORKOUT_IN_PROGRESS', workoutId: LOG });
    const error = await startProgramWorkout(P, { date: '2026-09-30' }).catch((e) => e);
    expect(todayRefusalOf(error)).toBe('WORKOUT_IN_PROGRESS');
    expect(todayRefusalOf(new Error('x'))).toBeNull();
  });

  it('reads plan signals with only the given query parameters', async () => {
    const plain = capture('get', '/training/signals', { programId: null });
    const empty = await getTrainingSignals();
    expect(plain.method).toBe('GET');
    expect(new URL(plain.url!).search).toBe('');
    expect(empty).toEqual({ programId: null });

    const full = capture('get', '/training/signals', { programId: P });
    await getTrainingSignals({ programId: P, from: '2026-08-03', to: '2026-09-27', asOf: '2026-09-28' });
    expect(Object.fromEntries(new URL(full.url!).searchParams)).toEqual({
      programId: P,
      from: '2026-08-03',
      to: '2026-09-27',
      asOf: '2026-09-28',
    });
  });

  it('names the signals refusal of a 400', async () => {
    capture('get', '/training/signals', {}, 400, { reason: 'SIGNALS_AS_OF_OUT_OF_RANGE', today: '2026-09-28' });
    const error = await getTrainingSignals({ asOf: '2026-10-05' }).catch((caught) => caught);
    expect(signalsRefusalOf(error)).toBe('SIGNALS_AS_OF_OUT_OF_RANGE');
    expect(signalsRefusalOf(new Error('x'))).toBeNull();
  });
});
