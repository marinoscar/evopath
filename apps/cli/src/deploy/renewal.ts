import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { UsageError } from '../errors.js';
import {
  CLI_RENEWAL_CRON_PATH,
  detectRenewalOwner,
  type CheckFs,
  type RenewalOwnership,
} from './checks/index.js';
import type { runCommand } from './executor.js';
import {
  CERTBOT_IMAGE,
  CONTAINER_CERT_ROOT,
  CONTAINER_WEBROOT,
  assertValidContainerName,
  type ProxyRuntime,
} from './proxy.js';

// =============================================================================
// Scheduling certificate renewal  (issue #391, epic #388)
// =============================================================================
//
// A certificate nobody renews is a 90-day timer on an outage, and the install
// that issued it is the natural place to schedule it. But the proxy is SHARED,
// so this acts on #390's answer to "who already renews here?":
//
//   - a central script, an enabled systemd timer, or another cron entry owns
//     it => DO NOTHING, and say which. A second schedule is not redundancy but
//     a race: two processes renewing the same certificates, spending a
//     rate-limit budget shared by every subdomain on the box;
//   - this CLI's own cron file owns it => make sure its content is current;
//   - nothing does => install a twice-daily entry.
//
// ⚠ THE RELOAD IS THE LOAD-BEARING HALF. nginx reads certificates when it
// loads its configuration, so a renewal that writes a new certificate to disk
// without reloading leaves the OLD one served until it expires, on a server
// whose files all look correct. The entry therefore runs `certbot renew`, then
// `nginx -t`, then a reload -- validated first, so a neighbour's broken vhost
// fails the reload visibly rather than taking the proxy down.
//
// ⚠ NOT THE DEPLOY. /etc/cron.d needs root; when it is not writable this
// returns `not-writable` with the exact file content as the remedy, and the
// install carries on. A missing schedule is a warning, never a failed deploy.
// =============================================================================

/** Twice a day at an off-peak minute, as certbot's own packaging recommends. */
export const RENEWAL_SCHEDULE = '17 3,15 * * *';

/** Marks a file this CLI wrote. */
export const RENEWAL_MARKER = `# Managed by ${CLI_NAME} deploy.`;

/** A path that is safe to put in a crontab line unquoted. */
const SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

function assertCronSafePath(path: string): void {
  if (!SAFE_PATH.test(path)) {
    throw new UsageError(
      `The proxy root "${path}" contains characters that cannot be written into a cron entry safely. ` +
        'Schedule renewal by hand, or use a plainer path.',
    );
  }
}

/** The command the cron entry runs: renew, then validate, then reload. */
export function renewalCommand(proxyRoot: string, runtime: ProxyRuntime): string {
  const root = proxyRoot.replace(/\/+$/, '');
  assertCronSafePath(root);

  if (runtime.mode === 'container') {
    assertValidContainerName(runtime.container);
    // The SAME mounts `certbotArgv` issues with, so the renewal config's
    // recorded paths resolve -- see proxy.ts's header on the two kinds of path.
    return [
      'docker run --rm',
      `-v ${join(root, 'letsencrypt')}:${CONTAINER_CERT_ROOT}`,
      `-v ${join(root, 'webroot')}:${CONTAINER_WEBROOT}`,
      `${CERTBOT_IMAGE} renew --quiet`,
      `&& docker exec ${runtime.container} nginx -t -q`,
      `&& docker exec ${runtime.container} nginx -s reload`,
    ].join(' ');
  }

  // Host certbot with its state under the proxy root, exactly as `certbotArgv`
  // issued it -- a bare `certbot renew` would look in /etc/letsencrypt and
  // renew nothing of ours.
  return [
    'certbot renew --quiet',
    `--config-dir ${join(root, 'letsencrypt')}`,
    `--work-dir ${join(root, 'letsencrypt', 'work')}`,
    `--logs-dir ${join(root, 'letsencrypt', 'logs')}`,
    '&& nginx -t -q',
    '&& nginx -s reload',
  ].join(' ');
}

/**
 * The whole cron file. Pure and deterministic: identical input, byte-identical
 * output, which is what makes a re-run a no-op.
 */
export function renderRenewalCron(target: { proxyRoot: string }, runtime: ProxyRuntime): string {
  return [
    `${RENEWAL_MARKER} Edits will be overwritten.`,
    `# Renews every certificate under ${target.proxyRoot.replace(/\/+$/, '')}/letsencrypt, then`,
    '# validates and reloads the shared proxy so a renewed certificate is actually',
    '# served. Remove this file if something else renews these certificates.',
    'SHELL=/bin/sh',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `${RENEWAL_SCHEDULE} root ${renewalCommand(target.proxyRoot, runtime)}`,
    '',
  ].join('\n');
}

export type RenewalAction =
  /** Another mechanism owns renewal; nothing was written. */
  | 'owned-elsewhere'
  /** This CLI's file is already exactly right. */
  | 'current'
  /** Nothing renewed; this CLI's file was written. */
  | 'installed'
  /** This CLI's file existed with other content, and was rewritten. */
  | 'updated'
  /** It needed writing, and could not be: see `remedy` and `content`. */
  | 'not-writable';

export interface RenewalResult {
  action: RenewalAction;
  detail: string;
  /** A warning worth surfacing even when nothing failed. */
  warning?: string | undefined;
  remedy?: string | undefined;
  /** The file content, when it was (or needed to be) written. */
  content?: string | undefined;
  path: string;
  ownership: RenewalOwnership;
}

export interface EnsureRenewalOptions {
  proxyRoot: string;
  runtime: ProxyRuntime;
  runCommand: typeof runCommand;
  /** Read-only probes for ownership detection. Defaults to the real filesystem. */
  fs?: CheckFs | undefined;
  /** Where the file goes. Defaults to `CLI_RENEWAL_CRON_PATH`; the test seam. */
  cronPath?: string | undefined;
  /** The writer, replaceable in tests. */
  writeFile?: ((path: string, content: string) => void) | undefined;
  /** The reader, replaceable in tests. Undefined when absent. */
  readFile?: ((path: string) => string | undefined) | undefined;
}

const LABELS: Record<Exclude<RenewalOwnership['owner'], 'none'>, string> = {
  'central-script': 'a central renewal script',
  'systemd-timer': 'the certbot systemd timer',
  cron: 'an existing cron entry',
  appctl: CLI_NAME,
};

function defaultRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function defaultWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // 0644: cron ignores group/world-writable files in /etc/cron.d.
  writeFileSync(path, content, { mode: 0o644 });
}

/** Acts on the renewal-ownership answer. Never throws for a write failure. */
export async function ensureRenewal(options: EnsureRenewalOptions): Promise<RenewalResult> {
  const path = options.cronPath ?? CLI_RENEWAL_CRON_PATH;
  const ownership = await detectRenewalOwner({
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    runCommand: options.runCommand,
    proxyRoot: options.proxyRoot,
    mode: options.runtime.mode,
  });

  if (ownership.owner !== 'none' && ownership.owner !== 'appctl') {
    const ours = ownership.mechanisms.find((mechanism) => mechanism.owner === 'appctl' && mechanism.owns);
    return {
      action: 'owned-elsewhere',
      detail: `renewal is owned by ${LABELS[ownership.owner]} (${ownership.detail}); not scheduling a second one`,
      // Never removed here: it may be what the operator is relying on while
      // they sort the other one out. Said, so the race is not invisible.
      ...(ours === undefined
        ? {}
        : {
            warning: `${CLI_NAME}'s own renewal schedule also exists, and races ${LABELS[ownership.owner]}`,
            remedy: `Remove this CLI's copy: rm ${path}`,
          }),
      path,
      ownership,
    };
  }

  const content = renderRenewalCron({ proxyRoot: options.proxyRoot }, options.runtime);
  const existing = (options.readFile ?? defaultRead)(path);

  if (existing === content) {
    return { action: 'current', detail: `renewal is scheduled by ${CLI_NAME} (${path}) and current`, content, path, ownership };
  }

  try {
    (options.writeFile ?? defaultWrite)(path, content);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    return {
      action: 'not-writable',
      detail: `could not write ${path} (${reason}); certificate renewal is NOT scheduled`,
      remedy: `As root, write ${path} with exactly this content (mode 0644):\n${content}`,
      content,
      path,
      ownership,
    };
  }

  return {
    action: existing === undefined ? 'installed' : 'updated',
    detail:
      existing === undefined
        ? `scheduled renewal twice daily in ${path}`
        : `brought ${path} up to date`,
    content,
    path,
    ownership,
  };
}
