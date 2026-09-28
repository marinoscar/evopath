import { useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import { DEFAULT_BIND_PORT } from '../../../commands/deploy.js';
import { runCommand, withSignal } from '../../../deploy/executor.js';
import { collectHealth, isHealthy, type HealthReport } from '../../../deploy/health.js';
import { oauthSmokeTarget } from '../../../deploy/install.js';
import { DEFAULT_APPS_ROOT, deployRootFor } from '../../../deploy/layout.js';
import { readState } from '../../../deploy/state.js';
import { UsageError } from '../../../errors.js';
import { FieldWizard, NameStep, optionalHostname } from './fields.js';
import { seedFor, validatePort, type AppName } from './install-model.js';
import type { FieldSpec } from './model.js';
import { RunFrame, useDeployRun } from './run.js';

// =============================================================================
// `deploy status`, as a screen  (issue #406)
// =============================================================================
//
// `collectHealth` verbatim, rendered as a summary instead of written to stderr.
//
// ⚠ "NOTHING IS INSTALLED" IS NOT "INSTALLED AND UNHEALTHY". The subcommand
// separates them by exit code (2 vs 1) and this screen separates them by
// message, for the same reason: they need different actions from the operator,
// and a TUI exit code is 0 either way so the frame is all there is.
// =============================================================================

export interface StatusScreenProps {
  onDone: () => void;
  /** The deployment this host already has, offered as the default name. */
  located: string | undefined;
}

const STATUS_FIELDS: readonly FieldSpec[] = [
  {
    key: '__port',
    label: 'port',
    help: 'Loopback port the proxy forwards to. The readiness and frontend probes go here.',
    placeholder: String(DEFAULT_BIND_PORT),
    secret: false,
    prefilled: false,
    validate: validatePort,
  },
  {
    key: '__domain',
    label: 'domain',
    help: 'Optional. Adds an external HTTPS probe; empty checks the loopback only.',
    placeholder: '',
    secret: false,
    prefilled: false,
    validate: optionalHostname,
  },
];

export function StatusScreen({ onDone, located }: StatusScreenProps): ReactNode {
  const [name, setName] = useState<AppName | undefined>(undefined);
  // Every step before the run is a text field, so Esc is off until the run
  // starts - after which it is the cancel.
  const [started, setStarted] = useState(false);
  const run = useDeployRun({ onEscape: onDone, escapeActive: started });

  if (run.phase.kind !== 'idle') return <RunFrame action="status" run={run} />;

  if (name === undefined) {
    return (
      <NameStep title="Status" located={located} appsRoot={DEFAULT_APPS_ROOT} onSubmit={setName} />
    );
  }

  return (
    <FieldWizard
      title={`Status — ${name.display}`}
      fields={STATUS_FIELDS}
      onComplete={(answers) => {
        // ⚠ `name.resolved`, never `name.display`: this becomes a path.
        const resolved = name.resolved;
        if (resolved === undefined) return;
        setStarted(true);
        run.start(async (signal) => await performStatus(resolved, answers, signal));
      }}
    />
  );
}

/** Collects health. The same call `runStatusCommand` makes. */
async function performStatus(
  resolved: string,
  answers: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<string[]> {
  const deployRoot = deployRootFor(DEFAULT_APPS_ROOT, resolved);
  const domain = answers.get('__domain') ?? '';

  const state = readState(deployRoot);
  if (state === undefined) {
    throw new UsageError(
      `No deployment found at ${deployRoot}. Run \`${CLI_NAME} deploy install\` first, or check the name.`,
    );
  }

  const report: HealthReport = await collectHealth({
    // Under the screen's signal, so Esc reaches the `docker compose ps` calls.
    runCommand: withSignal(runCommand, signal),
    deployRoot,
    bindPort: Number(answers.get('__port') ?? DEFAULT_BIND_PORT),
    ...(domain === '' ? {} : { domain }),
    // Passed, not re-read: `collectHealth` reports what is deployed from it and
    // a second read could disagree with the one the guard above just made.
    state,
    ...oauthSmokeTarget(false, seedFor(DEFAULT_APPS_ROOT, resolved).values),
  });

  return [
    isHealthy(report) ? 'Healthy.' : 'NOT healthy.',
    `Containers: ${report.containers.map((container) => `${container.service}=${container.state}`).join(' ') || 'none'}`,
    `Readiness:  ${report.local.ready.ok ? 'ok' : (report.local.ready.error ?? 'failed')}`,
    `Frontend:   ${report.local.frontend.ok ? 'ok' : (report.local.frontend.error ?? 'failed')}`,
    ...(report.external === undefined
      ? []
      : [
          `External:   ${report.external.url} ${report.external.probe.ok ? 'ok' : (report.external.probe.error ?? 'failed')}`,
        ]),
    // ⚠ Reported separately from readiness, and never folded into it:
    // /api/health/ready issues SELECT 1, which passes against an empty
    // database, so a green probe is not proof that the schema is current.
    `Migrations: ${report.migrations.known ? `${report.migrations.pending.length} pending` : 'unknown'}`,
    // #391: reported, never folded into the verdict above -- see collectHealth.
    ...(report.oauth === undefined
      ? []
      : [
          `Sign-in:    ${report.oauth.status === 'pass' ? 'ok' : `${report.oauth.status === 'fail' ? 'FAILED' : 'unverified'}: ${report.oauth.detail}`}`,
        ]),
  ];
}
