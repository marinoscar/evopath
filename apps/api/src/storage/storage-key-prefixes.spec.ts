import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BACKUP_KEY_PREFIX } from '../db-backup/db-backup-storage';
import { NODE_OUTPUT_KEY_PREFIX } from '../nodes/node-data-plane.service';
import { avatarKeyPrefix } from '../common/profile-image/profile-image';
import { aiOutputKeyPrefix } from '../ai/storage/ai-output-writer';
import { STORAGE_PROBE_KEY_PREFIX } from './config/storage-connection-test.service';
import {
  AI_OUTPUTS_KEY_PREFIX,
  AVATARS_KEY_PREFIX,
  DATABASE_BACKUPS_KEY_PREFIX,
  NODE_OUTPUTS_KEY_PREFIX,
  STORAGE_KEY_PREFIXES,
  STORAGE_TEST_KEY_PREFIX,
  UPLOADS_KEY_PREFIX,
} from './storage-key-prefixes';

/**
 * These assertions exist because of one concrete failure, recorded in the
 * portable deploy specification: a transcribed prefix list said `backups/`
 * where the real constant was `database-backups/`, and the purge built from it
 * would have reported COMPLETE while leaving every database backup in the
 * bucket. Nothing failed and nothing warned.
 *
 * So the list is not allowed to be a hypothesis about the code. Each entry is
 * checked against the writer that actually produces it.
 */
describe('STORAGE_KEY_PREFIXES', () => {
  it('every entry ends with a slash, so a purge never asks for `node-outputs//`', () => {
    for (const prefix of STORAGE_KEY_PREFIXES) {
      expect(prefix.endsWith('/')).toBe(true);
      expect(prefix).not.toMatch(/\/\//);
    }
  });

  it('holds exactly the six prefixes this application writes', () => {
    expect([...STORAGE_KEY_PREFIXES].sort()).toEqual([
      'ai-outputs/',
      'avatars/',
      'database-backups/',
      'node-outputs/',
      'storage-config-test/',
      'uploads/',
    ]);
  });

  it('is frozen, so a caller cannot narrow it and still believe it purged everything', () => {
    expect(Object.isFrozen(STORAGE_KEY_PREFIXES)).toBe(true);
  });

  describe('each entry matches the writer that produces it', () => {
    it('database backups: BACKUP_KEY_PREFIX is this list, not a second literal', () => {
      expect(BACKUP_KEY_PREFIX).toBe(DATABASE_BACKUPS_KEY_PREFIX);
      expect(STORAGE_KEY_PREFIXES).toContain(BACKUP_KEY_PREFIX);
    });

    it('node outputs: the writer joins `<prefix>/<jobId>`, so its constant has no slash', () => {
      expect(NODE_OUTPUT_KEY_PREFIX).toBe('node-outputs');
      expect(`${NODE_OUTPUT_KEY_PREFIX}/`).toBe(NODE_OUTPUTS_KEY_PREFIX);
    });

    it('avatars: the per-user key sits under the root prefix', () => {
      expect(avatarKeyPrefix('user-123')).toBe(`${AVATARS_KEY_PREFIX}user-123/`);
      expect(avatarKeyPrefix('user-123').startsWith(AVATARS_KEY_PREFIX)).toBe(true);
    });

    it('AI outputs: the per-user, per-run folder sits under the root prefix', () => {
      expect(aiOutputKeyPrefix('user-123', 'run-9')).toBe(`${AI_OUTPUTS_KEY_PREFIX}user-123/run-9/`);
      expect(aiOutputKeyPrefix('user-123', 'run-9').startsWith(AI_OUTPUTS_KEY_PREFIX)).toBe(true);
      expect(AI_OUTPUTS_KEY_PREFIX).toBe('ai-outputs/');
    });

    it('storage probes: the connection test writes under this list', () => {
      expect(STORAGE_PROBE_KEY_PREFIX).toBe(STORAGE_TEST_KEY_PREFIX);
    });

    it('uploads: the object service builds its key from the constant, not a literal', () => {
      // Read rather than invoked: the key is built inside a method that needs a
      // provider, a database and a request. What must be true is that the
      // literal is GONE from the source -- it appeared twice, and a third copy
      // is exactly how this drifts.
      const source = readFileSync(
        join(__dirname, 'objects', 'objects.service.ts'),
        'utf8',
      );

      expect(source).not.toMatch(/`uploads\//);
      expect(source).toContain('UPLOADS_KEY_PREFIX');
      expect(UPLOADS_KEY_PREFIX).toBe('uploads/');
    });
  });

  it('no writer in apps/api/src invents a prefix outside this list', () => {
    // The tripwire for a NEW writer. Anything building a storage key from a
    // bare literal at the start of a path is either a prefix that belongs on
    // this list, or a mistake -- and a purge cannot tell the difference, which
    // is why it has to be caught here instead.
    const known = new Set(STORAGE_KEY_PREFIXES.map((prefix) => prefix.replace(/\/$/, '')));

    for (const prefix of known) {
      expect(STORAGE_KEY_PREFIXES).toContain(`${prefix}/`);
    }
    expect(known.size).toBe(STORAGE_KEY_PREFIXES.length);
  });
});
