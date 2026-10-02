import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import { runBuild, type BuildResult } from '../android/build.js';
import { behindWarning, checkGitFreshness } from '../android/git-freshness.js';
import { formatAndroidDoctorReport, runAndroidDoctor, sdkFixesNeeded } from '../android/doctor.js';
import { exec as defaultExec, type ExecFn } from '../android/exec.js';
import { fixSdk } from '../android/installer.js';
import {
  DEFAULT_KEY_ALIAS,
  generateKeystore,
  githubSecrets,
  importKeystoreFile,
  keystorePath,
  readCertificateSha256,
  readSigningConfig,
  writeSigningConfig,
  type SigningConfig,
} from '../android/keystore.js';
import { apkFileName } from '../android/metadata.js';
import { bumpVersionFile, publishBuiltApk, readBuiltApk, releasesClient } from '../android/operations.js';
import { distDir, GRADLE_ARGS_ENV_VAR, REPO_ROOT_ENV_VAR, requireRepoRoot, versionPropertiesPath } from '../android/paths.js';
import {
  downloadPageUrl,
  formatBytes,
  formatReleasesTable,
  listReleases,
  makeCurrent,
  type AndroidRelease,
} from '../android/publish.js';
import { commitVersionFile, runRelease } from '../android/release.js';
import { applyVersionChange, parseBumpPart, readVersion, writeVersion, type AppVersion } from '../android/version.js';
import { CLI_NAME } from '../branding.js';
import { requireCredentials } from '../config.js';
import { PreconditionError, UsageError } from '../errors.js';
import { shouldUseColour } from '../output.js';
import { canPrompt, promptSecret } from '../prompt.js';

// =============================================================================
// `evopathcli android` — build, sign and publish the Android app  (issue #286)
// =============================================================================
//
// Inherited from program.ts: human output goes to STDERR (stdout carries only
// what a script would capture — a version, a table, `--json`), and failure is
// non-zero. The logic lives in src/android/*; this file is argument parsing
// and printing.
// =============================================================================

export interface AndroidCommandContext {
  stdout?: { write(chunk: string): unknown } | undefined;
  stderr?: { write(chunk: string): unknown; isTTY?: boolean } | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  exec?: ExecFn | undefined;
}

/** Env names the keystore passwords are read from (the same names Gradle and CI use). */
export const STORE_PASSWORD_ENV = 'ANDROID_KEYSTORE_PASSWORD';
export const KEY_PASSWORD_ENV = 'ANDROID_KEY_PASSWORD';

export function registerAndroidCommand(program: Command, ctx?: AndroidCommandContext): Command {
  const io = () => ({
    stdout: ctx?.stdout ?? process.stdout,
    stderr: ctx?.stderr ?? process.stderr,
    env: ctx?.env ?? process.env,
    exec: ctx?.exec ?? defaultExec,
  });
  const paths = () => ({
    env: ctx?.env ?? process.env,
    ...(ctx?.home !== undefined ? { home: ctx.home } : {}),
    ...(ctx?.cwd !== undefined ? { cwd: ctx.cwd } : {}),
  });
  const log = (line: string) => io().stderr.write(`${line}\n`);

  const android = program
    .command('android')
    .description('Build, sign and publish the Android app')
    .addHelpText(
      'after',
      [
        '',
        'Advanced environment:',
        `  ${REPO_ROOT_ENV_VAR}   repository root to use instead of searching upward for apps/android`,
        `  ${GRADLE_ARGS_ENV_VAR}  extra arguments appended to every Gradle run (e.g. "-I mirror.init.gradle.kts")`,
      ].join('\n'),
    );

  // ---- doctor -----------------------------------------------------------------
  android
    .command('doctor')
    .description('Check the JDK, Android SDK, Gradle wrapper and release keystore')
    .option('--fix', 'Install the Android SDK command-line tools, licences, platform and build-tools')
    .option('--json', 'Emit the report as JSON on stdout')
    .action(async (options: { fix?: boolean; json?: boolean }) => {
      const { stdout, stderr, env, exec } = io();
      const doctorCtx = { ...paths(), exec };
      let report = await runAndroidDoctor(doctorCtx);

      if (options.fix === true) {
        const plan = sdkFixesNeeded(report);
        if (plan.cmdlineTools || plan.licenses || plan.packages) {
          log(`Installing the Android SDK into ${report.sdk.root}…`);
          await fixSdk(report.sdk.root, plan, {
            exec,
            env,
            log,
            ...(ctx?.fetch !== undefined ? { fetch: ctx.fetch } : {}),
          });
          if (report.sdk.source !== 'ANDROID_HOME' && report.sdk.source !== 'ANDROID_SDK_ROOT') {
            log(`Installed. Gradle finds it automatically through ${CLI_NAME}; for Android Studio set ANDROID_HOME=${report.sdk.root}.`);
          }
          report = await runAndroidDoctor(doctorCtx);
        } else {
          log('Nothing for --fix to install. (The JDK and the keystore are never set up automatically.)');
        }
      }

      if (options.json === true) {
        stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        stderr.write(formatAndroidDoctorReport(report, { colour: shouldUseColour({ isTTY: stderr.isTTY === true, env }) }));
      }
      if (!report.ok) throw new PreconditionError('At least one Android check failed.');
    });

  // ---- keystore -----------------------------------------------------------------
  const keystore = android.command('keystore').description('Manage the release signing keystore (~/.evopathcli/android)');

  keystore
    .command('init')
    .description('Create a new release keystore (RSA 4096, valid 100 years)')
    .option('--alias <alias>', 'Key alias', DEFAULT_KEY_ALIAS)
    .option('--dname <dn>', 'Certificate subject', `CN=${DEFAULT_KEY_ALIAS}`)
    .action(async (options: { alias: string; dname: string }) => {
      const { env, exec } = io();
      if (readSigningConfig(paths()) !== undefined) {
        throw new PreconditionError(
          'A release keystore is already configured. Replacing it would make every installed copy un-updatable; refusing.',
        );
      }
      const password = await obtainNewPassword(env, ctx);
      const path = keystorePath(paths());
      // PKCS12 keystores have one password: keytool ignores a different -keypass.
      await generateKeystore({ path, alias: options.alias, storePassword: password, keyPassword: password, dname: options.dname }, { exec, env });
      const config: SigningConfig = { keystorePath: path, keyAlias: options.alias, storePassword: password, keyPassword: password };
      config.certSha256 = await readCertificateSha256(config, { exec, env });
      writeSigningConfig(config, paths());
      log(`Created ${path} (alias ${options.alias}).`);
      log(`SHA-256: ${config.certSha256}`);
      log('BACK IT UP NOW (keystore + passwords). Losing it means installed apps can never be updated.');
      log(`Run \`${CLI_NAME} android keystore secrets\` for the GitHub Actions secrets.`);
    });

  keystore
    .command('import')
    .description(`Use an existing keystore (passwords from ${STORE_PASSWORD_ENV}/${KEY_PASSWORD_ENV} or a prompt)`)
    .argument('<file>', 'Path to the .jks / .keystore / .p12 file')
    .option('--alias <alias>', 'Key alias', DEFAULT_KEY_ALIAS)
    .action(async (file: string, options: { alias: string }) => {
      const { env, exec } = io();
      const storePassword = await obtainPassword(env, STORE_PASSWORD_ENV, 'Keystore password: ', ctx);
      const keyPassword = env[KEY_PASSWORD_ENV] !== undefined && env[KEY_PASSWORD_ENV] !== '' ? env[KEY_PASSWORD_ENV] : storePassword;
      if (!existsSync(file)) throw new PreconditionError(`${file} does not exist.`);

      // Prove the alias and password BEFORE copying anything.
      const probe: SigningConfig = { keystorePath: file, keyAlias: options.alias, storePassword, keyPassword };
      const sha = await readCertificateSha256(probe, { exec, env });

      const target = keystorePath(paths());
      const samePath = resolve(target) === resolve(file);
      const path = samePath ? target : importKeystoreFile(file, paths());
      writeSigningConfig({ ...probe, keystorePath: path, certSha256: sha }, paths());
      log(`Imported ${file} → ${path} (alias ${options.alias}).`);
      log(`SHA-256: ${sha}`);
    });

  keystore
    .command('show')
    .description('Print the keystore path, alias and certificate SHA-256')
    .action(async () => {
      const { stdout, env, exec } = io();
      const config = requireSigning(paths());
      const sha = await readCertificateSha256(config, { exec, env });
      stdout.write(`keystore: ${config.keystorePath}\nalias:    ${config.keyAlias}\nsha256:   ${sha}\n`);
    });

  keystore
    .command('secrets')
    .description('Print the four GitHub Actions secrets (includes the passwords!)')
    .action(() => {
      const { stdout, stderr } = io();
      const config = requireSigning(paths());
      stderr.write(
        'WARNING: the values below are your release signing credentials. Paste them into GitHub → Settings → Secrets and variables → Actions, then clear your terminal.\n\n',
      );
      for (const secret of githubSecrets(config)) {
        stdout.write(`${secret.name}=${secret.value}\n`);
      }
    });

  // ---- version -----------------------------------------------------------------
  android
    .command('version')
    .description('Show or change apps/android/version.properties')
    .option('--bump <part>', 'Bump patch, minor or major (also increments versionCode)')
    .option('--set <x.y.z>', 'Set versionName (also increments versionCode)')
    .option('--code <n>', 'Set versionCode explicitly (must increase)')
    .option('--json', 'Print as JSON')
    .action((options: { bump?: string; set?: string; code?: string; json?: boolean }) => {
      const { stdout } = io();
      const root = requireRepoRoot(paths());
      const file = versionPropertiesPath(root);
      const current = readVersion(file);
      const code = options.code === undefined ? undefined : parseCode(options.code);
      const next = applyVersionChange(current, {
        bump: options.bump === undefined ? undefined : parseBumpPart(options.bump),
        set: options.set,
        code,
      });
      if (next !== undefined) {
        writeVersion(file, next);
        log(
          current.exists
            ? `${current.versionName} (${current.versionCode}) → ${next.versionName} (${next.versionCode})`
            : `Created ${file}`,
        );
      } else if (!current.exists) {
        log(`${file} does not exist yet; showing the defaults.`);
      }
      const shown = next ?? current;
      stdout.write(
        options.json === true
          ? `${JSON.stringify({ versionName: shown.versionName, versionCode: shown.versionCode }, null, 2)}\n`
          : `${shown.versionName} (${shown.versionCode})\n`,
      );
    });

  // ---- build -------------------------------------------------------------------
  const doBuild = async (options: { serverUrl?: string; debug?: boolean; requireUpToDate?: boolean }): Promise<BuildResult> => {
    const { env, exec } = io();
    const result = await runBuild(
      { serverUrl: options.serverUrl, debug: options.debug, requireUpToDate: options.requireUpToDate },
      { ...paths(), env, exec, log },
    );
    log(`APK:      ${result.apkPath} (${formatBytes(result.metadata.sizeBytes)})`);
    log(`Metadata: ${result.metadataPath}`);
    return result;
  };

  android
    .command('build')
    .description('Build and sign the APK into dist/android/ with a metadata JSON')
    .option('--server-url <url>', 'Default server URL baked into the app')
    .option('--debug', 'Build the debug variant (debug-signed, not publishable)')
    .option('--require-up-to-date', 'Refuse to build when the checkout is behind its upstream (or origin/main) instead of warning')
    .action(async (options: { serverUrl?: string; debug?: boolean; requireUpToDate?: boolean }) => {
      const result = await doBuild(options);
      io().stdout.write(`${result.apkPath}\n`);
    });

  // ---- publish -------------------------------------------------------------------
  const doPublish = async (
    apkPath: string,
    options: { notes?: string; current: boolean; force?: boolean },
  ): Promise<AndroidRelease> => {
    const metadata = readBuiltApk(apkPath);
    const credentials = requireCredentials(paths());
    log(`Uploading ${metadata.versionName} (${metadata.versionCode}) to ${credentials.serverUrl}…`);
    const { release } = await publishBuiltApk({
      apkPath,
      credentials,
      notes: options.notes,
      makeCurrent: options.current,
      force: options.force === true,
      fetch: ctx?.fetch,
    });
    log(`Published ${release.versionName} (${release.versionCode})${release.isCurrent === true ? ' — now the current release' : ''}.`);
    log(`Release id: ${release.id}`);
    log(`Download page: ${downloadPageUrl(credentials.serverUrl)}`);
    return release;
  };

  android
    .command('publish')
    .description('Upload a built APK to the configured server')
    .argument('[apk]', 'APK path (default: dist/android/<app>-android-<versionName>.apk)')
    .option('--notes <text>', 'Release notes')
    .option('--no-current', 'Upload without making it the current release')
    .option('--force', 'Make it current even if its versionCode is not newer')
    .action(async (apk: string | undefined, options: { notes?: string; current: boolean; force?: boolean }) => {
      const path = apk ?? defaultApkPath(paths());
      const release = await doPublish(path, options);
      io().stdout.write(`${release.id}\n`);
    });

  // ---- releases ----------------------------------------------------------------------
  const client = (): { client: ReturnType<typeof releasesClient>; serverUrl: string } => {
    const credentials = requireCredentials(paths());
    return { client: releasesClient(credentials, ctx?.fetch), serverUrl: credentials.serverUrl };
  };

  const releases = android
    .command('releases')
    .description('List the releases on the server; `releases current <id>` rolls back')
    .option('--json', 'Emit JSON on stdout')
    .action(async (options: { json?: boolean }) => {
      const list = await listReleases(client().client);
      io().stdout.write(options.json === true ? `${JSON.stringify(list, null, 2)}\n` : formatReleasesTable(list));
    });

  releases
    .command('current')
    .description('Make a release current (rollback is allowed)')
    .argument('<id>', 'Release id')
    .action(async (id: string) => {
      const release = await makeCurrent(client().client, id);
      log(`${release.versionName} (${release.versionCode}) is now the current release.`);
    });

  // ---- release --------------------------------------------------------------------------
  android
    .command('release')
    .description('Bump the version, build, publish, then commit version.properties')
    .option('--bump <part>', 'patch, minor or major', 'patch')
    .option('--notes <text>', 'Release notes')
    .option('--server-url <url>', 'Default server URL baked into the app')
    .option('--no-commit', 'Do not commit version.properties')
    .option('--require-up-to-date', 'Refuse to build when the checkout is behind its upstream (or origin/main) instead of warning')
    .action(async (options: { bump: string; notes?: string; serverUrl?: string; commit: boolean; requireUpToDate?: boolean }) => {
      const { stdout, exec } = io();
      const part = parseBumpPart(options.bump);
      const root = requireRepoRoot(paths());
      // Fail on missing credentials BEFORE bumping or spending minutes building.
      requireCredentials(paths());
      if (readSigningConfig(paths()) === undefined) {
        throw new PreconditionError(`No release keystore is configured. Run \`${CLI_NAME} android keystore init\` first.`);
      }
      // Checked BEFORE the bump as well as in the build: refusing only at the
      // build would leave version.properties bumped and uncommitted (#315).
      if (options.requireUpToDate === true) {
        const behind = behindWarning(await checkGitFreshness(root, { exec, env: io().env }));
        if (behind !== undefined) {
          throw new PreconditionError(`${behind.replace(/^⚠ /, '')} (refusing to release: --require-up-to-date)`);
        }
      }

      const outcome = await runRelease<BuildResult, AndroidRelease>(
        { bump: part, commit: options.commit },
        {
          bump: (bumpPart): AppVersion => bumpVersionFile(root, bumpPart).after,
          build: () =>
            doBuild({
              ...(options.serverUrl !== undefined ? { serverUrl: options.serverUrl } : {}),
              ...(options.requireUpToDate === true ? { requireUpToDate: true } : {}),
            }),
          publish: (build) => doPublish(build.apkPath, { ...(options.notes !== undefined ? { notes: options.notes } : {}), current: true }),
          commit: (version) => commitVersionFile(exec, root, version),
        },
        log,
      );
      log(`Commit: ${outcome.commit}`);
      stdout.write(`${outcome.version.versionName} (${outcome.version.versionCode})\n`);
    });

  return android;
}

function parseCode(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--code must be a whole number of at least 1 (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

function requireSigning(paths: { env: NodeJS.ProcessEnv; home?: string }): SigningConfig {
  const config = readSigningConfig(paths);
  if (config === undefined) {
    throw new PreconditionError(`No release keystore is configured. Run \`${CLI_NAME} android keystore init\` or \`keystore import <file>\`.`);
  }
  return config;
}

function defaultApkPath(paths: { env: NodeJS.ProcessEnv; home?: string; cwd?: string }): string {
  const root = requireRepoRoot(paths);
  const version = readVersion(versionPropertiesPath(root));
  return join(distDir(root), apkFileName(version.versionName));
}

async function obtainPassword(
  env: NodeJS.ProcessEnv,
  name: string,
  question: string,
  ctx?: AndroidCommandContext,
): Promise<string> {
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (ctx?.env === undefined && canPrompt()) {
    const answer = await promptSecret(question);
    if (answer !== '') return answer;
  }
  throw new UsageError(`Set ${name}, or run this in an interactive terminal to be asked.`);
}

/** A new keystore's password: env, a prompt (empty = generate), or generated. */
async function obtainNewPassword(env: NodeJS.ProcessEnv, ctx?: AndroidCommandContext): Promise<string> {
  const fromEnv = env[STORE_PASSWORD_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return validateNewPassword(fromEnv);
  if (ctx?.env === undefined && canPrompt()) {
    const first = await promptSecret('New keystore password (empty to generate one): ');
    if (first !== '') {
      const second = await promptSecret('Repeat it: ');
      if (first !== second) throw new UsageError('The passwords did not match.');
      return validateNewPassword(first);
    }
  }
  return randomBytes(24).toString('base64url');
}

function validateNewPassword(value: string): string {
  if (value.length < 6) throw new UsageError('keytool requires a keystore password of at least 6 characters.');
  return value;
}
