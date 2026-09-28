import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';
import {
  CLI_RENEWAL_CRON_PATH,
  TLS_CHECKS,
  cronCommandPaths,
  cronLines,
  detectRenewalOwner,
  renewsWithCertbot,
  type RenewalProbe,
} from './tls.js';
import type { Check, CheckContext, CheckFs } from './types.js';

// =============================================================================
// detectRenewalOwner reads root's crontab, /etc/crontab, /etc/cron.d/*, a
// systemd timer and appctl's own cron file. Everything is injected: a fake
// CheckFs and a fake runCommand, never a real filesystem or a real crontab.
// =============================================================================

type Canned = { exitCode: number; stdout?: string; stderr?: string };
type Responder = (argv: readonly string[], options: RunCommandOptions) => Canned | undefined;

function fakeRunCommand(respond: Responder): typeof import('../executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv, options) ?? { exitCode: 127, stderr: `${argv[0]}: command not found` };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) {
      throw new CommandFailedError(result.stderr || 'failed', result);
    }
    return result;
  }) as typeof import('../executor.js').runCommand;
}

const NOTHING_RUNS = fakeRunCommand(() => undefined);

interface FakeFsSpec {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
}

/** A CheckFs backed by plain objects: only the paths named exist. */
function makeFs(spec: FakeFsSpec): CheckFs {
  const files = spec.files ?? {};
  const dirs = spec.dirs ?? {};
  return {
    exists: (path) => path in files || path in dirs,
    isDirectory: (path) => path in dirs,
    isWritable: () => true,
    readFile: (path) => files[path],
    readdir: (path) => dirs[path] ?? [],
  };
}

const NO_FS = makeFs({});

describe('cronLines', () => {
  it('drops comments, blank lines, and VAR=value assignments', () => {
    const contents = [
      '# a comment',
      '',
      'MAILTO=root',
      'PATH=/usr/bin:/bin',
      '17 3 * * * certbot renew --quiet',
      '   ',
    ].join('\n');

    expect(cronLines(contents)).toEqual(['17 3 * * * certbot renew --quiet']);
  });

  it('trims surrounding whitespace on the lines it keeps', () => {
    expect(cronLines('   0 4 * * * certbot renew   ')).toEqual(['0 4 * * * certbot renew']);
  });
});

describe('cronCommandPaths', () => {
  it('finds an absolute script path in a plain cron command', () => {
    expect(cronCommandPaths('17 3 * * * /opt/scripts/renew-all.sh')).toEqual([
      '/opt/scripts/renew-all.sh',
    ]);
  });

  it('skips redirection targets, which can mention certbot without being the thing that runs it', () => {
    expect(
      cronCommandPaths('17 3 * * * /opt/scripts/renew-all.sh >> /var/log/certbot-renew.log 2>&1'),
    ).toEqual(['/opt/scripts/renew-all.sh']);
  });

  it('skips an interpreter binary and finds the script path after it', () => {
    expect(cronCommandPaths('17 3 * * * /bin/bash /opt/scripts/renew.sh')).toEqual([
      '/opt/scripts/renew.sh',
    ]);
  });

  it('skips known non-script binaries wherever they appear, but keeps other absolute arguments (a lock file, say) as candidates', () => {
    // It is `classifyCron`'s fs.exists + renewsWithCertbot filter, not this
    // function, that later decides which candidate is the real script.
    expect(cronCommandPaths('17 3 * * * /usr/bin/flock -n /tmp/renew.lock /opt/scripts/renew.sh')).toEqual([
      '/tmp/renew.lock',
      '/opt/scripts/renew.sh',
    ]);
  });

  it('returns nothing for a line with no absolute path at all', () => {
    expect(cronCommandPaths('17 3 * * * certbot renew --quiet')).toEqual([]);
  });

  it('strips surrounding quotes and trailing punctuation', () => {
    expect(cronCommandPaths('17 3 * * * "/opt/scripts/renew.sh";')).toEqual([
      '/opt/scripts/renew.sh',
    ]);
  });
});

describe('renewsWithCertbot', () => {
  it('is true when the contents mention certbot and renew', () => {
    expect(renewsWithCertbot('#!/bin/bash\ncertbot renew --quiet\nsystemctl reload nginx\n')).toBe(true);
  });

  it('is false when only one of the two words is present', () => {
    expect(renewsWithCertbot('#!/bin/bash\ncertbot certificates\n')).toBe(false);
    expect(renewsWithCertbot('#!/bin/bash\nrenew the lease\n')).toBe(false);
  });

  it('is false for undefined contents (unreadable file)', () => {
    expect(renewsWithCertbot(undefined)).toBe(false);
  });

  it('is case-insensitive and does not require a word boundary on "certbot"', () => {
    expect(renewsWithCertbot('CERTBOT RENEW')).toBe(true);
  });
});

describe('CLI_RENEWAL_CRON_PATH', () => {
  it('is namespaced under the CLI name', () => {
    expect(CLI_RENEWAL_CRON_PATH).toBe('/etc/cron.d/appctl-certbot-renew');
  });
});

describe('detectRenewalOwner', () => {
  it('reports "none" on a clean box with nothing scheduled', async () => {
    const result = await detectRenewalOwner({ fs: NO_FS, runCommand: NOTHING_RUNS });

    expect(result.owner).toBe('none');
    expect(result.mechanisms).toEqual([]);
    expect(result.unscheduledScripts).toEqual([]);
    expect(result.detail).toContain('no renewal timer, cron entry or scheduled renewal script');
  });

  it('finds a CENTRAL SCRIPT scheduled from root\'s crontab', async () => {
    const fs = makeFs({
      files: {
        '/opt/scripts/renew-all.sh': '#!/bin/bash\ncertbot renew --quiet\n',
      },
    });
    const run = fakeRunCommand((argv) =>
      argv.join(' ') === 'crontab -l -u root'
        ? { exitCode: 0, stdout: '17 3 * * * /opt/scripts/renew-all.sh >> /var/log/renew.log 2>&1\n' }
        : undefined,
    );

    const result = await detectRenewalOwner({ fs, runCommand: run });

    expect(result.owner).toBe('central-script');
    expect(result.path).toBe('/opt/scripts/renew-all.sh');
    expect(result.detail).toContain("root's crontab");
  });

  it('finds a CENTRAL SCRIPT scheduled from /etc/crontab', async () => {
    const fs = makeFs({
      files: {
        '/etc/crontab': '17 3 * * * root /opt/scripts/renew-all.sh\n',
        '/opt/scripts/renew-all.sh': 'certbot renew\n',
      },
    });

    const result = await detectRenewalOwner({ fs, runCommand: NOTHING_RUNS });

    expect(result.owner).toBe('central-script');
    expect(result.detail).toContain('/etc/crontab');
  });

  it('finds a CENTRAL SCRIPT scheduled from /etc/cron.d/*', async () => {
    const fs = makeFs({
      dirs: { '/etc/cron.d': ['renew-certs'] },
      files: {
        '/etc/cron.d/renew-certs': '17 3 * * * root /opt/scripts/renew-all.sh\n',
        '/opt/scripts/renew-all.sh': 'certbot renew\n',
      },
    });

    const result = await detectRenewalOwner({ fs, runCommand: NOTHING_RUNS });

    expect(result.owner).toBe('central-script');
    expect(result.detail).toContain('/etc/cron.d/renew-certs');
  });

  it('never mistakes appctl\'s own cron file or the certbot package cron file for a discovered /etc/cron.d entry', async () => {
    // Both are read explicitly (their own branches), and must not also be
    // iterated as arbitrary /etc/cron.d/* entries -- that would double-count.
    const fs = makeFs({
      dirs: { '/etc/cron.d': ['certbot', 'appctl-certbot-renew'] },
      files: {
        '/etc/cron.d/certbot': '0 */12 * * * root certbot renew --quiet\n',
        [CLI_RENEWAL_CRON_PATH]: '17 3 * * * root certbot renew --quiet\n',
      },
    });

    const result = await detectRenewalOwner({ fs, runCommand: NOTHING_RUNS });

    // certbot's package cron and appctl's own file are each counted exactly
    // once (by their dedicated branches), not a second time as a loose
    // /etc/cron.d/* entry.
    const certbotCount = result.mechanisms.filter((m) => m.path === '/etc/cron.d/certbot').length;
    const appctlCount = result.mechanisms.filter((m) => m.path === CLI_RENEWAL_CRON_PATH).length;
    expect(certbotCount).toBe(1);
    expect(appctlCount).toBe(1);
  });

  it('finds a SYSTEMD TIMER', async () => {
    const run = fakeRunCommand((argv) =>
      argv.join(' ') === 'systemctl is-enabled certbot.timer' ? { exitCode: 0, stdout: 'enabled' } : undefined,
    );

    const result = await detectRenewalOwner({ fs: NO_FS, runCommand: run });

    expect(result.owner).toBe('systemd-timer');
    expect(result.detail).toContain('certbot.timer is enabled');
  });

  it('finds a plain CRON entry invoking certbot directly', async () => {
    const run = fakeRunCommand((argv) =>
      argv.join(' ') === 'crontab -l -u root'
        ? { exitCode: 0, stdout: '0 4 * * * certbot renew --quiet\n' }
        : undefined,
    );

    const result = await detectRenewalOwner({ fs: NO_FS, runCommand: run });

    expect(result.owner).toBe('cron');
    expect(result.detail).toContain('certbot renew');
  });

  it('finds APPCTL\'s own schedule when nothing else owns it', async () => {
    const fs = makeFs({ files: { [CLI_RENEWAL_CRON_PATH]: '' } });

    const result = await detectRenewalOwner({ fs, runCommand: NOTHING_RUNS });

    expect(result.owner).toBe('appctl');
    expect(result.path).toBe(CLI_RENEWAL_CRON_PATH);
  });

  it('PRECEDENCE: a central script wins over a systemd timer, cron and appctl all present at once', async () => {
    const fs = makeFs({
      files: {
        '/opt/scripts/renew-all.sh': 'certbot renew\n',
        [CLI_RENEWAL_CRON_PATH]: '',
        '/etc/cron.d/certbot': '0 */12 * * * root certbot renew --quiet\n',
      },
      dirs: { '/etc/cron.d': ['certbot'] },
    });
    const run = fakeRunCommand((argv) => {
      const line = argv.join(' ');
      if (line === 'crontab -l -u root') return { exitCode: 0, stdout: '17 3 * * * /opt/scripts/renew-all.sh\n' };
      if (line === 'systemctl is-enabled certbot.timer') return { exitCode: 0, stdout: 'enabled' };
      return undefined;
    });

    const result = await detectRenewalOwner({ fs, runCommand: run });

    expect(result.owner).toBe('central-script');
    // Every mechanism found is still reported, in precedence order.
    expect(result.mechanisms.map((m) => m.owner)).toEqual([
      'central-script',
      'systemd-timer',
      'cron',
      'appctl',
    ]);
  });

  it('PRECEDENCE: a systemd timer wins over cron and appctl', async () => {
    const fs = makeFs({ files: { [CLI_RENEWAL_CRON_PATH]: '' } });
    const run = fakeRunCommand((argv) => {
      const line = argv.join(' ');
      if (line === 'crontab -l -u root') return { exitCode: 0, stdout: '0 4 * * * certbot renew\n' };
      if (line === 'systemctl is-enabled certbot.timer') return { exitCode: 0, stdout: 'enabled' };
      return undefined;
    });

    const result = await detectRenewalOwner({ fs, runCommand: run });

    expect(result.owner).toBe('systemd-timer');
  });

  it('reports UNSCHEDULED SCRIPTS under the proxy root that renew with certbot but nothing schedules', async () => {
    const fs = makeFs({
      dirs: { '/opt/infra/proxy': ['renew.sh', 'README.md'] },
      files: {
        '/opt/infra/proxy/renew.sh': 'certbot renew --quiet\n',
        '/opt/infra/proxy/README.md': 'certbot renew is mentioned here but this is not a script that runs it\n',
      },
    });

    const result = await detectRenewalOwner({
      fs,
      runCommand: NOTHING_RUNS,
      proxyRoot: '/opt/infra/proxy',
    });

    expect(result.owner).toBe('none');
    expect(result.unscheduledScripts).toEqual(['/opt/infra/proxy/renew.sh']);
    expect(result.detail).toContain('/opt/infra/proxy/renew.sh');
    expect(result.detail).toContain('nothing schedules it');
  });

  it('does not report a script as unscheduled once something schedules it', async () => {
    const fs = makeFs({
      dirs: { '/opt/infra/proxy': ['renew.sh'] },
      files: { '/opt/infra/proxy/renew.sh': 'certbot renew --quiet\n' },
    });
    const run = fakeRunCommand((argv) =>
      argv.join(' ') === 'crontab -l -u root'
        ? { exitCode: 0, stdout: '17 3 * * * /opt/infra/proxy/renew.sh\n' }
        : undefined,
    );

    const result = await detectRenewalOwner({ fs, runCommand: run, proxyRoot: '/opt/infra/proxy' });

    expect(result.owner).toBe('central-script');
    expect(result.unscheduledScripts).toEqual([]);
  });

  describe('container-mode rules', () => {
    const HOST_PROBE = (extra: Partial<RenewalProbe>): RenewalProbe => ({
      fs: NO_FS,
      runCommand: NOTHING_RUNS,
      ...extra,
    });

    it('a host systemd timer does NOT own renewal in container mode', async () => {
      const run = fakeRunCommand((argv) =>
        argv.join(' ') === 'systemctl is-enabled certbot.timer' ? { exitCode: 0, stdout: 'enabled' } : undefined,
      );

      const result = await detectRenewalOwner(HOST_PROBE({ runCommand: run, mode: 'container' }));

      expect(result.owner).toBe('none');
      const timer = result.mechanisms.find((m) => m.owner === 'systemd-timer');
      expect(timer?.owns).toBe(false);
      expect(timer?.detail).toContain('renews the host /etc/letsencrypt');
    });

    it('the same timer DOES own renewal outside container mode', async () => {
      const run = fakeRunCommand((argv) =>
        argv.join(' ') === 'systemctl is-enabled certbot.timer' ? { exitCode: 0, stdout: 'enabled' } : undefined,
      );

      const result = await detectRenewalOwner(HOST_PROBE({ runCommand: run }));

      expect(result.owner).toBe('systemd-timer');
    });

    it('a bare host cron line invoking certbot does NOT own renewal in container mode', async () => {
      const run = fakeRunCommand((argv) =>
        argv.join(' ') === 'crontab -l -u root' ? { exitCode: 0, stdout: '0 4 * * * certbot renew\n' } : undefined,
      );

      const result = await detectRenewalOwner(HOST_PROBE({ runCommand: run, mode: 'container' }));

      expect(result.owner).toBe('none');
      const cron = result.mechanisms.find((m) => m.owner === 'cron');
      expect(cron?.owns).toBe(false);
    });

    it('a cron line naming THIS proxy root DOES own renewal in container mode', async () => {
      const run = fakeRunCommand((argv) =>
        argv.join(' ') === 'crontab -l -u root'
          ? { exitCode: 0, stdout: '0 4 * * * certbot renew --config-dir /opt/infra/proxy/letsencrypt\n' }
          : undefined,
      );

      const result = await detectRenewalOwner(
        HOST_PROBE({ runCommand: run, mode: 'container', proxyRoot: '/opt/infra/proxy' }),
      );

      expect(result.owner).toBe('cron');
      expect(result.mechanisms[0]?.owns).toBe(true);
    });

    it('a cron line running the dockerised certbot/certbot image DOES own renewal in container mode', async () => {
      const run = fakeRunCommand((argv) =>
        argv.join(' ') === 'crontab -l -u root'
          ? { exitCode: 0, stdout: '0 4 * * * docker run --rm certbot/certbot renew\n' }
          : undefined,
      );

      const result = await detectRenewalOwner(HOST_PROBE({ runCommand: run, mode: 'container' }));

      expect(result.owner).toBe('cron');
    });

    it('/etc/cron.d/certbot owns in container mode only when it names the proxy root or the dockerised image', async () => {
      const fsUnrelated = makeFs({ files: { '/etc/cron.d/certbot': '0 */12 * * * root certbot renew --quiet\n' } });
      const unrelated = await detectRenewalOwner(
        HOST_PROBE({ fs: fsUnrelated, mode: 'container', proxyRoot: '/opt/infra/proxy' }),
      );
      expect(unrelated.owner).toBe('none');
      expect(unrelated.mechanisms.find((m) => m.path === '/etc/cron.d/certbot')?.owns).toBe(false);

      const fsRelated = makeFs({
        files: { '/etc/cron.d/certbot': '0 */12 * * * root certbot renew --config-dir /opt/infra/proxy/letsencrypt --quiet\n' },
      });
      const related = await detectRenewalOwner(
        HOST_PROBE({ fs: fsRelated, mode: 'container', proxyRoot: '/opt/infra/proxy' }),
      );
      expect(related.owner).toBe('cron');
    });

    it('outside container mode, /etc/cron.d/certbot owning is unconditional (the historical rule)', async () => {
      const fs = makeFs({ files: { '/etc/cron.d/certbot': '0 */12 * * * root certbot renew --quiet\n' } });

      const result = await detectRenewalOwner(HOST_PROBE({ fs }));

      expect(result.owner).toBe('cron');
    });

    it('a central script found via a container-mode host cron line is unaffected by the host-certbot rule (it is a different owner kind)', async () => {
      const fs = makeFs({ files: { '/opt/scripts/renew-all.sh': 'certbot renew\n' } });
      const run = fakeRunCommand((argv) =>
        argv.join(' ') === 'crontab -l -u root'
          ? { exitCode: 0, stdout: '17 3 * * * /opt/scripts/renew-all.sh\n' }
          : undefined,
      );

      const result = await detectRenewalOwner(HOST_PROBE({ fs, runCommand: run, mode: 'container' }));

      // A central script always owns, regardless of container mode: it is
      // classified before the host-certbot-ownership question is even asked.
      expect(result.owner).toBe('central-script');
    });
  });
});

// =============================================================================
// The `certificate-renewal` check, rebuilt on detectRenewalOwner.
// =============================================================================

function find(id: string): Check {
  const check = TLS_CHECKS.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    runCommand: NOTHING_RUNS,
    deployRoot: '/opt/infra/apps/demo',
    bindPort: 3535,
    proxyRoot: '/opt/infra/proxy',
    fs: NO_FS,
    ...overrides,
  };
}

describe('certificate-renewal check', () => {
  it('PASSES and names the mechanism when something owns renewal', async () => {
    const run = fakeRunCommand((argv) =>
      argv.join(' ') === 'crontab -l -u root' ? { exitCode: 0, stdout: '0 4 * * * certbot renew\n' } : undefined,
    );

    const result = await find('certificate-renewal').run(context({ runCommand: run }));

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('owned by cron');
  });

  it('WARNS when nothing owns renewal', async () => {
    const result = await find('certificate-renewal').run(context());

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('90 days');
  });

  it('WARNS with a DOUBLE-SCHEDULE remedy when appctl\'s own cron coexists with another real owner', async () => {
    const fs = makeFs({ files: { [CLI_RENEWAL_CRON_PATH]: '' } });
    const run = fakeRunCommand((argv) =>
      argv.join(' ') === 'crontab -l -u root' ? { exitCode: 0, stdout: '0 4 * * * certbot renew\n' } : undefined,
    );

    const result = await find('certificate-renewal').run(context({ fs, runCommand: run }));

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('owned by cron');
    expect(result.remedy).toContain('scheduled twice');
    expect(result.remedy).toContain(`rm ${CLI_RENEWAL_CRON_PATH}`);
  });

  it('does not warn about a double schedule when appctl IS the (only) owner', async () => {
    const fs = makeFs({ files: { [CLI_RENEWAL_CRON_PATH]: '' } });

    const result = await find('certificate-renewal').run(context({ fs }));

    expect(result.status).toBe('pass');
    expect(result.remedy).toBeUndefined();
  });
});
