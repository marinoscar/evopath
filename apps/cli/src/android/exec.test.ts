import { describe, expect, it } from 'vitest';

import { exec, execChecked, ToolFailedError, ToolMissingError } from './exec.js';
import { parseApksignerSha256 } from './build.js';

describe('exec', () => {
  it('feeds stdin and collects output line by line', async () => {
    const lines: string[] = [];
    const result = await exec(
      process.execPath,
      ['-e', 'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase()))'],
      { input: 'y\ny\n', onLine: (line) => lines.push(line) },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Y\nY\n');
    expect(lines).toEqual(['Y', 'Y']);
  });

  it('turns ENOENT into ToolMissingError with the hint', async () => {
    await expect(exec('definitely-not-a-tool-286', [], { missingHint: 'Install it.' })).rejects.toThrow(ToolMissingError);
    await expect(exec('definitely-not-a-tool-286', [], { missingHint: 'Install it.' })).rejects.toThrow(/Install it\./);
  });

  it('execChecked throws ToolFailedError with the stderr tail on non-zero', async () => {
    await expect(
      execChecked(exec, process.execPath, ['-e', 'console.error("boom"); process.exit(3)']),
    ).rejects.toThrow(ToolFailedError);
    await expect(
      execChecked(exec, process.execPath, ['-e', 'console.error("boom"); process.exit(3)']),
    ).rejects.toThrow(/exited 3\n\s+boom/);
  });
});

describe('parseApksignerSha256', () => {
  it('reads the first signer digest', () => {
    const hex = 'e1'.repeat(32);
    expect(parseApksignerSha256(`Signer #1 certificate DN: CN=x\nSigner #1 certificate SHA-256 digest: ${hex}\n`)).toBe(hex);
    expect(parseApksignerSha256('DOES NOT VERIFY')).toBeUndefined();
  });
});
