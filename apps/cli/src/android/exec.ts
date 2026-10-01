import { spawn } from 'node:child_process';

import { CliError, EXIT, PreconditionError, type ExitCode } from '../errors.js';

// =============================================================================
// Child-process wrapper for the Android toolchain  (issue #286, epic #276)
// =============================================================================
//
// NOT `deploy/executor.ts`'s `runCommand`, for two reasons that both matter
// here: it pins stdin to `ignore` (and `sdkmanager --licenses` must be fed
// "y" answers), and it cannot launch a Windows `.bat` (`gradlew.bat`,
// `sdkmanager.bat`, `apksigner.bat`) — since CVE-2024-27980 Node refuses to
// spawn a batch file without a shell.
//
// A MISSING TOOL IS A PRECONDITION, not a crash: ENOENT becomes
// `ToolMissingError` naming the binary and how to get it, so `android build`
// on a machine without a JDK says "install a JDK" rather than `spawn ENOENT`.
// =============================================================================

export interface ExecOptions {
  cwd?: string | undefined;
  /** Replaces the child's environment entirely when given. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Written to stdin, then stdin is closed. */
  input?: string | undefined;
  /** Each output line as it arrives (gradle progress). */
  onLine?: ((line: string, stream: 'stdout' | 'stderr') => void) | undefined;
  timeoutMs?: number | undefined;
  /** Hint appended when the binary does not exist. */
  missingHint?: string | undefined;
  /** Platform override, for tests of the `.bat` handling. */
  platform?: NodeJS.Platform | undefined;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** The binary could not be launched at all. */
export class ToolMissingError extends PreconditionError {}

/** The binary ran and failed. */
export class ToolFailedError extends CliError {
  readonly exitCode: ExitCode = EXIT.FAILURE;
  readonly result: ExecResult;

  constructor(message: string, result: ExecResult) {
    super(message);
    this.result = result;
  }
}

/** Whether a command must go through `cmd.exe` on Windows. */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(bat|cmd)$/i.test(command);
}

/** Quote an argument for `cmd.exe`. Only used for `.bat` launches on Windows. */
export function quoteWindowsArg(value: string): string {
  if (value.length > 0 && !/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Run a command and collect its output. Resolves with the exit code whatever
 * it is; use `execChecked` when non-zero is a failure.
 */
export const exec: ExecFn = (command, args, options = {}) => {
  const platform = options.platform ?? process.platform;
  const shell = needsShell(command, platform);

  return new Promise<ExecResult>((resolve, reject) => {
    const child = shell
      ? spawn([command, ...args].map(quoteWindowsArg).join(' '), {
          cwd: options.cwd,
          env: options.env,
          shell: true,
          windowsHide: true,
        })
      : spawn(command, [...args], { cwd: options.cwd, env: options.env, windowsHide: true });

    let stdout = '';
    let stderr = '';
    const pending = { stdout: '', stderr: '' };
    const feed = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (options.onLine === undefined) return;
      pending[stream] += chunk;
      let index = pending[stream].indexOf('\n');
      while (index !== -1) {
        options.onLine(pending[stream].slice(0, index).replace(/\r$/, ''), stream);
        pending[stream] = pending[stream].slice(index + 1);
        index = pending[stream].indexOf('\n');
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => feed('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => feed('stderr', chunk));

    const timer =
      options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (timer !== undefined) clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(
          new ToolMissingError(
            `\`${command}\` was not found.${options.missingHint === undefined ? '' : ` ${options.missingHint}`}`,
          ),
        );
        return;
      }
      reject(new ToolFailedError(`\`${command}\` could not be started: ${error.message}`, { code: -1, stdout, stderr }));
    });

    child.once('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      for (const stream of ['stdout', 'stderr'] as const) {
        if (pending[stream] !== '' && options.onLine !== undefined) options.onLine(pending[stream], stream);
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin?.on('error', () => {
        // The child exited before reading everything (sdkmanager stops asking
        // once every licence is accepted). Not an error.
      });
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
};

/** Like `exec`, but a non-zero exit throws `ToolFailedError` with the stderr tail. */
export async function execChecked(
  run: ExecFn,
  command: string,
  args: readonly string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const tail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-15).join('\n    ');
    throw new ToolFailedError(
      `\`${[command, ...args].join(' ')}\` exited ${result.code}${tail === '' ? '' : `\n    ${tail}`}`,
      result,
    );
  }
  return result;
}
