import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { PreconditionError } from '../errors.js';
import { execChecked, type ExecFn } from './exec.js';
import {
  BUILD_TOOLS_PACKAGE,
  PLATFORM_TOOLS_PACKAGE,
  SDK_PLATFORM_PACKAGE,
  cmdlineToolsUrl,
  sdkLayout,
} from './sdk.js';

// =============================================================================
// `android doctor --fix`: install the Android SDK pieces  (issue #286)
// =============================================================================
//
// Downloads Google's official cmdline-tools zip, unpacks it to
// `<sdk>/cmdline-tools/latest` (the layout sdkmanager insists on), accepts
// the licences and installs exactly what the app builds against. Never the
// JDK: that is the user's choice of vendor and package manager.
//
// No zip library: this package's dependencies are deliberately minimal, and
// every supported OS already ships an extractor (`unzip`, PowerShell's
// Expand-Archive).
// =============================================================================

export interface InstallerContext {
  exec: ExecFn;
  fetch?: typeof globalThis.fetch | undefined;
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  log: (line: string) => void;
}

export async function downloadFile(
  url: string,
  target: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchImpl(url);
  if (!response.ok || response.body === null) {
    throw new PreconditionError(`Downloading ${url} failed: HTTP ${response.status}.`);
  }
  await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), createWriteStream(target));
}

/** The extractor command for this OS. */
export function unzipCommand(
  zip: string,
  dest: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
      ],
    };
  }
  return { command: 'unzip', args: ['-q', '-o', zip, '-d', dest] };
}

/** Download and unpack cmdline-tools into `<sdk>/cmdline-tools/latest`. */
export async function installCmdlineTools(sdkRoot: string, ctx: InstallerContext): Promise<void> {
  const platform = ctx.platform ?? process.platform;
  const layout = sdkLayout(sdkRoot, platform);
  const work = mkdtempSync(join(tmpdir(), 'evopathcli-sdk-'));
  try {
    const url = cmdlineToolsUrl(platform);
    const zip = join(work, 'cmdline-tools.zip');
    ctx.log(`Downloading ${url}`);
    await downloadFile(url, zip, ctx.fetch);

    const extracted = join(work, 'x');
    mkdirSync(extracted, { recursive: true });
    const { command, args } = unzipCommand(zip, extracted, platform);
    ctx.log(`Extracting into ${layout.cmdlineToolsDir}`);
    await execChecked(ctx.exec, command, args, {
      missingHint: platform === 'win32' ? '' : 'Install `unzip` (e.g. `sudo apt install unzip`).',
    });

    mkdirSync(join(sdkRoot, 'cmdline-tools'), { recursive: true });
    if (existsSync(layout.cmdlineToolsDir)) rmSync(layout.cmdlineToolsDir, { recursive: true, force: true });
    // The zip's top-level folder is `cmdline-tools/`; sdkmanager requires it at `cmdline-tools/latest`.
    renameSync(join(extracted, 'cmdline-tools'), layout.cmdlineToolsDir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** sdkmanager's environment: the SDK root, and the same JDK doctor checked. */
function sdkEnv(sdkRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };
}

/** Accept every SDK licence (feeds "y" to each prompt). */
export async function acceptLicenses(sdkRoot: string, ctx: InstallerContext): Promise<void> {
  const platform = ctx.platform ?? process.platform;
  ctx.log('Accepting Android SDK licences');
  await execChecked(ctx.exec, sdkLayout(sdkRoot, platform).sdkmanager, [`--sdk_root=${sdkRoot}`, '--licenses'], {
    env: sdkEnv(sdkRoot, ctx.env ?? process.env),
    input: 'y\n'.repeat(64),
    platform,
  });
}

export const REQUIRED_SDK_PACKAGES = [PLATFORM_TOOLS_PACKAGE, SDK_PLATFORM_PACKAGE, BUILD_TOOLS_PACKAGE] as const;

export async function installSdkPackages(sdkRoot: string, ctx: InstallerContext): Promise<void> {
  const platform = ctx.platform ?? process.platform;
  ctx.log(`Installing ${REQUIRED_SDK_PACKAGES.join(', ')}`);
  await execChecked(
    ctx.exec,
    sdkLayout(sdkRoot, platform).sdkmanager,
    [`--sdk_root=${sdkRoot}`, ...REQUIRED_SDK_PACKAGES],
    {
      env: sdkEnv(sdkRoot, ctx.env ?? process.env),
      input: 'y\n'.repeat(16),
      platform,
      onLine: (line) => {
        if (/Installing|Unzipping|done/i.test(line)) ctx.log(`  ${line.trim()}`);
      },
    },
  );
}

export interface SdkFixPlan {
  cmdlineTools: boolean;
  licenses: boolean;
  packages: boolean;
}

/** Run whichever of the three fixes the plan says are needed, in order. */
export async function fixSdk(sdkRoot: string, plan: SdkFixPlan, ctx: InstallerContext): Promise<void> {
  mkdirSync(sdkRoot, { recursive: true });
  if (plan.cmdlineTools) await installCmdlineTools(sdkRoot, ctx);
  if (plan.licenses || plan.cmdlineTools) await acceptLicenses(sdkRoot, ctx);
  if (plan.packages) await installSdkPackages(sdkRoot, ctx);
}
