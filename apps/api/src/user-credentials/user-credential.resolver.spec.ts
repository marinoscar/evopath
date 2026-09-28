import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { CredentialsService } from '../credentials/credentials.service';
import {
  USER_CREDENTIAL_PURPOSE_REGISTRY,
  UserCredentialResolver,
} from './user-credential.resolver';
import {
  USER_CREDENTIAL_PURPOSES,
  type UserCredentialPurposeDef,
} from './user-credential-purposes';
import { UserCredentialsService } from './user-credentials.service';

// =============================================================================
// UserCredentialResolver — tests (issue #387)
// =============================================================================
//
// The production registry is empty today (see `user-credential-purposes.ts`),
// so the resolver is exercised against a FIXTURE registry supplied through the
// same `USER_CREDENTIAL_PURPOSE_REGISTRY` token the module binds.
// =============================================================================

const ALICE = '0b6f1d7e-3c2a-4f5b-9e8d-7a6c5b4d3e2f';

const FIXTURE: UserCredentialPurposeDef[] = [
  {
    purpose: 'webhook',
    label: 'Webhook signing secret',
    description: 'Signs outbound webhooks sent on your behalf.',
    system: { purpose: 'webhook_org', name: 'default' },
  },
  {
    purpose: 'personal_token',
    label: 'Personal token',
    description: 'A token only you can supply.',
    system: null,
  },
];

describe('UserCredentialResolver', () => {
  let userGet: jest.Mock;
  let systemGet: jest.Mock;

  async function build(registry: readonly UserCredentialPurposeDef[] = FIXTURE) {
    const module = await Test.createTestingModule({
      providers: [
        UserCredentialResolver,
        { provide: UserCredentialsService, useValue: { getSecret: userGet } },
        { provide: CredentialsService, useValue: { getSecret: systemGet } },
        { provide: USER_CREDENTIAL_PURPOSE_REGISTRY, useValue: registry },
      ],
    }).compile();
    return module.get(UserCredentialResolver);
  }

  beforeEach(() => {
    userGet = jest.fn().mockResolvedValue(null);
    systemGet = jest.fn().mockResolvedValue(null);
  });

  it("the user's own key wins, and the system store is not consulted", async () => {
    userGet.mockResolvedValue('user-key');
    systemGet.mockResolvedValue('org-key');
    const resolver = await build();

    await expect(resolver.resolve(ALICE, 'webhook')).resolves.toEqual({
      source: 'user',
      purpose: 'webhook',
      secret: 'user-key',
    });
    expect(userGet).toHaveBeenCalledWith(ALICE, 'webhook', 'default');
    expect(systemGet).not.toHaveBeenCalled();
  });

  it("falls back to the deployment's key at the registry's system address", async () => {
    systemGet.mockResolvedValue('org-key');
    const resolver = await build();

    await expect(resolver.resolve(ALICE, 'webhook')).resolves.toEqual({
      source: 'system',
      purpose: 'webhook',
      secret: 'org-key',
    });
    expect(systemGet).toHaveBeenCalledWith('webhook_org', 'default');
  });

  it('answers none when neither is configured', async () => {
    const resolver = await build();
    await expect(resolver.resolve(ALICE, 'webhook')).resolves.toEqual({
      source: 'none',
      purpose: 'webhook',
    });
  });

  it('answers none without consulting the system store when there is no counterpart', async () => {
    const resolver = await build();
    await expect(resolver.resolve(ALICE, 'personal_token')).resolves.toEqual({
      source: 'none',
      purpose: 'personal_token',
    });
    expect(systemGet).not.toHaveBeenCalled();
  });

  it('passes a non-default user-side name through', async () => {
    userGet.mockResolvedValue('user-key');
    const resolver = await build();
    await resolver.resolve(ALICE, 'webhook', 'secondary');
    expect(userGet).toHaveBeenCalledWith(ALICE, 'webhook', 'secondary');
  });

  it('throws for a purpose not in the registry, before reading anything', async () => {
    const resolver = await build();
    await expect(resolver.resolve(ALICE, 'nope')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(userGet).not.toHaveBeenCalled();
    expect(systemGet).not.toHaveBeenCalled();
  });

  it("does NOT fall back to the deployment key when the user's key will not decrypt", async () => {
    userGet.mockRejectedValue(new InternalServerErrorException('could not be decrypted'));
    systemGet.mockResolvedValue('org-key');
    const resolver = await build();

    await expect(resolver.resolve(ALICE, 'webhook')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(systemGet).not.toHaveBeenCalled();
  });

  describe('registry validation at construction', () => {
    const base = FIXTURE[0];

    it.each([
      ['a duplicate purpose', [base, { ...base }]],
      ['a purpose containing ":"', [{ ...base, purpose: 'a:b' }]],
      ['a whitespace-padded purpose', [{ ...base, purpose: 'webhook ' }]],
      ['an invalid system address', [{ ...base, system: { purpose: 'x:y', name: 'default' } }]],
      ['a missing label', [{ ...base, label: '' }]],
    ])('rejects %s', async (_label, registry) => {
      await expect(build(registry as UserCredentialPurposeDef[])).rejects.toThrow();
    });
  });

  describe('the production registry', () => {
    it('is valid (the module can boot with it)', async () => {
      await expect(build(USER_CREDENTIAL_PURPOSES)).resolves.toBeInstanceOf(
        UserCredentialResolver,
      );
    });

    it('does not declare the AI provider key, which already lives in user_ai_keys', () => {
      // Declaring it here would create a second store for the same key.
      const purposes = USER_CREDENTIAL_PURPOSES.map((d) => d.purpose);
      expect(purposes).not.toContain('ai');
      expect(purposes).not.toContain('ai_user_key');
      expect(
        USER_CREDENTIAL_PURPOSES.filter((d) => d.system?.purpose === 'ai'),
      ).toEqual([]);
    });
  });
});
