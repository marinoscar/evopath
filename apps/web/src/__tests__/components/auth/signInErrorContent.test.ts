import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SIGN_IN_ERROR_CODES,
  SIGN_IN_ERROR_CONTENT,
  DEFAULT_SIGN_IN_ERROR_CODE,
  resolveSignInErrorCode,
} from '../../../components/auth/signInErrorContent';

describe('signInErrorContent (#273)', () => {
  it('has copy for every code', () => {
    for (const code of SIGN_IN_ERROR_CODES) {
      expect(SIGN_IN_ERROR_CONTENT[code].headline).toBeTruthy();
    }
  });

  it('mirrors the API closed set of codes', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../../../api/src/auth/auth-error-codes.ts'),
      'utf8',
    );
    const block = /AUTH_ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source);
    expect(block).not.toBeNull();
    const apiCodes = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect([...SIGN_IN_ERROR_CODES].sort()).toEqual(apiCodes.sort());
  });

  it('reserves error severity for faults', () => {
    const errors = SIGN_IN_ERROR_CODES.filter((c) => SIGN_IN_ERROR_CONTENT[c].severity === 'error');
    expect(errors.sort()).toEqual(['authentication_failed', 'server_misconfigured']);
  });

  it('resolves known codes and falls back for everything else', () => {
    expect(resolveSignInErrorCode('not_allowlisted')).toBe('not_allowlisted');
    for (const bad of [null, undefined, '', 'nope', '<b>x</b>', 'constructor', '__proto__']) {
      expect(resolveSignInErrorCode(bad)).toBe(DEFAULT_SIGN_IN_ERROR_CODE);
    }
  });

  it('keeps the voice calm: no exclamation marks, copy for every code', () => {
    for (const code of SIGN_IN_ERROR_CODES) {
      const { headline, explanation, nextSteps } = SIGN_IN_ERROR_CONTENT[code];
      for (const text of [headline, explanation, ...nextSteps]) {
        expect(text).not.toContain('!');
      }
      expect(explanation.length).toBeGreaterThan(0);
      expect(nextSteps.length).toBeGreaterThan(0);
    }
  });

  it('frames the allowlist refusal as protection and invitation, and offers both next steps', () => {
    const { headline, explanation, nextSteps, primaryAction } =
      SIGN_IN_ERROR_CONTENT.not_allowlisted;
    expect(headline).toMatch(/invite-only/i);
    expect(explanation).toMatch(/private/i);
    expect(explanation).toMatch(/nothing was created or shared/i);
    expect(nextSteps.join(' ')).toMatch(/add your email/i);
    expect(nextSteps.join(' ')).toMatch(/different Google account/i);
    expect(primaryAction).toBe('different-account');
  });

  it('offers a retry for cancel and failure, and none for a misconfigured server', () => {
    expect(SIGN_IN_ERROR_CONTENT.access_denied.primaryAction).toBe('try-again');
    expect(SIGN_IN_ERROR_CONTENT.authentication_failed.primaryAction).toBe('try-again');
    expect(SIGN_IN_ERROR_CONTENT.server_misconfigured.primaryAction).toBe('none');
    expect(SIGN_IN_ERROR_CONTENT.account_disabled.primaryAction).toBe('different-account');
  });

  it('does not treat Object.prototype keys as codes', () => {
    for (const key of ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor']) {
      expect(resolveSignInErrorCode(key)).toBe(DEFAULT_SIGN_IN_ERROR_CODE);
    }
  });
});
