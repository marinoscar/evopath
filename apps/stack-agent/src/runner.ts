// =============================================================================
// Running a command, with every byte of output bounded
// =============================================================================
//
// The only process this agent ever spawns is the `docker` CLI, with an argv it
// built itself from fixed strings and its own container's labels. Nothing a
// client sends reaches an argv: no route takes a parameter.
//
// The runner is injected everywhere it is used, so the tests never touch
// Docker. `spawnRunner` is the real one.
// =============================================================================

import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string | undefined;
  timeoutMs: number;
}

export interface RunResult {
  /** The process's exit code; 124 on timeout, 127 when it could not start. */
  exitCode: number;
  /** stdout alone, tail-capped at `STDOUT_CAP_BYTES`. For parsing. */
  stdout: string;
  /** stdout and stderr interleaved, tail-capped at `OUTPUT_CAP_BYTES`. */
  output: string;
}

export type CommandRunner = (argv: readonly string[], options: RunOptions) => Promise<RunResult>;

/** What a client ever sees of a command's output: its last 4 KB. */
export const OUTPUT_CAP_BYTES = 4096;
/** Enough for `compose ps --format json` of two services, many times over. */
export const STDOUT_CAP_BYTES = 256 * 1024;

export const EXIT_TIMEOUT = 124;
export const EXIT_SPAWN_FAILED = 127;

/**
 * Keeps only the last `cap` bytes written to it. Memory is bounded by the cap
 * whatever the child prints: a runaway `compose up` cannot grow this process.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (buffer.length >= this.cap) {
      this.chunks = [buffer.subarray(buffer.length - this.cap)];
      this.size = this.cap;
      return;
    }
    this.chunks.push(buffer);
    this.size += buffer.length;
    while (this.size > this.cap) {
      const head = this.chunks[0] as Buffer;
      const excess = this.size - this.cap;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  toString(): string {
    // A cut can land inside a multi-byte character; drop the replacement
    // characters that leaves at the very start rather than show them.
    return Buffer.concat(this.chunks).toString('utf8').replace(/^�+/, '');
  }
}

/** Keeps the last `cap` bytes of a string, on the same rules as TailBuffer. */
export function tailCap(text: string, cap: number = OUTPUT_CAP_BYTES): string {
  const buffer = new TailBuffer(cap);
  buffer.push(text);
  return buffer.toString();
}

/**
 * The child's environment: an allow-list, never `process.env`.
 *
 * Two reasons. The agent's own STACK_AGENT_TOKEN has no business in a child
 * process. And compose INTERPOLATES from its environment before `.env`: any
 * variable this container happens to carry (NODE_ENV, NODE_VERSION, ...) would
 * silently override the deployment's `.env` for the same name. With only these
 * keys, the compose files are interpolated from the deployment's `.env` alone,
 * exactly as they are when `appctl deploy` runs them.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    // The root filesystem is read-only; the docker CLI's config dir lives on
    // the /tmp tmpfs.
    HOME: env['HOME'] ?? '/tmp',
    DOCKER_CONFIG: env['DOCKER_CONFIG'] ?? '/tmp/.docker',
  };
  if (env['DOCKER_HOST'] !== undefined) result['DOCKER_HOST'] = env['DOCKER_HOST'];
  return result;
}

/** The real runner: `spawn` without a shell, SIGTERM then SIGKILL on timeout. */
export const spawnRunner: CommandRunner = (argv, options) =>
  new Promise((resolve) => {
    const [command, ...args] = argv;
    const stdout = new TailBuffer(STDOUT_CAP_BYTES);
    const output = new TailBuffer(OUTPUT_CAP_BYTES);
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number, note?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (note !== undefined) output.push(`\n${note}\n`);
      resolve({ exitCode, stdout: stdout.toString(), output: output.toString() });
    };

    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(command as string, args, {
      cwd: options.cwd,
      env: childEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));

    child.on('error', (error) => finish(EXIT_SPAWN_FAILED, `failed to start: ${error.message}`));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(EXIT_TIMEOUT, `timed out after ${options.timeoutMs} ms`);
      } else {
        finish(code ?? 128, signal === null ? undefined : `terminated by ${signal}`);
      }
    });
  });
