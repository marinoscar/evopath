import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';

import * as internals from './credential-internals';
import { deriveHint as reExportedDeriveHint } from './credentials.service';
import { CredentialsService } from './credentials.service';
import { UserCredentialsService } from '../user-credentials/user-credentials.service';
import type { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// Shared credential-store internals — tests (issue #387)
// =============================================================================
//
// These functions used to be private to `CredentialsService` (and `deriveHint`
// exported from it). #387 moves them into one module that BOTH encrypted
// stores import. The "used by both" tests below spy on the module's exports
// and drive each service, so a future copy-paste that stops routing through
// here fails a test rather than quietly diverging.
// =============================================================================

const OWNER = '0b6f1d7e-3c2a-4f5b-9e8d-7a6c5b4d3e2f';

describe('credential-internals', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('deriveHint', () => {
    it('masks short secrets entirely', () => {
      expect(internals.deriveHint('1234567')).toBe('••••');
    });

    it('reveals the last four code points of a longer secret', () => {
      expect(internals.deriveHint('sk-abcdefgh1234')).toBe('••••1234');
      expect(internals.deriveHint('abcdefg🔐🔐🔐🔐')).toBe('••••🔐🔐🔐🔐');
    });

    it('is the same function everywhere it is imported from', () => {
      expect(reExportedDeriveHint).toBe(internals.deriveHint);
    });

    it('the BYOK AI key store imports it from here, not from a copy', () => {
      const source = readFileSync(
        join(__dirname, '..', 'ai', 'keys', 'user-ai-keys.service.ts'),
        'utf8',
      );
      expect(source).toContain(
        "import { deriveHint } from '../../credentials/credential-internals';",
      );
      expect(source).not.toMatch(/function deriveHint\b/);
    });
  });

  describe('isBlankSecret', () => {
    it.each([undefined, null, ''])('treats %p as blank', (value) => {
      expect(internals.isBlankSecret(value)).toBe(true);
    });

    it.each([' ', '  \n', 'x'])('treats %p as a real value (no trim)', (value) => {
      expect(internals.isBlankSecret(value)).toBe(false);
    });
  });

  describe('address validation', () => {
    it('rejects empty and whitespace-padded identifiers', () => {
      expect(() => internals.assertCredentialIdentifier('', 'name')).toThrow(BadRequestException);
      expect(() => internals.assertCredentialIdentifier(' a', 'name')).toThrow(/whitespace/);
    });

    it('rejects a purpose containing ":"', () => {
      expect(() => internals.assertCredentialPurpose('a:b')).toThrow(BadRequestException);
    });

    it('therefore rejects any purpose spelled like an owner-bound domain', () => {
      expect(() => internals.assertCredentialPurpose(`user:${OWNER}:smtp`)).toThrow(/":"/);
    });

    it('accepts every system purpose in use today', () => {
      for (const purpose of ['smtp', 'storage', 'push_vapid', 'ai', 'ai_user_key']) {
        expect(() => internals.assertCredentialPurpose(purpose)).not.toThrow();
      }
    });

    it('allows ":" in a name (it is not part of the cipher domain)', () => {
      expect(() => internals.assertCredentialAddress('smtp', 'a:b')).not.toThrow();
    });

    it.each([
      ['uppercase', OWNER.toUpperCase()],
      ['braced', `{${OWNER}}`],
      ['not a uuid', 'user-1'],
      ['empty', ''],
    ])('rejects a %s owner id', (_label, userId) => {
      expect(() => internals.assertCredentialOwner(userId)).toThrow(BadRequestException);
    });

    it('accepts a canonical owner id', () => {
      expect(() => internals.assertCredentialOwner(OWNER)).not.toThrow();
    });
  });

  describe('used by both stores', () => {
    // A Prisma stand-in returning "no row" everywhere: these tests are about
    // which validators and helpers each service routes through, not storage.
    function fakePrisma(): PrismaService {
      const model = {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      };
      return { credential: model, userCredential: model } as unknown as PrismaService;
    }

    const ORIGINAL_KEY = process.env.SECRETS_ENCRYPTION_KEY;
    beforeAll(() => {
      process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
    });
    afterAll(() => {
      if (ORIGINAL_KEY === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY;
    });

    it('both validate addresses through assertCredentialAddress', async () => {
      const spy = jest.spyOn(internals, 'assertCredentialAddress');
      await new CredentialsService(fakePrisma()).describe('smtp', 'default');
      await new UserCredentialsService(fakePrisma()).describe(OWNER, 'smtp', 'default');

      expect(spy).toHaveBeenCalledWith('smtp', 'default');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('both derive hints through deriveHint', async () => {
      const spy = jest.spyOn(internals, 'deriveHint');
      await new CredentialsService(fakePrisma()).setSecret('smtp', 'default', 'system-secret-1');
      await new UserCredentialsService(fakePrisma()).setSecret(
        OWNER,
        'smtp',
        'default',
        'user-secret-1',
      );

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('both detect blank secrets through isBlankSecret', async () => {
      const spy = jest.spyOn(internals, 'isBlankSecret');
      await expect(
        new CredentialsService(fakePrisma()).setSecret('smtp', 'default', ''),
      ).rejects.toThrow(BadRequestException);
      await expect(
        new UserCredentialsService(fakePrisma()).setSecret(OWNER, 'smtp', 'default', ''),
      ).rejects.toThrow(BadRequestException);

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('the system store now refuses a purpose that aliases a user domain', async () => {
      await expect(
        new CredentialsService(fakePrisma()).getSecret(`user:${OWNER}:smtp`, 'default'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
