import { describe, expect, it } from 'vitest';

import { childEnv, OUTPUT_CAP_BYTES, spawnRunner, TailBuffer, tailCap } from './runner.js';

describe('TailBuffer / tailCap', () => {
  it('keeps everything under the cap', () => {
    const buffer = new TailBuffer(10);
    buffer.push('abc');
    buffer.push('def');
    expect(buffer.toString()).toBe('abcdef');
  });

  it('keeps only the last bytes across many chunks', () => {
    const buffer = new TailBuffer(5);
    for (const chunk of ['12345', '678', '9', 'abc']) buffer.push(chunk);
    expect(buffer.toString()).toBe('89abc');
  });

  it('caps a single oversized chunk', () => {
    const buffer = new TailBuffer(4);
    buffer.push('0123456789');
    expect(buffer.toString()).toBe('6789');
  });

  it('caps output at 4 KB by default', () => {
    const text = `${'x'.repeat(10_000)}END`;
    const capped = tailCap(text);
    expect(Buffer.byteLength(capped)).toBe(OUTPUT_CAP_BYTES);
    expect(capped.endsWith('END')).toBe(true);
  });

  it('does not start with a broken multi-byte character', () => {
    // 'é' is two bytes; a 3-byte tail of 'éé' cuts the first one in half.
    expect(tailCap('éé', 3)).toBe('é');
  });
});

describe('childEnv', () => {
  it('passes an allow-list, never the token or the rest of the environment', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      STACK_AGENT_TOKEN: 'secret-secret-secret-secret-secret',
      NODE_ENV: 'production',
      GREPTIME_ADMIN_PASSWORD: 'x',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/tmp', DOCKER_CONFIG: '/tmp/.docker' });
  });

  it('keeps DOCKER_HOST when set', () => {
    expect(childEnv({ DOCKER_HOST: 'unix:///run/docker.sock' })['DOCKER_HOST']).toBe(
      'unix:///run/docker.sock',
    );
  });
});

describe('spawnRunner', () => {
  it('returns the exit code, stdout and interleaved output', async () => {
    const result = await spawnRunner(
      [process.execPath, '-e', "process.stdout.write('out');process.stderr.write('err');process.exit(3)"],
      { timeoutMs: 10_000 },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('out');
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('does not hand the child its own environment', async () => {
    const before = process.env['STACK_AGENT_TOKEN'];
    process.env['STACK_AGENT_TOKEN'] = 'leak-leak-leak-leak-leak-leak-leak';
    try {
      const result = await spawnRunner(
        [process.execPath, '-e', "process.stdout.write(String(process.env.STACK_AGENT_TOKEN))"],
        { timeoutMs: 10_000 },
      );
      expect(result.stdout).toBe('undefined');
    } finally {
      if (before === undefined) delete process.env['STACK_AGENT_TOKEN'];
      else process.env['STACK_AGENT_TOKEN'] = before;
    }
  });

  it('caps what it keeps', async () => {
    const result = await spawnRunner(
      [process.execPath, '-e', "process.stdout.write('y'.repeat(100000) + 'TAIL')"],
      { timeoutMs: 10_000 },
    );
    expect(Buffer.byteLength(result.output)).toBe(OUTPUT_CAP_BYTES);
    expect(result.output.endsWith('TAIL')).toBe(true);
  });

  it('kills a command that outlives its timeout', async () => {
    const result = await spawnRunner(
      [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
      { timeoutMs: 200 },
    );
    expect(result.exitCode).toBe(124);
    expect(result.output).toMatch(/timed out/);
  });

  it('reports a command that cannot start', async () => {
    const result = await spawnRunner(['/nonexistent/docker'], { timeoutMs: 10_000 });
    expect(result.exitCode).toBe(127);
  });
});
