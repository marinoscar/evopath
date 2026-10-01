import request from 'supertest';

import { HARNESS_OTHER_USER, HARNESS_USER } from '../../src/ai/testing/ai-runtime-harness';
import { authHeader, createMockTestUser, createMockViewerUser, type TestUser } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from '../ai/ai-http.helper';

// =============================================================================
// GET /api/coach/messages (E7.7, #247): the caller's mixed timeline, paged
// =============================================================================
//
// A stateful in-memory `coach_messages` table behind the Prisma mock (rows of
// two users, every kind), so paging is exercised end to end through the real
// controller and service: newest first, stable keyset on (createdAt, id),
// caller-only, and an invalid cursor (unknown, or another user's id) is 400.
// =============================================================================

const PATH = '/api/coach/messages';

interface Row {
  id: string;
  userId: string;
  role: string;
  kind: string;
  moment: string | null;
  personaId: string | null;
  intensity: number | null;
  title: string;
  body: string;
  audioStatus: string;
  audioStorageObjectId: string | null;
  feedback: string | null;
  openedAt: Date | null;
  data: unknown;
  createdAt: Date;
}

const KINDS = ['nudge', 'chat', 'weekly_review', 'chat', 'celebration', 'photo_prompt'];
const T0 = Date.parse('2026-09-01T08:00:00.000Z');

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function buildTable(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 70; i += 1) {
    const kind = KINDS[i % KINDS.length];
    rows.push({
      id: uuid(1000 + i),
      userId: HARNESS_USER,
      role: kind === 'chat' && i % 2 === 1 ? 'user' : 'coach',
      kind,
      moment: kind === 'nudge' ? 'missed_session' : null,
      personaId: 'coach',
      intensity: 2,
      title: '',
      body: `alice ${i}`,
      audioStatus: i % 7 === 0 ? 'ready' : i % 7 === 1 ? 'pending' : 'none',
      audioStorageObjectId: i % 7 <= 1 ? uuid(9000 + i) : null,
      feedback: null,
      openedAt: null,
      data: i % 7 === 0 ? { voice: 'onyx' } : null,
      // Pairs share a timestamp, so the id tie-break matters.
      createdAt: new Date(T0 + Math.floor(i / 2) * 60_000),
    });
  }
  for (let i = 0; i < 10; i += 1) {
    rows.push({ ...rows[i], id: uuid(5000 + i), userId: HARNESS_OTHER_USER, body: `bob ${i}` });
  }
  return rows;
}

function matches(row: Row, where: any): boolean {
  if (where.userId && row.userId !== where.userId) return false;
  if (where.id && row.id !== where.id) return false;
  if (where.OR) {
    return where.OR.some((clause: any) => {
      const t = row.createdAt.getTime();
      if (clause.createdAt?.lt) return t < clause.createdAt.lt.getTime();
      return t === clause.createdAt.getTime() && row.id < clause.id.lt;
    });
  }
  return true;
}

function sortDesc(a: Row, b: Row): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

describe('GET /api/coach/messages (E7.7)', () => {
  let t: AiHttpTestApp;
  let alice: TestUser;
  let table: Row[];

  beforeAll(async () => {
    t = await createAiHttpTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.reset();
    alice = await createMockTestUser(t.context, { id: HARNESS_USER, roleName: 'contributor' });
    table = buildTable();
    const prisma = t.context.prismaMock as any;
    prisma.coachMessage.findFirst.mockImplementation(async ({ where }: any) => {
      const row = table.find((r) => matches(r, where));
      return row ? { id: row.id, createdAt: row.createdAt } : null;
    });
    prisma.coachMessage.findMany.mockImplementation(async ({ where, take }: any) =>
      table.filter((r) => matches(r, where)).sort(sortDesc).slice(0, take),
    );
  });

  const server = () => t.context.app.getHttpServer();
  const get = (query = '', user: TestUser = alice) => request(server()).get(`${PATH}${query}`).set(authHeader(user.accessToken));

  it('pages the whole timeline newest first, stable, caller-only, mixed kinds', async () => {
    const seen: any[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const res: request.Response = await get(`?limit=30${cursor ? `&before=${cursor}` : ''}`).expect(200);
      seen.push(...res.body.data.items);
      cursor = res.body.data.nextCursor;
      pages += 1;
      if (cursor) expect(cursor).toBe(res.body.data.items[res.body.data.items.length - 1].id);
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    const expected = table.filter((r) => r.userId === HARNESS_USER).sort(sortDesc);
    expect(seen.map((i) => i.id)).toEqual(expected.map((r) => r.id));
    expect(new Set(seen.map((i) => i.id)).size).toBe(70);
    expect(seen.some((i) => i.body.startsWith('bob'))).toBe(false);
    expect(new Set(seen.map((i) => i.kind))).toEqual(new Set(['nudge', 'chat', 'weekly_review', 'celebration', 'photo_prompt']));

    const prisma = t.context.prismaMock as any;
    for (const [args] of prisma.coachMessage.findMany.mock.calls) {
      expect(args.where.userId).toBe(HARNESS_USER);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    }
  });

  it('defaults to 30 and caps limit at 50', async () => {
    expect((await get().expect(200)).body.data.items).toHaveLength(30);
    expect((await get('?limit=50').expect(200)).body.data.items).toHaveLength(50);
    await get('?limit=51').expect(400);
    await get('?limit=0').expect(400);
  });

  it("another user's message id, or an unknown one, as a cursor is 400", async () => {
    await get(`?before=${uuid(5000)}`).expect(400);
    await get(`?before=${uuid(424242)}`).expect(400);
    await get('?before=not-a-uuid').expect(400);
  });

  it('shows the item shape, with audio fields only while the audio is ready', async () => {
    const items = (await get('?limit=50').expect(200)).body.data.items as any[];
    const ready = items.find((i) => i.audioStatus === 'ready');
    const pending = items.find((i) => i.audioStatus === 'pending');

    expect(Object.keys(ready).sort()).toEqual(
      [
        'id',
        'role',
        'kind',
        'moment',
        'personaId',
        'intensity',
        'title',
        'body',
        'audioStatus',
        'audioStorageObjectId',
        'voice',
        'feedback',
        'openedAt',
        'data',
        'createdAt',
      ].sort(),
    );
    expect(ready.audioStorageObjectId).toMatch(/^00000000-/);
    expect(ready.voice).toBe('onyx');
    expect(pending.audioStorageObjectId).toBeNull();
    expect(pending.voice).toBeNull();
  });

  it('is refused with AI off, without a token and without ai:use', async () => {
    await request(server()).get(PATH).expect(401);
    const viewer = await createMockViewerUser(t.context);
    await get('', viewer).expect(403);
    t.harness.setPolicy({ enabled: false });
    const res = await get().expect(403);
    expect(res.body.details.reason).toBe('AI_DISABLED');
  });
});
