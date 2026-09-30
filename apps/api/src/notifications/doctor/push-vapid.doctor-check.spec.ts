import { createECDH } from 'node:crypto';

import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { PushConfigService } from '../push-config.service';
import { PushVapidDoctorCheck, decidePushVapid } from './push-vapid.doctor-check';

function keyPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

describe('push.vapid doctor check', () => {
  it('warns, with a remedy, when push is not active', () => {
    const outcome = decidePushVapid(null);

    expect(outcome.status).toBe('warn');
    expect(outcome.remedy).toContain('/admin/settings/push');
  });

  it('passes a matching pair and a valid subject — and never echoes a key', () => {
    const pair = keyPair();
    const outcome = decidePushVapid({ ...pair, subject: 'mailto:ops@example.com' });

    expect(outcome.status).toBe('pass');
    expect(JSON.stringify(outcome)).not.toContain(pair.privateKey);
    expect(JSON.stringify(outcome)).not.toContain(pair.publicKey);
  });

  it('fails a private key that does not derive the public key', () => {
    const outcome = decidePushVapid({
      publicKey: keyPair().publicKey,
      privateKey: keyPair().privateKey,
      subject: 'https://example.com',
    });

    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('does not match');
    expect(outcome.remedy).toEqual(expect.any(String));
  });

  it('fails a malformed public key and a bad subject', () => {
    const outcome = decidePushVapid({ publicKey: 'nope', privateKey: keyPair().privateKey, subject: 'http://x' });

    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('public key');
    expect(outcome.detail).toContain('subject');
  });

  it('reads the active config (never sends) and registers itself', async () => {
    const resolveActiveVapidConfig = jest.fn().mockResolvedValue(null);
    const registry = new DoctorCheckRegistry();
    const check = new PushVapidDoctorCheck(registry, { resolveActiveVapidConfig } as unknown as PushConfigService);
    check.onModuleInit();

    await expect(check.run()).resolves.toMatchObject({ status: 'warn' });
    expect(registry.get('push.vapid')).toBe(check);
  });
});
