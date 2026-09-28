import { basename } from 'node:path';

import { PROXY_COMPOSE_FILES } from '../proxy-bootstrap.js';
import type { Check, CheckContext, CheckResult, Severity } from './types.js';
import {
  contextFs,
  contextMemory,
  contextPortFree,
  contextPortListening,
} from './types.js';

// =============================================================================
// Is this server able to run the application?  (issue #176, epic #168)
// =============================================================================
//
// Everything here is READ-ONLY, and everything probes for a CAPABILITY rather
// than for how it was installed. `docker info` succeeding is the fact that
// matters; whether docker came from apt, from get.docker.com or from a
// snap is not. Checking for `systemctl` or for a package name would make these
// checks Ubuntu-specific for no gain - the target is Ubuntu, but nothing here
// needs it to be.
// =============================================================================

/** Below this, an image build is the thing that will fail, confusingly. */
const MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024;

/** Below this, the web build gets OOM-killed on a small VPS. */
const MIN_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

/** apps/cli's own floor. The build runs on this host. */
const MIN_NODE_MAJOR = 20;

/** Keeps a one-line detail scannable; the journal keeps the whole thing. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}...`;
}

function formatBytes(bytes: number): string {
  const gigabytes = bytes / (1024 * 1024 * 1024);
  return `${gigabytes.toFixed(1)} GB`;
}

/**
 * Runs a command purely to see whether it works. Never throws.
 *
 * `env`, when given, REPLACES the child's environment (the executor's
 * contract), so callers extend `process.env` rather than pass a fragment.
 */
export async function probe(
  context: Pick<CheckContext, 'runCommand'>,
  argv: readonly string[],
  options: { env?: NodeJS.ProcessEnv | undefined; timeoutMs?: number | undefined } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await context.runCommand(argv, {
      cwd: process.cwd(),
      timeoutMs: options.timeoutMs ?? 20_000,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as { result?: { stdout?: string; stderr?: string } };
    return {
      ok: false,
      stdout: (failure.result?.stdout ?? '').trim(),
      stderr:
        (failure.result?.stderr ?? '').trim() ||
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

const dockerInstalled: Check = {
  id: 'docker-installed',
  title: 'Docker installed',
  severity: 'required',
  async run(context) {
    const { ok, stdout, stderr } = await probe(context, ['docker', '--version']);
    if (!ok) {
      return {
        status: 'fail',
        detail: stderr.split('\n')[0] ?? 'not installed',
        remedy: 'Install Docker Engine: curl -fsSL https://get.docker.com | sh',
      };
    }
    return { status: 'pass', detail: stdout.replace(/^Docker version /, '') };
  },
};

const dockerDaemon: Check = {
  id: 'docker-daemon',
  title: 'Docker daemon reachable',
  severity: 'required',
  requires: ['docker-installed'],
  async run(context) {
    const { ok, stderr } = await probe(context, ['docker', 'info', '--format', '{{.ServerVersion}}']);
    if (ok) return { status: 'pass', detail: 'reachable' };

    // Installed-but-unreachable is the common case, and it splits three ways
    // with three different remedies. Collapsing them into "cannot connect"
    // throws away the only useful information the error carried.
    if (/permission denied/i.test(stderr)) {
      return {
        status: 'fail',
        detail: 'permission denied on the Docker socket',
        remedy: `Run as root, or add this user to the docker group: usermod -aG docker $USER (then log in again)`,
      };
    }
    // Docker has worded this several ways across versions ("Cannot connect to
    // the Docker daemon", "failed to connect to the docker API"); match the
    // socket instead, which every wording mentions and which is the actual
    // symptom.
    if (
      /cannot connect|failed to connect|is the docker daemon running|docker\.sock/i.test(
        stderr,
      )
    ) {
      return {
        status: 'fail',
        detail: 'daemon is not running or the socket is unreachable',
        remedy: 'Start it: systemctl start docker (or start Docker Desktop)',
      };
    }
    return {
      status: 'fail',
      // Truncated: some of these run to several hundred characters and the
      // checklist is meant to be scannable. The full text is in the journal.
      detail: truncate(stderr.split('\n')[0] ?? 'unreachable', 90),
      remedy: 'Check the daemon with: docker info',
    };
  },
};

const dockerComposeV2: Check = {
  id: 'docker-compose-v2',
  title: 'Compose v2 plugin',
  severity: 'required',
  requires: ['docker-installed'],
  async run(context) {
    const { ok, stdout } = await probe(context, ['docker', 'compose', 'version']);
    if (ok) {
      return { status: 'pass', detail: stdout.split('\n')[0] ?? 'available' };
    }

    // The legacy standalone binary is NOT a substitute: this deployment uses
    // `!override` and the long-form env_file, neither of which v1 understands.
    const legacy = await probe(context, ['docker-compose', '--version']);
    if (legacy.ok) {
      return {
        status: 'fail',
        detail: 'only the legacy docker-compose v1 binary is present',
        remedy: 'Install the v2 plugin: apt-get install docker-compose-plugin',
      };
    }

    return {
      status: 'fail',
      detail: 'not installed',
      remedy: 'Install the v2 plugin: apt-get install docker-compose-plugin',
    };
  },
};

const gitInstalled: Check = {
  id: 'git-installed',
  title: 'git installed',
  severity: 'required',
  async run(context) {
    const { ok, stdout, stderr } = await probe(context, ['git', '--version']);
    return ok
      ? { status: 'pass', detail: stdout.replace(/^git version /, '') }
      : {
          status: 'fail',
          detail: stderr.split('\n')[0] ?? 'not installed',
          remedy: 'Install git: apt-get install git',
        };
  },
};

const nodeVersion: Check = {
  id: 'node-version',
  title: 'Node version',
  severity: 'recommended',
  async run() {
    const major = Number(process.versions.node.split('.')[0]);
    return major >= MIN_NODE_MAJOR
      ? { status: 'pass', detail: `v${process.versions.node}` }
      : {
          status: 'warn',
          detail: `v${process.versions.node}`,
          remedy: `appctl targets Node ${MIN_NODE_MAJOR} or newer; upgrade before relying on this host to build.`,
        };
  },
};

const diskSpace: Check = {
  id: 'disk-space',
  title: 'Free disk space',
  severity: 'required',
  async run(context) {
    // -P for POSIX output (one line per filesystem, no wrapping) and -k so the
    // unit is known rather than inferred from a human-readable suffix.
    const { ok, stdout, stderr } = await probe(context, ['df', '-Pk', context.deployRoot]);

    if (!ok) {
      // The directory may not exist yet on a first install; ask about its parent.
      const parent = await probe(context, ['df', '-Pk', '/']);
      if (!parent.ok) {
        return {
          status: 'fail',
          detail: stderr.split('\n')[0] ?? 'could not determine free space',
          remedy: 'Check free space by hand: df -h',
        };
      }
      return evaluateDf(parent.stdout);
    }

    return evaluateDf(stdout);
  },
};

/** Reads `df -Pk` output. Exported for its test. */
export function evaluateDf(output: string): CheckResult {
  const line = output.trim().split('\n')[1];
  const available = Number(line?.trim().split(/\s+/)[3]);

  if (!Number.isFinite(available)) {
    return {
      status: 'fail',
      detail: 'could not parse df output',
      remedy: 'Check free space by hand: df -h',
    };
  }

  const bytes = available * 1024;
  return bytes >= MIN_FREE_DISK_BYTES
    ? { status: 'pass', detail: `${formatBytes(bytes)} free` }
    : {
        status: 'fail',
        detail: `${formatBytes(bytes)} free`,
        remedy: `Image builds need roughly ${formatBytes(MIN_FREE_DISK_BYTES)}. Free space, or use a larger volume. \`docker system prune\` often recovers a lot.`,
      };
}

const memory: Check = {
  id: 'memory',
  title: 'Memory',
  severity: 'recommended',
  async run(context) {
    const bytes = contextMemory(context);
    return bytes >= MIN_MEMORY_BYTES
      ? { status: 'pass', detail: formatBytes(bytes) }
      : {
          status: 'warn',
          detail: formatBytes(bytes),
          remedy: `The web build can be OOM-killed under ${formatBytes(MIN_MEMORY_BYTES)}. Add swap, or build the images elsewhere.`,
        };
  },
};

const bindPortFree: Check = {
  id: 'bind-port-free',
  title: 'Loopback port available',
  severity: 'required',
  async run(context) {
    const free = await contextPortFree(context)(context.bindPort);
    if (free) {
      return { status: 'pass', detail: `127.0.0.1:${context.bindPort} is free` };
    }

    // An UPDATE finds its own nginx on this port, which is not a conflict. A
    // doctor run that reports a false failure against a healthy deployment is
    // how operators learn to ignore doctor.
    const owner = await probe(context, [
      'docker',
      'ps',
      '--filter',
      `publish=${context.bindPort}`,
      '--format',
      '{{.Names}}',
    ]);
    const project = basename(context.deployRoot);
    const names = owner.stdout.split('\n').filter((name) => name !== '');

    if (names.some((name) => name.includes(project))) {
      return {
        status: 'pass',
        detail: `held by this deployment (${names.join(', ')})`,
      };
    }

    return {
      status: 'fail',
      detail:
        names.length > 0
          ? `in use by ${names.join(', ')}`
          : `something is already listening on 127.0.0.1:${context.bindPort}`,
      remedy: `Choose another port with APP_BIND_PORT, or stop whatever holds it.`,
    };
  },
};

/** True when the context says the proxy runs in a container. */
function containerMode(context: CheckContext): boolean {
  return context.proxyRuntime?.mode === 'container';
}

/**
 * The proxy prerequisites are required unless this run was told not to touch
 * the proxy. Under --skip-proxy install does not even create the proxy root
 * (`bootstrapProxyRoot` is skipped), so requiring it would refuse an install
 * over infrastructure that install has been told it will not use.
 */
const proxyRequiredUnlessSkipped = (context: CheckContext): Severity =>
  context.skipProxy === true ? 'recommended' : 'required';

const proxyRoot: Check = {
  id: 'proxy-root',
  severityFor: proxyRequiredUnlessSkipped,
  title: 'Shared proxy directory',
  severity: 'required',
  async run(context) {
    const fs = contextFs(context);
    return fs.isDirectory(context.proxyRoot)
      ? { status: 'pass', detail: context.proxyRoot }
      : {
          status: 'fail',
          detail: `${context.proxyRoot} does not exist`,
          remedy: `Set up the shared reverse proxy first, or point at it with --proxy-root.`,
        };
  },
};

const proxyConfWritable: Check = {
  id: 'proxy-conf-writable',
  severityFor: proxyRequiredUnlessSkipped,
  title: 'Proxy conf.d writable',
  severity: 'required',
  requires: ['proxy-root'],
  async run(context) {
    const fs = contextFs(context);
    const confd = `${context.proxyRoot}/nginx/conf.d`;

    if (!fs.isDirectory(confd)) {
      return {
        status: 'fail',
        detail: `${confd} does not exist`,
        remedy: `Create it, or point --proxy-root at the proxy that owns the vhosts.`,
      };
    }
    return fs.isWritable(confd)
      ? { status: 'pass', detail: confd }
      : {
          status: 'fail',
          detail: `${confd} is not writable`,
          remedy: 'Run the deployment as a user that can write the vhost, or fix its permissions.',
        };
  },
};

const acmeWebroot: Check = {
  id: 'acme-webroot',
  severityFor: proxyRequiredUnlessSkipped,
  title: 'ACME challenge webroot',
  severity: 'required',
  requires: ['proxy-root'],
  async run(context) {
    const fs = contextFs(context);
    const webroot = `${context.proxyRoot}/webroot`;

    if (!fs.isDirectory(webroot)) {
      return {
        status: 'fail',
        detail: `${webroot} does not exist`,
        remedy: `Certificates are issued with certbot's webroot method; create ${webroot} and serve it from the proxy's default server.`,
      };
    }
    return fs.isWritable(webroot)
      ? { status: 'pass', detail: webroot }
      : {
          status: 'fail',
          detail: `${webroot} is not writable`,
          remedy: 'certbot writes the challenge file here; fix its permissions.',
        };
  },
};


const certbotInstalled: Check = {
  id: 'certbot-installed',
  title: 'certbot available',
  // Static `required` is the HOST-mode answer, and the answer when the runtime
  // is unknown. In container mode certificates are issued by the dockerised
  // certbot, so a missing host binary is not a problem at all -- failing
  // doctor over it fails a correctly configured server.
  severity: 'required',
  severityFor: (context) =>
    containerMode(context) || context.skipProxy === true ? 'recommended' : 'required',
  async run(context) {
    const host = await probe(context, ['certbot', '--version']);

    if (containerMode(context)) {
      return host.ok
        ? {
            status: 'pass',
            detail: `${(host.stdout || host.stderr).split('\n')[0] ?? 'installed'} (unused: the proxy is containerised, so certbot/certbot is used)`,
          }
        : {
            status: 'skip',
            detail: 'not needed: the proxy is containerised, so certificates are issued with certbot/certbot',
          };
    }

    if (host.ok) {
      // certbot prints its version on stderr in some builds.
      return { status: 'pass', detail: (host.stdout || host.stderr).split('\n')[0] ?? 'installed' };
    }
    return {
      status: 'fail',
      detail: 'not installed',
      remedy:
        'Install certbot: apt-get install certbot -- or, if the proxy runs in a container, say so with --proxy-mode container.',
    };
  },
};

/**
 * The shared proxy is actually RUNNING, not merely configured.
 *
 * `proxy-root` proves the directory exists and `proxy-conf-writable` that a
 * vhost can be written; neither proves anything is serving from them. A
 * stopped proxy cannot answer the HTTP-01 challenge, and certificate issuance
 * then fails with an error that never mentions the proxy.
 *
 * Required in container mode only: in host mode the proxy is not a container
 * this can inspect, and the port-80/443 checks already cover whether something
 * serves. Read-only -- `docker inspect` starts nothing.
 */
const proxyContainer: Check = {
  id: 'proxy-container',
  title: 'Proxy container running',
  severity: 'recommended',
  // Required only when THIS run publishes through the proxy: container mode,
  // a domain to publish, and no --skip-proxy. Doctor without --domain, or a
  // --skip-proxy install, gets advice rather than a refusal.
  severityFor: (context) =>
    containerMode(context) && context.domain !== undefined && context.skipProxy !== true
      ? 'required'
      : 'recommended',
  requires: ['docker-daemon'],
  async run(context) {
    if (context.skipProxy === true) {
      return { status: 'skip', detail: 'not publishing through the proxy (--skip-proxy)' };
    }
    const runtime = context.proxyRuntime;
    if (runtime?.mode !== 'container') {
      return {
        status: 'skip',
        detail:
          runtime === undefined
            ? 'proxy runtime unknown'
            : 'the proxy runs on the host, not in a container',
      };
    }

    const start = `cd ${context.proxyRoot} && docker compose up -d`;
    const inspect = await probe(context, [
      'docker', 'inspect', '--type', 'container', '--format', '{{.State.Running}}', runtime.container,
    ]);

    if (inspect.ok) {
      const running = inspect.stdout.trim().split('\n')[0]?.trim();
      if (running === 'true') {
        return { status: 'pass', detail: `${runtime.container} is running` };
      }
      return {
        status: 'fail',
        detail: `${runtime.container} exists but is not running`,
        remedy: `Start it: docker start ${runtime.container} (or: ${start}). Certificates cannot be issued while nothing answers the ACME challenge.`,
      };
    }

    if (/no such (container|object)/i.test(inspect.stderr)) {
      const fs = contextFs(context);
      const composeFile = PROXY_COMPOSE_FILES.map((name) => `${context.proxyRoot}/${name}`).find((path) =>
        fs.exists(path),
      );
      // #391: install may create the proxy -- but only in a root nobody has
      // configured. A compose file there means the proxy is somebody's.
      if (context.proxyBootstrap === true && composeFile === undefined) {
        return {
          status: 'pass',
          detail: `no container named ${runtime.container}; install will bootstrap the shared proxy`,
        };
      }
      return {
        status: 'fail',
        detail: `no container named ${runtime.container}`,
        remedy:
          `Bring the shared proxy up: ${start} -- or, if it runs under another name, pass --proxy-container <name>.` +
          (composeFile === undefined
            ? ` On a box with no proxy at all, install can create one: pass --bootstrap-proxy.`
            : ''),
      };
    }

    return {
      status: 'fail',
      detail: truncate(inspect.stderr.split('\n')[0] ?? `could not inspect ${runtime.container}`, 90),
      remedy: `Check it by hand: docker inspect ${runtime.container}. To start the proxy: ${start}`,
    };
  },
};

const portListening = (port: number, purpose: string): Check => ({
  id: `port-${port}-listening`,
  title: `Port ${port} served`,
  severity: 'recommended',
  async run(context) {
    const listening = await contextPortListening(context)(port);
    return listening
      ? { status: 'pass', detail: `something is serving ${port}` }
      : {
          status: 'warn',
          detail: `nothing is listening on ${port}`,
          remedy: `${purpose} Start the shared proxy before issuing a certificate.`,
        };
  },
});

const proxyConfigValid: Check = {
  id: 'proxy-config-valid',
  title: 'Proxy config currently valid',
  severity: 'recommended',
  requires: ['proxy-root'],
  async run(context) {
    const runtime = context.proxyRuntime;

    if (runtime?.mode === 'container') {
      // Validated where nginx actually runs. A host `nginx -t` would test a
      // binary that is not the proxy, against paths that are not its paths.
      const inContainer = await probe(context, [
        'docker', 'exec', runtime.container, 'nginx', '-t',
      ]);
      if (inContainer.ok) {
        return { status: 'pass', detail: `nginx -t passes in ${runtime.container}` };
      }

      if (/no such container|is not running/i.test(inContainer.stderr)) {
        return {
          status: 'warn',
          detail: `proxy container ${runtime.container} is not running`,
          remedy: `Start the shared proxy (docker start ${runtime.container}, or docker compose up -d in ${context.proxyRoot}), or name the right one with --proxy-container.`,
        };
      }

      return {
        status: 'warn',
        detail:
          inContainer.stderr.split('\n').find((line) => line.includes('nginx:')) ??
          `nginx -t failed in ${runtime.container}`,
        remedy:
          'The shared proxy is already misconfigured. Fix it before deploying, or the reload at the end of the install will fail for every site on this host.',
      };
    }

    const host = await probe(context, ['nginx', '-t']);
    if (host.ok) return { status: 'pass', detail: 'nginx -t passes' };

    // A containerised proxy is the documented setup, so a missing host binary
    // is not itself a problem - it just means this check cannot answer.
    if (/command not found|ENOENT/i.test(host.stderr)) {
      return {
        status: 'skip',
        detail: 'no host nginx binary; the proxy is probably containerised (see --proxy-mode)',
      };
    }

    return {
      status: 'warn',
      detail: (host.stderr.split('\n').find((line) => line.includes('nginx:')) ?? 'nginx -t failed'),
      remedy:
        'The shared proxy is already misconfigured. Fix it before deploying, or the reload at the end of the install will fail for every site on this host.',
    };
  },
};

export const HOST_CHECKS: readonly Check[] = [
  dockerInstalled,
  dockerDaemon,
  dockerComposeV2,
  gitInstalled,
  nodeVersion,
  diskSpace,
  memory,
  bindPortFree,
  proxyRoot,
  proxyConfWritable,
  acmeWebroot,
  proxyContainer,
  certbotInstalled,
  portListening(80, "Let's Encrypt's HTTP-01 challenge needs port 80."),
  portListening(443, 'HTTPS traffic needs port 443.'),
  proxyConfigValid,
];
