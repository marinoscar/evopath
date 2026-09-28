import { CLI_NAME } from '../../branding.js';
import type { ProxyMode } from '../proxy.js';
import type { Check, CheckContext, CheckResult } from './types.js';
import { contextFs, contextServedCertificate, realFs } from './types.js';

// =============================================================================
// The certificate, if there is one yet  (issue #177, epic #168)
// =============================================================================
//
// NONE OF THESE ARE REQUIRED, and "no certificate" is a normal PASS on a first
// install - issuing one is what install is for. They exist so a re-run reports
// a known state rather than silently reissuing, and so an expiry creeping up
// is visible before it is an outage.
// =============================================================================

const WARN_WITHIN_DAYS = 30;

function livePath(context: CheckContext, file: string): string {
  return `${context.proxyRoot}/letsencrypt/live/${context.domain ?? ''}/${file}`;
}

/** Reads `notAfter=...` from `openssl x509 -enddate`. Exported for its test. */
export function parseNotAfter(output: string, now: Date): CheckResult {
  const match = /notAfter=(.+)/.exec(output);
  const raw = match?.[1]?.trim();

  if (raw === undefined) {
    return {
      status: 'warn',
      detail: 'could not read the certificate expiry',
      remedy: 'Check by hand: openssl x509 -enddate -noout -in <cert.pem>',
    };
  }

  const expiry = new Date(raw);
  if (Number.isNaN(expiry.getTime())) {
    return {
      status: 'warn',
      detail: `unrecognised expiry: ${raw}`,
      remedy: 'Check by hand: openssl x509 -enddate -noout -in <cert.pem>',
    };
  }

  const days = Math.floor((expiry.getTime() - now.getTime()) / 86_400_000);

  if (days < 0) {
    return {
      status: 'warn',
      detail: `expired ${-days} day(s) ago`,
      remedy: 'Renew it: certbot renew. Until then the site serves an invalid certificate.',
    };
  }
  if (days <= WARN_WITHIN_DAYS) {
    return {
      status: 'warn',
      detail: `expires in ${days} day(s)`,
      remedy: 'Renew it, and check that the renewal timer is actually running.',
    };
  }
  return { status: 'pass', detail: `valid for ${days} more day(s)` };
}

const certificatePresent: Check = {
  id: 'certificate-present',
  title: 'Certificate',
  severity: 'recommended',
  async run(context) {
    if (context.domain === undefined) {
      return { status: 'skip', detail: 'no domain given' };
    }

    const exists = contextFs(context).exists(livePath(context, 'fullchain.pem'));
    return exists
      ? { status: 'pass', detail: `already issued for ${context.domain}` }
      : {
          // Not a failure: on a first install this is the expected state and
          // issuing one is exactly what install does next.
          status: 'pass',
          detail: `none yet for ${context.domain}; install will request one`,
        };
  },
};

const certificateValidity: Check = {
  id: 'certificate-validity',
  title: 'Certificate validity',
  severity: 'recommended',
  requires: ['certificate-present'],
  async run(context) {
    if (context.domain === undefined) {
      return { status: 'skip', detail: 'no domain given' };
    }

    const path = livePath(context, 'cert.pem');
    if (!contextFs(context).exists(path)) {
      return { status: 'skip', detail: 'no certificate to inspect yet' };
    }

    try {
      // Read from disk rather than by making a TLS connection, so this works
      // before the vhost is live.
      const result = await context.runCommand(
        ['openssl', 'x509', '-enddate', '-noout', '-in', path],
        { cwd: process.cwd(), timeoutMs: 15_000 },
      );
      return parseNotAfter(result.stdout, new Date());
    } catch {
      return {
        status: 'skip',
        detail: 'openssl is not available to read the expiry',
      };
    }
  },
};

// -----------------------------------------------------------------------------
// Who owns renewal  (issue #390, epic #388)
// -----------------------------------------------------------------------------
//
// The answer is not "is anything scheduled" but WHICH mechanism is, because
// that decides whether install (#391) should schedule anything: on a server
// whose certificates are already renewed by a central script covering every
// application on the box, a second schedule is not redundancy but a race --
// two processes renewing the same certificates, spending a rate-limit budget
// shared by every subdomain.
// -----------------------------------------------------------------------------

/**
 * Where #391 installs this CLI's own renewal schedule, when nothing else owns
 * it: `/etc/cron.d/appctl-certbot-renew` for the stock CLI name. Built from
 * `CLI_NAME` so a renamed fork stays consistent (and so no `APPCTL_`-prefixed
 * literal trips the env-prefix guard).
 */
export const CLI_RENEWAL_CRON_PATH = `/etc/cron.d/${CLI_NAME}-certbot-renew`;

/** The file the certbot distribution package ships. */
const CERTBOT_PACKAGE_CRON_PATH = '/etc/cron.d/certbot';

export type RenewalOwnerKind = 'central-script' | 'systemd-timer' | 'cron' | 'appctl' | 'none';

export interface RenewalMechanism {
  owner: Exclude<RenewalOwnerKind, 'none'>;
  /** One line: what was found, and where. */
  detail: string;
  /** The script, cron file or unit that does it. */
  path?: string | undefined;
  /**
   * Whether this mechanism renews THIS proxy's certificates. False for a host
   * certbot (systemd timer, or a cron line running host certbot) when the
   * proxy is containerised: that renews the host's /etc/letsencrypt, not
   * `<proxyRoot>/letsencrypt`. Recorded so it is visible, never the owner.
   */
  owns: boolean;
}

export interface RenewalOwnership {
  /**
   * The mechanism that owns renewal, by precedence: a central script, then a
   * systemd timer, then any other cron entry, then appctl's own. `none` when
   * nothing renews at all.
   */
  owner: RenewalOwnerKind;
  detail: string;
  path?: string | undefined;
  /** EVERY mechanism found, in precedence order -- more than one is worth knowing. */
  mechanisms: RenewalMechanism[];
  /**
   * `*renew*` scripts under the proxy root that renew with certbot but that
   * nothing schedules. Reported so a remedy can say "schedule THIS", never
   * counted as an owner.
   */
  unscheduledScripts: string[];
}

export interface RenewalProbe {
  /** Defaults to the real filesystem. */
  fs?: CheckContext['fs'];
  runCommand: CheckContext['runCommand'];
  /** Where to look for an unscheduled central script. Optional. */
  proxyRoot?: string | undefined;
  /**
   * How the proxy runs. In `container` mode a host certbot (timer, or a cron
   * line that neither names the proxy root nor runs the certbot/certbot image)
   * is recorded but does not own renewal. Undefined keeps the historical,
   * mode-blind behaviour.
   */
  mode?: ProxyMode | undefined;
}

const OWNER_PRECEDENCE: readonly RenewalMechanism['owner'][] = [
  'central-script',
  'systemd-timer',
  'cron',
  'appctl',
];

/** True when a script's contents renew certificates with certbot. */
export function renewsWithCertbot(contents: string | undefined): boolean {
  if (contents === undefined) return false;
  return /certbot/i.test(contents) && /\brenew\b/i.test(contents);
}

/** Interpreters and binaries that are never the "script" a cron line runs. */
const NOT_A_SCRIPT = new Set(['certbot', 'docker', 'sh', 'bash', 'dash', 'zsh', 'env', 'flock', 'nice', 'ionice', 'timeout', 'run-parts']);

/**
 * The absolute-path tokens of a cron command that could be a script it runs.
 *
 * Redirection targets (`>> /var/log/renew.log`) are excluded: a log file can
 * perfectly well mention `certbot renew`, and must not be mistaken for the
 * thing that does it.
 */
export function cronCommandPaths(line: string): string[] {
  const tokens = line.trim().split(/\s+/);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const previous = tokens[index - 1] ?? '';
    if (/^\d*[<>]{1,2}&?$/.test(previous)) continue;
    if (/^\d*[<>]/.test(token)) continue;
    const cleaned = token.replace(/^["']|["';&|]+$/g, '');
    if (!cleaned.startsWith('/')) continue;
    const name = cleaned.slice(cleaned.lastIndexOf('/') + 1);
    if (NOT_A_SCRIPT.has(name)) continue;
    paths.push(cleaned);
  }
  return paths;
}

/** The scheduling lines of a crontab: no comments, blanks or VAR=value lines. */
export function cronLines(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .filter((line) => !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line));
}

/** Why a host certbot does not own a containerised proxy's certificates. */
const HOST_CERTBOT_NOTE =
  'renews the host /etc/letsencrypt, not the containerised proxy\'s certificates';

/**
 * True when a DIRECT cron line (one invoking certbot itself) renews this
 * proxy's certificates: always outside container mode; in container mode only
 * when it names the proxy root or runs the dockerised certbot/certbot image.
 */
function cronLineOwns(line: string, probe: RenewalProbe): boolean {
  if (probe.mode !== 'container') return true;
  if (/certbot\/certbot/i.test(line)) return true;
  const root = probe.proxyRoot?.replace(/\/+$/, '');
  return root !== undefined && root !== '' && line.includes(root);
}

/**
 * Classifies one cron source's lines: a line running a script that renews
 * with certbot is a `central-script`; a line invoking `certbot ... renew`
 * directly is a `cron` owner.
 */
function classifyCron(
  fs: NonNullable<CheckContext['fs']>,
  probe: RenewalProbe,
  contents: string,
  source: string,
  /** The cron FILE, when the source is one; root's crontab has no path. */
  sourcePath?: string,
): RenewalMechanism[] {
  const found: RenewalMechanism[] = [];
  for (const line of cronLines(contents)) {
    const script = cronCommandPaths(line).find(
      (path) => fs.exists(path) && !fs.isDirectory(path) && renewsWithCertbot(fs.readFile(path)),
    );
    if (script !== undefined) {
      found.push({
        owner: 'central-script',
        detail: `${script}, scheduled from ${source}`,
        path: script,
        owns: true,
      });
      continue;
    }
    if (/\bcertbot\b/i.test(line) && /\brenew\b/i.test(line)) {
      const owns = cronLineOwns(line, probe);
      found.push({
        owner: 'cron',
        detail: `certbot renew, scheduled from ${source}${owns ? '' : ` (${HOST_CERTBOT_NOTE})`}`,
        ...(sourcePath === undefined ? {} : { path: sourcePath }),
        owns,
      });
    }
  }
  return found;
}

/** root's crontab, or undefined when there is none or it cannot be read. */
async function rootCrontab(run: CheckContext['runCommand']): Promise<string | undefined> {
  for (const argv of [['crontab', '-l', '-u', 'root'], ['crontab', '-l']] as const) {
    try {
      const result = await run(argv, { cwd: process.cwd(), timeoutMs: 15_000 });
      return result.stdout;
    } catch {
      // "no crontab for root", or not permitted to read root's -- try the next.
    }
  }
  return undefined;
}

/**
 * Works out which mechanism renews certificates on this box. Read-only; never
 * throws.
 *
 * Recognised, generically rather than by name:
 *   - a CENTRAL SCRIPT: a cron line (root's crontab, /etc/crontab, /etc/cron.d/*)
 *     whose command runs an existing file that itself runs `certbot renew`;
 *   - a SYSTEMD TIMER: `systemctl is-enabled certbot.timer`;
 *   - a CRON entry: /etc/cron.d/certbot, or any cron line invoking
 *     `certbot ... renew` directly;
 *   - APPCTL's own: `CLI_RENEWAL_CRON_PATH`, the file #391 installs.
 *
 * Exported for #391: its renewal step acts on exactly this answer.
 */
export async function detectRenewalOwner(probe: RenewalProbe): Promise<RenewalOwnership> {
  const fs = probe.fs ?? realFs;
  const mechanisms: RenewalMechanism[] = [];

  const crontab = await rootCrontab(probe.runCommand);
  if (crontab !== undefined) mechanisms.push(...classifyCron(fs, probe, crontab, "root's crontab"));

  const systemCrontab = fs.readFile('/etc/crontab');
  if (systemCrontab !== undefined) mechanisms.push(...classifyCron(fs, probe, systemCrontab, '/etc/crontab', '/etc/crontab'));

  for (const name of fs.readdir('/etc/cron.d').slice().sort()) {
    const path = `/etc/cron.d/${name}`;
    if (path === CLI_RENEWAL_CRON_PATH || path === CERTBOT_PACKAGE_CRON_PATH) continue;
    const contents = fs.readFile(path);
    if (contents !== undefined) mechanisms.push(...classifyCron(fs, probe, contents, path, path));
  }

  const timer = await probe
    .runCommand(['systemctl', 'is-enabled', 'certbot.timer'], { cwd: process.cwd(), timeoutMs: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (timer) {
    // A systemd timer runs the HOST certbot against the host's config dir; in
    // container mode that is never this proxy's certificates.
    const owns = probe.mode !== 'container';
    mechanisms.push({
      owner: 'systemd-timer',
      detail: `certbot.timer is enabled${owns ? '' : ` (${HOST_CERTBOT_NOTE})`}`,
      path: 'certbot.timer',
      owns,
    });
  }

  if (fs.exists(CERTBOT_PACKAGE_CRON_PATH)) {
    // Outside container mode its existence is enough (the historical rule).
    // In container mode it owns renewal only if a line in it names the proxy
    // root or runs the dockerised certbot.
    const owns =
      probe.mode !== 'container' ||
      cronLines(fs.readFile(CERTBOT_PACKAGE_CRON_PATH) ?? '').some((line) => cronLineOwns(line, probe));
    mechanisms.push({
      owner: 'cron',
      detail: `${CERTBOT_PACKAGE_CRON_PATH}${owns ? '' : ` (${HOST_CERTBOT_NOTE})`}`,
      path: CERTBOT_PACKAGE_CRON_PATH,
      owns,
    });
  }

  if (fs.exists(CLI_RENEWAL_CRON_PATH)) {
    mechanisms.push({
      owner: 'appctl',
      detail: `scheduled by ${CLI_NAME} (${CLI_RENEWAL_CRON_PATH})`,
      path: CLI_RENEWAL_CRON_PATH,
      owns: true,
    });
  }

  // De-duplicated by owner+path: the same script referenced twice is one owner.
  const unique = mechanisms.filter(
    (mechanism, index) =>
      mechanisms.findIndex((other) => other.owner === mechanism.owner && other.path === mechanism.path) === index,
  );
  unique.sort((a, b) => OWNER_PRECEDENCE.indexOf(a.owner) - OWNER_PRECEDENCE.indexOf(b.owner));

  const scheduled = new Set(unique.filter((m) => m.owns).map((mechanism) => mechanism.path));
  const unscheduledScripts =
    probe.proxyRoot === undefined
      ? []
      : fs
          .readdir(probe.proxyRoot)
          .filter((name) => /renew/i.test(name))
          .map((name) => `${probe.proxyRoot as string}/${name}`)
          .filter((path) => !scheduled.has(path) && !fs.isDirectory(path) && renewsWithCertbot(fs.readFile(path)))
          .sort();

  const primary = unique.find((mechanism) => mechanism.owns);
  if (primary === undefined) {
    const ignored = unique.map((mechanism) => mechanism.detail);
    return {
      owner: 'none',
      detail:
        (unscheduledScripts.length === 0
          ? 'no renewal timer, cron entry or scheduled renewal script found'
          : `${unscheduledScripts.join(', ')} renews certificates, but nothing schedules it`) +
        (ignored.length === 0 ? '' : `; found but not renewing this proxy: ${ignored.join('; ')}`),
      mechanisms: unique,
      unscheduledScripts,
    };
  }

  return {
    owner: primary.owner,
    detail: primary.detail,
    ...(primary.path === undefined ? {} : { path: primary.path }),
    mechanisms: unique,
    unscheduledScripts,
  };
}

const certificateRenewal: Check = {
  id: 'certificate-renewal',
  title: 'Automatic renewal',
  severity: 'recommended',
  // No `requires`, and no domain needed: WHO renews is a property of the box,
  // not of one certificate, and install (#391) needs the answer before the
  // first certificate exists -- that is when it decides whether to schedule.
  async run(context) {
    const ownership = await detectRenewalOwner({
      fs: contextFs(context),
      runCommand: context.runCommand,
      proxyRoot: context.proxyRoot,
      mode: context.proxyRuntime?.mode,
    });

    if (ownership.owner === 'none') {
      const script = ownership.unscheduledScripts[0];
      return {
        status: 'warn',
        detail: ownership.detail,
        // A certificate nobody renews is a 90-day timer on an outage.
        remedy:
          script !== undefined
            ? `Schedule it from root's crontab (crontab -e -u root), e.g.: 17 3,15 * * * ${script} -- or the site breaks 90 days from issuance with no warning.`
            : 'Set up automatic renewal -- a twice-daily certbot renew followed by a proxy reload -- or the site breaks 90 days from issuance with no warning.',
      };
    }

    const others = ownership.mechanisms.filter((mechanism) => mechanism.path !== ownership.path || mechanism.owner !== ownership.owner);
    const labels: Record<RenewalMechanism['owner'], string> = {
      'central-script': 'central script',
      'systemd-timer': 'systemd timer',
      cron: 'cron',
      appctl: CLI_NAME,
    };
    const detail =
      `owned by ${labels[ownership.owner as RenewalMechanism['owner']]}: ${ownership.detail}` +
      (others.length === 0 ? '' : `; also: ${others.map((other) => other.detail).join('; ')}`);

    // appctl's own schedule ALONGSIDE another owner is the race #391 exists to
    // avoid: two processes renewing the same certificates.
    const appctl = ownership.mechanisms.find((mechanism) => mechanism.owner === 'appctl' && mechanism.owns);
    if (appctl !== undefined && ownership.owner !== 'appctl') {
      return {
        status: 'warn',
        detail,
        remedy: `Renewal is scheduled twice, which races on the same certificates. Remove ${CLI_NAME}'s copy: rm ${CLI_RENEWAL_CRON_PATH}`,
      };
    }

    return { status: 'pass', detail };
  },
};

/** `<proxyRoot>/letsencrypt/renewal/*.conf`, as HOST paths. */
function renewalConfs(context: CheckContext): string[] {
  const dir = `${context.proxyRoot}/letsencrypt/renewal`;
  return contextFs(context)
    .readdir(dir)
    .filter((name) => name.endsWith('.conf'))
    .sort()
    .map((name) => `${dir}/${name}`);
}

/** The host proxy root as it appears inside a renewal config, with a trailing slash. */
function hostRootOf(context: CheckContext): string {
  return `${context.proxyRoot.replace(/\/+$/, '')}/`;
}

/** The domain a renewal config belongs to: certbot names it `<domain>.conf`. */
function confDomain(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1, -'.conf'.length);
}

/** Renewal configs that record HOST paths, which a dockerised renew cannot follow. */
function hostPathConfs(context: CheckContext): string[] {
  const hostRoot = hostRootOf(context);
  const fs = contextFs(context);
  return renewalConfs(context).filter((path) => fs.readFile(path)?.includes(hostRoot) === true);
}

/** True when THIS deployment's own renewal config records host paths. */
function ownConfBroken(context: CheckContext): boolean {
  const domain = context.domain;
  if (domain === undefined) return false;
  return hostPathConfs(context).some((path) => confDomain(path) === domain);
}

/**
 * Renewal configs a dockerised `certbot renew` can actually follow.
 *
 * A certificate issued by a HOST certbot with `--config-dir <proxyRoot>/...`
 * records host paths in its renewal config. The dockerised certbot sees the
 * same directory mounted at /etc/letsencrypt, cannot resolve them, and reports
 * "expected /etc/letsencrypt/live/<domain>/cert.pem to be a symlink" -- the
 * certificate silently stops renewing, and the first symptom is an expired
 * certificate ninety days later. This turns that into a doctor finding today.
 *
 * Container mode only: in host mode the host paths are the right paths.
 *
 * ⚠ REQUIRED ONLY FOR THIS DEPLOYMENT'S OWN CONFIG. The letsencrypt directory
 * is shared by every application on the box, and an install must not be
 * refused over a NEIGHBOUR's broken renewal -- this deployment cannot fix it
 * and does not depend on it. So `renewal/<domain>.conf` with host paths is a
 * required failure; any other domain's is a recommended warning that names
 * them. With no domain in the context there is no "own" config, so it is
 * recommended throughout.
 */
const certificateRenewalPaths: Check = {
  id: 'certificate-renewal-paths',
  title: 'Renewal configs use container paths',
  severity: 'recommended',
  severityFor: (context) =>
    context.proxyRuntime?.mode === 'container' && context.skipProxy !== true && ownConfBroken(context)
      ? 'required'
      : 'recommended',
  async run(context) {
    if (context.proxyRuntime?.mode !== 'container') {
      return {
        status: 'skip',
        detail:
          context.proxyRuntime === undefined
            ? 'proxy runtime unknown'
            : 'the proxy runs on the host, so host paths are correct',
      };
    }

    const confs = renewalConfs(context);
    if (confs.length === 0) {
      return { status: 'skip', detail: 'no renewal configs yet' };
    }

    const offending = hostPathConfs(context);
    if (offending.length === 0) {
      return { status: 'pass', detail: `${confs.length} renewal config(s) use container paths` };
    }

    const hostRoot = hostRootOf(context);
    const domains = offending.map(confDomain);
    const own = context.domain !== undefined && domains.includes(context.domain);
    const others = domains.filter((domain) => domain !== context.domain);
    const fix =
      `Rewrite them to the paths certbot sees inside the container: ` +
      `sed -i -e 's#${hostRoot}letsencrypt#/etc/letsencrypt#g' -e 's#${hostRoot}webroot#/var/www/certbot#g' ` +
      `${offending.join(' ')} ` +
      `-- then confirm with: docker run --rm -v ${context.proxyRoot}/letsencrypt:/etc/letsencrypt -v ${context.proxyRoot}/webroot:/var/www/certbot certbot/certbot:latest renew --dry-run. ` +
      `Future certificates are issued by the dockerised certbot (no --config-dir/--work-dir/--logs-dir), which records container paths.`;

    if (own) {
      return {
        status: 'fail',
        detail:
          `the renewal config for ${context.domain as string} records host paths under ${hostRoot}` +
          (others.length === 0 ? '' : `; so do: ${others.join(', ')}`),
        remedy: `A dockerised certbot renew cannot follow it, so this certificate will silently stop renewing. ${fix}`,
      };
    }

    // Another application's problem, not this deployment's: reported so it is
    // not lost, never allowed to block this install.
    return {
      status: 'warn',
      detail: `other applications' renewal config(s) record host paths under ${hostRoot}: ${others.join(', ')}`,
      remedy: `Those certificates will silently stop renewing under a dockerised certbot renew. ${fix}`,
    };
  },
};

/** How far apart two expiries may be and still be the same certificate. */
const SAME_CERTIFICATE_TOLERANCE_MS = 60_000;

/**
 * The certificate the proxy SERVES, against the one on disk.
 *
 * A renewed certificate on disk is not a served certificate: nginx reads it
 * when it loads its configuration, so until the proxy reloads it keeps serving
 * the old one -- right up to its expiry, on a server whose files all look
 * fine. The gap between the two is a reload that did not happen.
 */
const certificateServed: Check = {
  id: 'certificate-served',
  title: 'Served certificate is current',
  severity: 'recommended',
  requires: ['certificate-present'],
  async run(context) {
    if (context.domain === undefined) {
      return { status: 'skip', detail: 'no domain given' };
    }

    const path = livePath(context, 'fullchain.pem');
    if (!contextFs(context).exists(path)) {
      return { status: 'skip', detail: 'no certificate on disk yet' };
    }

    let onDisk: Date;
    try {
      const result = await context.runCommand(
        ['openssl', 'x509', '-enddate', '-noout', '-in', path],
        { cwd: process.cwd(), timeoutMs: 15_000 },
      );
      const raw = /notAfter=(.+)/.exec(result.stdout)?.[1]?.trim();
      onDisk = new Date(raw ?? '');
      if (Number.isNaN(onDisk.getTime())) {
        return { status: 'skip', detail: 'could not read the on-disk expiry' };
      }
    } catch {
      return { status: 'skip', detail: 'openssl is not available to read the on-disk expiry' };
    }

    let served: Date;
    try {
      served = (await contextServedCertificate(context)(context.domain)).notAfter;
    } catch (error) {
      // Not this check's question: whether the site is reachable at all is
      // what the DNS and port checks answer.
      return {
        status: 'skip',
        detail: `could not read the served certificate: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const gap = onDisk.getTime() - served.getTime();
    if (Math.abs(gap) <= SAME_CERTIFICATE_TOLERANCE_MS) {
      return { status: 'pass', detail: `serving the on-disk certificate (expires ${onDisk.toISOString()})` };
    }

    const runtime = context.proxyRuntime;
    const reload =
      runtime?.mode === 'container'
        ? `docker exec ${runtime.container} nginx -t && docker exec ${runtime.container} nginx -s reload`
        : 'nginx -t && nginx -s reload';

    if (gap > 0) {
      return {
        status: 'warn',
        detail: `the proxy serves a certificate expiring ${served.toISOString()}, but the one on disk expires ${onDisk.toISOString()}`,
        remedy: `A renewal was not followed by a reload. Reload the proxy: ${reload}`,
      };
    }

    return {
      status: 'warn',
      detail: `the served certificate expires ${served.toISOString()}, AFTER the one on disk (${onDisk.toISOString()})`,
      remedy: `Something other than this proxy may be answering for ${context.domain} (a CDN, or DNS pointing elsewhere). Check where it resolves.`,
    };
  },
};

export const TLS_CHECKS: readonly Check[] = [
  certificatePresent,
  certificateValidity,
  certificateRenewal,
  certificateRenewalPaths,
  certificateServed,
];
