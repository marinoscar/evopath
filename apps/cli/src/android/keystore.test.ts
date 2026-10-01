import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../errors.js';
import type { ExecFn, ExecOptions } from './exec.js';
import {
  fingerprintToHex,
  generateKeystore,
  githubSecrets,
  importKeystoreFile,
  keystorePath,
  parseSha256Fingerprint,
  readCertificateSha256,
  readSigningConfig,
  signingConfigPath,
  signingEnv,
  writeSigningConfig,
} from './keystore.js';

const FP = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16).toUpperCase().padStart(2, '0')).join(':');

describe('signing config storage', () => {
  it('returns undefined when nothing is stored', () => {
    const home = mkdtempSync(join(tmpdir(), 'ks-'));
    expect(readSigningConfig({ home })).toBeUndefined();
  });

  it('writes signing.json with mode 600 under ~/.evopathcli/android and reads it back', () => {
    const home = mkdtempSync(join(tmpdir(), 'ks-'));
    const config = { keystorePath: '/k.jks', keyAlias: 'a', storePassword: 's', keyPassword: 'k' };
    const path = writeSigningConfig(config, { home });
    expect(path).toBe(join(home, '.evopathcli', 'android', 'signing.json'));
    expect(readSigningConfig({ home })).toMatchObject(config);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects a corrupt or incomplete file', () => {
    const home = mkdtempSync(join(tmpdir(), 'ks-'));
    writeSigningConfig({ keystorePath: '/k', keyAlias: 'a', storePassword: 's', keyPassword: 'k' }, { home });
    writeFileSync(signingConfigPath({ home }), '{nope');
    expect(() => readSigningConfig({ home })).toThrow(ConfigError);
    writeFileSync(signingConfigPath({ home }), '{"keystorePath":"/k"}');
    expect(() => readSigningConfig({ home })).toThrow(/keyAlias/);
  });

  it('imports a keystore file into the managed location', () => {
    const home = mkdtempSync(join(tmpdir(), 'ks-'));
    const source = join(home, 'mine.jks');
    writeFileSync(source, 'keystore-bytes');
    const target = importKeystoreFile(source, { home });
    expect(target).toBe(keystorePath({ home }));
    expect(readFileSync(target, 'utf8')).toBe('keystore-bytes');
  });
});

describe('keytool wrappers', () => {
  it('parses and normalises the SHA-256 fingerprint', () => {
    expect(parseSha256Fingerprint(`Certificate fingerprints:\n\t SHA1: AA\n\t SHA256: ${FP}\n`)).toBe(FP);
    expect(fingerprintToHex(FP)).toBe(FP.replace(/:/g, '').toLowerCase());
    expect(parseSha256Fingerprint('nothing')).toBeUndefined();
  });

  it('never passes a password in argv (uses -storepass:env)', async () => {
    const calls: Array<{ args: readonly string[]; options?: ExecOptions }> = [];
    const exec: ExecFn = async (_command, args, options) => {
      calls.push({ args, ...(options !== undefined ? { options } : {}) });
      return { code: 0, stdout: `SHA256: ${FP}`, stderr: '' };
    };
    const sha = await readCertificateSha256(
      { keystorePath: '/k.jks', keyAlias: 'a', storePassword: 'hunter22', keyPassword: 'hunter22' },
      { exec, env: {} },
    );
    expect(sha).toBe(FP);
    expect(calls[0]?.args.join(' ')).not.toContain('hunter22');
    expect(calls[0]?.args).toContain('-storepass:env');
    expect(Object.values(calls[0]?.options?.env ?? {})).toContain('hunter22');

    const home = mkdtempSync(join(tmpdir(), 'ks-'));
    await generateKeystore(
      { path: join(home, 'new.jks'), alias: 'a', storePassword: 'hunter22', keyPassword: 'hunter22', dname: 'CN=x' },
      { exec, env: {} },
    );
    const gen = calls[1]?.args ?? [];
    expect(gen).toEqual(expect.arrayContaining(['-genkeypair', '-keyalg', 'RSA', '-keysize', '4096', '-validity', '36500']));
    expect(gen.join(' ')).not.toContain('hunter22');
  });

  it('refuses to overwrite an existing keystore', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ks-'));
    const path = join(home, 'exists.jks');
    writeFileSync(path, 'x');
    const exec: ExecFn = async () => ({ code: 0, stdout: '', stderr: '' });
    await expect(
      generateKeystore({ path, alias: 'a', storePassword: 'p', keyPassword: 'p', dname: 'CN=x' }, { exec }),
    ).rejects.toThrow(/Refusing to overwrite/);
  });
});

describe('signing env and GitHub secrets', () => {
  it('maps to the four Gradle/CI variables', () => {
    const home = mkdtempSync(join(tmpdir(), 'ks-'));
    const path = join(home, 'r.jks');
    writeFileSync(path, Buffer.from([1, 2, 3]));
    const config = { keystorePath: path, keyAlias: 'a', storePassword: 's', keyPassword: 'k' };
    expect(signingEnv(config)).toEqual({
      ANDROID_KEYSTORE_FILE: path,
      ANDROID_KEYSTORE_PASSWORD: 's',
      ANDROID_KEY_ALIAS: 'a',
      ANDROID_KEY_PASSWORD: 'k',
    });
    expect(githubSecrets(config)).toEqual([
      { name: 'ANDROID_KEYSTORE_BASE64', value: 'AQID' },
      { name: 'ANDROID_KEYSTORE_PASSWORD', value: 's' },
      { name: 'ANDROID_KEY_ALIAS', value: 'a' },
      { name: 'ANDROID_KEY_PASSWORD', value: 'k' },
    ]);
  });
});
