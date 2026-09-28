// =============================================================================
// stack-agent entry point  (issue #567)
// =============================================================================
//
// A sidecar that holds the Docker socket so the API never has to. It exposes
// exactly one capability -- (re)deploy the two telemetry services of the
// compose project it belongs to -- plus a read-only status of them. See
// server.ts for the routes and compose.ts for how the project is found.
//
// Configuration is ONE variable, STACK_AGENT_TOKEN. Everything else is read
// off this container's own compose labels.
// =============================================================================

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

import { createDiscovery, DiscoveryError } from './compose.js';
import { spawnRunner } from './runner.js';
import { createAgent, isConfigured, type LogEntry } from './server.js';

const PORT = 8090;
const HOST = '0.0.0.0';

/** One JSON object per line on stdout. Never a header, never the token. */
function log(entry: LogEntry): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

const token = process.env['STACK_AGENT_TOKEN'];
const discover = createDiscovery({
  runner: spawnRunner,
  containerId: process.env['HOSTNAME'],
  fileExists: existsSync,
});

const server = createServer(createAgent({ token, runner: spawnRunner, discover, log }));
// A client that stops mid-request must not hold a socket open for ever; the
// response to `up` may legitimately take minutes, which these do not limit.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;

server.listen(PORT, HOST, () => {
  log({
    level: 'info',
    msg: 'listening',
    port: PORT,
    configured: isConfigured(token),
  });
  if (!isConfigured(token)) {
    log({
      level: 'warn',
      msg: 'STACK_AGENT_TOKEN is unset or shorter than 32 characters; every /v1 call answers 503',
    });
  }
  // Discover once at startup so a misconfiguration shows in the logs at once
  // rather than on the first click in the admin UI. Not fatal: a failure is
  // retried on every call.
  discover().then(
    (target) =>
      log({ level: 'info', msg: 'discovered', project: target.project, files: target.files.length }),
    (error: unknown) =>
      log({
        level: 'error',
        msg: 'discovery failed',
        error: error instanceof DiscoveryError ? error.message : 'unexpected error',
      }),
  );
});

function shutdown(signal: string): void {
  log({ level: 'info', msg: 'shutting down', signal });
  server.close(() => process.exit(0));
  // An in-flight `compose up` is not waited for past Docker's own stop grace.
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
