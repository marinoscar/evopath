import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';

import { UserCredentialsService } from './user-credentials.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// =============================================================================
// UserCredentialsService — tests (issue #387)
// =============================================================================
//
// The same approach as `credentials.service.spec.ts`: Prisma is mocked, but
// backed by an in-memory Map keyed by `(userId, purpose, name)` so "write then
// read" means something, and the REAL cipher is used, so owner isolation and
// no-plaintext-egress are assertions about actual ciphertext.
// =============================================================================

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

afterAll(() => {
  if (ORIGINAL_KEY_ENV === undefined) {
    delete process.env.SECRETS_ENCRYPTION_KEY;
  } else {
    process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
  }
});

const ALICE = '0b6f1d7e-3c2a-4f5b-9e8d-7a6c5b4d3e2f';
const BOB = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

interface FakeRow {
  id: string;
  userId: string;
  purpose: string;
  name: string;
  secret: string;
  hint: string | null;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const rowKey = (userId: string, purpose: string, name: string) =>
  `${userId}::${purpose}::${name}`;

function project(row: FakeRow, select: Record<string, boolean> | undefined) {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(select)) {
    if (select[field]) out[field] = (row as unknown as Record<string, unknown>)[field];
  }
  return out;
}

function applyUpdate(row: FakeRow, data: Record<string, unknown>): FakeRow {
  const next: FakeRow = { ...row, updatedAt: new Date(row.updatedAt.getTime() + 1) };
  if ('secret' in data) next.secret = data.secret as string;
  if ('hint' in data) next.hint = data.hint as string | null;
  if ('label' in data) next.label = data.label as string | null;
  return next;
}

describe('UserCredentialsService', () => {
  let service: UserCredentialsService;
  let mockPrisma: MockPrismaService;
  let store: Map<string, FakeRow>;
  let nextId: number;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    store = new Map();
    nextId = 1;

    const model = mockPrisma.userCredential as unknown as Record<string, jest.Mock>;

    model.findUnique.mockImplementation(async (args: any) => {
      const { userId, purpose, name } = args.where.userId_purpose_name;
      const row = store.get(rowKey(userId, purpose, name));
      return row ? project(row, args.select) : null;
    });

    model.findMany.mockImplementation(async (args: any) => {
      const { userId, purpose } = args.where;
      return Array.from(store.values())
        .filter((r) => r.userId === userId && (purpose === undefined || r.purpose === purpose))
        .sort((a, b) => a.purpose.localeCompare(b.purpose) || a.name.localeCompare(b.name))
        .map((r) => project(r, args.select));
    });

    model.upsert.mockImplementation(async (args: any) => {
      const { userId, purpose, name } = args.where.userId_purpose_name;
      const k = rowKey(userId, purpose, name);
      const existing = store.get(k);
      if (existing) {
        const updated = applyUpdate(existing, args.update);
        store.set(k, updated);
        return { ...updated };
      }
      const now = new Date();
      const created: FakeRow = {
        id: `ucred-${nextId++}`,
        userId: args.create.user.connect.id,
        purpose,
        name,
        secret: args.create.secret,
        hint: args.create.hint ?? null,
        label: args.create.label ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.set(k, created);
      return { ...created };
    });

    model.update.mockImplementation(async (args: any) => {
      const existing = Array.from(store.values()).find((r) => r.id === args.where.id);
      if (!existing) throw new Error('Simulated Prisma P2025: record not found');
      const updated = applyUpdate(existing, args.data);
      store.set(rowKey(updated.userId, updated.purpose, updated.name), updated);
      return { ...updated };
    });

    model.deleteMany.mockImplementation(async (args: any) => {
      const { userId, purpose, name } = args.where;
      const k = rowKey(userId, purpose, name);
      if (store.has(k)) {
        store.delete(k);
        return { count: 1 };
      }
      return { count: 0 };
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [UserCredentialsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    service = module.get(UserCredentialsService);
  });

  const stored = (userId: string, purpose: string, name: string) =>
    store.get(rowKey(userId, purpose, name));

  // ==========================================================================
  describe('round trip and owner scoping', () => {
    it('stores ciphertext and reads back plaintext', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'alice-signing-secret');

      expect(stored(ALICE, 'webhook', 'default')?.secret).not.toContain('alice-signing-secret');
      await expect(service.getSecret(ALICE, 'webhook', 'default')).resolves.toBe(
        'alice-signing-secret',
      );
    });

    it('returns null when this user has nothing stored', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'alice-signing-secret');
      await expect(service.getSecret(BOB, 'webhook', 'default')).resolves.toBeNull();
    });

    it('keeps two users at the same (purpose, name) apart', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'alice-signing-secret');
      await service.setSecret(BOB, 'webhook', 'default', 'bob-signing-secret');

      await expect(service.getSecret(ALICE, 'webhook', 'default')).resolves.toBe(
        'alice-signing-secret',
      );
      await expect(service.getSecret(BOB, 'webhook', 'default')).resolves.toBe(
        'bob-signing-secret',
      );
    });

    it("fails authentication when A's ciphertext is copied into B's row", async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'alice-signing-secret');
      await service.setSecret(BOB, 'webhook', 'default', 'bob-signing-secret');

      // Simulate a SQL write / buggy row copy: B's row now holds A's payload.
      const bobRow = stored(BOB, 'webhook', 'default')!;
      bobRow.secret = stored(ALICE, 'webhook', 'default')!.secret;

      const error = await service.getSecret(BOB, 'webhook', 'default').catch((e) => e);
      expect(error).toBeInstanceOf(InternalServerErrorException);
      // Never the other user's plaintext, and never any plaintext at all.
      expect(error.message).not.toContain('alice-signing-secret');
      expect(error.message).not.toContain(ALICE);
    });

    it('fails authentication when a row is moved to another purpose of the same user', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'alice-signing-secret');
      await service.setSecret(ALICE, 'other', 'default', 'placeholder-secret');
      stored(ALICE, 'other', 'default')!.secret = stored(ALICE, 'webhook', 'default')!.secret;

      await expect(service.getSecret(ALICE, 'other', 'default')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // ==========================================================================
  describe('no plaintext egress', () => {
    it('describe returns metadata and a hint, never the secret or ciphertext', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'whsec_abcdefgh1234', {
        label: 'My webhook',
      });

      const info = await service.describe(ALICE, 'webhook', 'default');
      expect(info).toEqual({
        purpose: 'webhook',
        name: 'default',
        hint: '••••1234',
        label: 'My webhook',
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });

      const serialised = JSON.stringify(info);
      expect(serialised).not.toContain('whsec_abcdefgh1234');
      expect(serialised).not.toContain(stored(ALICE, 'webhook', 'default')!.secret);
    });

    it('describe does not even select the ciphertext', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'whsec_abcdefgh1234');
      await service.describe(ALICE, 'webhook', 'default');

      const calls = (mockPrisma.userCredential.findUnique as unknown as jest.Mock).mock.calls;
      const lastSelect = calls[calls.length - 1][0].select;
      expect(lastSelect).not.toHaveProperty('secret');
    });

    it('list returns only this user\'s rows, with no secret material', async () => {
      await service.setSecret(ALICE, 'webhook', 'b', 'alice-secret-b-1234');
      await service.setSecret(ALICE, 'webhook', 'a', 'alice-secret-a-5678');
      await service.setSecret(ALICE, 'other', 'default', 'alice-other-secret');
      await service.setSecret(BOB, 'webhook', 'default', 'bob-secret-9999');

      const all = await service.list(ALICE);
      expect(all.map((i) => `${i.purpose}/${i.name}`)).toEqual([
        'other/default',
        'webhook/a',
        'webhook/b',
      ]);

      const scoped = await service.list(ALICE, 'webhook');
      expect(scoped.map((i) => i.name)).toEqual(['a', 'b']);

      const serialised = JSON.stringify(all);
      for (const plaintext of ['alice-secret-b-1234', 'alice-secret-a-5678', 'bob-secret-9999']) {
        expect(serialised).not.toContain(plaintext);
      }
      for (const info of all) {
        expect(Object.keys(info).sort()).toEqual(
          ['createdAt', 'hint', 'label', 'name', 'purpose', 'updatedAt'].sort(),
        );
      }
    });

    it('describe returns null for an absent credential', async () => {
      await expect(service.describe(ALICE, 'webhook', 'default')).resolves.toBeNull();
    });
  });

  // ==========================================================================
  describe('blank preserves', () => {
    it.each([undefined, null, ''])(
      'a %p secret keeps the stored ciphertext and hint',
      async (blank) => {
        await service.setSecret(ALICE, 'webhook', 'default', 'original-secret-1234');
        const before = { ...stored(ALICE, 'webhook', 'default')! };

        await service.setSecret(ALICE, 'webhook', 'default', blank, { label: 'Renamed' });

        const after = stored(ALICE, 'webhook', 'default')!;
        expect(after.secret).toBe(before.secret);
        expect(after.hint).toBe(before.hint);
        expect(after.label).toBe('Renamed');
        await expect(service.getSecret(ALICE, 'webhook', 'default')).resolves.toBe(
          'original-secret-1234',
        );
      },
    );

    it('a blank secret with no metadata writes nothing', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'original-secret-1234');
      const before = { ...stored(ALICE, 'webhook', 'default')! };

      await service.setSecret(ALICE, 'webhook', 'default', '');

      expect(stored(ALICE, 'webhook', 'default')).toEqual(before);
      expect(mockPrisma.userCredential.update).not.toHaveBeenCalled();
    });

    it('a blank secret with nothing stored is a 400, and creates nothing', async () => {
      await expect(service.setSecret(ALICE, 'webhook', 'default', '')).rejects.toThrow(
        BadRequestException,
      );
      expect(store.size).toBe(0);
    });

    it("a blank secret for B does not piggy-back on A's stored row", async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'alice-secret-1234');
      await expect(service.setSecret(BOB, 'webhook', 'default', null)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('a whitespace-only secret is a real value (no trim)', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', '   ');
      await expect(service.getSecret(ALICE, 'webhook', 'default')).resolves.toBe('   ');
    });

    it('label: null clears it, omitted leaves it', async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'secret-12345678', { label: 'L' });
      await service.setSecret(ALICE, 'webhook', 'default', undefined, {});
      expect(stored(ALICE, 'webhook', 'default')!.label).toBe('L');
      await service.setSecret(ALICE, 'webhook', 'default', undefined, { label: null });
      expect(stored(ALICE, 'webhook', 'default')!.label).toBeNull();
    });
  });

  // ==========================================================================
  describe('deleteSecret', () => {
    it("removes only this user's row and is idempotent", async () => {
      await service.setSecret(ALICE, 'webhook', 'default', 'alice-secret-1234');
      await service.setSecret(BOB, 'webhook', 'default', 'bob-secret-1234');

      await service.deleteSecret(ALICE, 'webhook', 'default');
      await service.deleteSecret(ALICE, 'webhook', 'default');

      await expect(service.getSecret(ALICE, 'webhook', 'default')).resolves.toBeNull();
      await expect(service.getSecret(BOB, 'webhook', 'default')).resolves.toBe(
        'bob-secret-1234',
      );
    });
  });

  // ==========================================================================
  describe('address validation', () => {
    it.each([
      ['uppercase', ALICE.toUpperCase()],
      ['braced', `{${ALICE}}`],
      ['non-uuid', 'alice'],
    ])('rejects a %s owner id on every method', async (_label, userId) => {
      await expect(service.getSecret(userId, 'webhook', 'default')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.describe(userId, 'webhook', 'default')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.list(userId)).rejects.toThrow(BadRequestException);
      await expect(service.setSecret(userId, 'webhook', 'default', 'x-secret')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.deleteSecret(userId, 'webhook', 'default')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.userCredential.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a purpose containing ":"', async () => {
      await expect(service.getSecret(ALICE, 'web:hook', 'default')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.list(ALICE, 'web:hook')).rejects.toThrow(BadRequestException);
      await expect(
        service.setSecret(ALICE, 'web:hook', 'default', 'x-secret'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects whitespace-padded purposes and names', async () => {
      await expect(service.getSecret(ALICE, ' webhook', 'default')).rejects.toThrow(
        /whitespace/,
      );
      await expect(service.getSecret(ALICE, 'webhook', 'default ')).rejects.toThrow(
        /whitespace/,
      );
    });
  });
});
