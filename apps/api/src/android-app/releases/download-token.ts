import { createHmac, timingSafeEqual } from 'node:crypto';

// =============================================================================
// APK download tokens (issue #285, epic #276)
// =============================================================================
//
// `GET /api/android-app/download/:token` must be a plain, NAVIGABLE URL: Chrome
// (and the Trusted Web Activity) hands a navigation to an APK to the system
// downloader, which carries no `Authorization` header. So the authorization is
// IN the URL: a token the server signed for one (release, user) pair, valid for
// minutes.
//
//   payload = [version 0x01][releaseId: 16 bytes][userId: 16 bytes][expiry: uint32 BE, unix s]
//   token   = base64url(payload) "." base64url(HMAC-SHA256(key, payload)[0..24])
//
// BINARY AND SHORT ON PURPOSE: Fastify refuses a path parameter longer than
// 100 characters (`maxParamLength`, 414), and a JSON payload of two UUIDs is
// already longer than that. This token is 83 characters. The MAC is truncated
// to 192 bits, far beyond what a ten-minute link needs.
//
// The key is derived from SECRETS_ENCRYPTION_KEY (`deriveSigningKey`), never a
// new environment variable. The token carries ids only; anyone holding it can
// fetch that one APK until it expires, which is the point of a link.
//
// VERIFICATION ORDER IS DELIBERATE: the signature is checked BEFORE the expiry
// is read, so an unsigned or tampered token is always "invalid" (404) and only
// a token this server issued can be reported as "expired" (410).
// =============================================================================

const VERSION = 0x01;
const PAYLOAD_BYTES = 1 + 16 + 16 + 4;
const MAC_BYTES = 24;

export interface DownloadTokenClaims {
  releaseId: string;
  userId: string;
  /** Expiry, unix seconds. */
  expiresAt: number;
}

export type DownloadTokenVerdict =
  | { ok: true; claims: DownloadTokenClaims }
  | { ok: false; reason: 'invalid' | 'expired' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(value: string): Buffer {
  if (!UUID.test(value)) throw new Error('Download token ids must be UUIDs');
  return Buffer.from(value.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mac(key: Buffer, payload: Buffer): Buffer {
  return createHmac('sha256', key).update(payload).digest().subarray(0, MAC_BYTES);
}

export function signDownloadToken(key: Buffer, claims: DownloadTokenClaims): string {
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload.writeUInt8(VERSION, 0);
  uuidToBytes(claims.releaseId).copy(payload, 1);
  uuidToBytes(claims.userId).copy(payload, 17);
  payload.writeUInt32BE(claims.expiresAt, 33);
  return `${payload.toString('base64url')}.${mac(key, payload).toString('base64url')}`;
}

/** At most this long: a guard against hashing an arbitrarily long path segment. */
const MAX_TOKEN_LENGTH = 128;

export function verifyDownloadToken(key: Buffer, token: string, nowSeconds: number): DownloadTokenVerdict {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'invalid' };
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid' };

  const payload = Buffer.from(parts[0], 'base64url');
  const given = Buffer.from(parts[1], 'base64url');
  if (payload.length !== PAYLOAD_BYTES || given.length !== MAC_BYTES) return { ok: false, reason: 'invalid' };

  if (!timingSafeEqual(given, mac(key, payload))) return { ok: false, reason: 'invalid' };
  if (payload.readUInt8(0) !== VERSION) return { ok: false, reason: 'invalid' };

  const expiresAt = payload.readUInt32BE(33);
  if (expiresAt <= nowSeconds) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: {
      releaseId: bytesToUuid(payload.subarray(1, 17)),
      userId: bytesToUuid(payload.subarray(17, 33)),
      expiresAt,
    },
  };
}
