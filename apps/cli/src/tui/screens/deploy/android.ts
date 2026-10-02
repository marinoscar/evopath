import {
  androidReportLines,
  defaultAndroidStepDeps,
  runDeployAndroidStep,
  type AndroidStepDeps,
} from '../../../deploy/android-step.js';
import type { DeployHooks } from '../../../deploy/hooks.js';
import { WITH_ANDROID_FLAG } from './flags-model.js';

// =============================================================================
// The deploy screens' Android app step  (issues #292, #315)
// =============================================================================
//
// The same `runDeployAndroidStep` the `--with-android` flag runs, after the
// pipeline returned, rendered as one more step in the run frame and as lines
// in the done frame. It never throws, so it cannot turn a successful deploy
// into the FAILED frame.
// =============================================================================

export { WITH_ANDROID_FLAG };

export async function publishAndroidAfterDeploy(
  chosen: ReadonlySet<string>,
  domain: string | undefined,
  deployRoot: string,
  hooks: DeployHooks,
  deps: AndroidStepDeps = defaultAndroidStepDeps(),
): Promise<string[]> {
  if (!chosen.has(WITH_ANDROID_FLAG)) return [];
  const step = { id: 'android', title: 'Android APK' };
  const startedAt = Date.now();
  hooks.onStepStart?.({ ...step, index: 0, total: 1 });
  const outcome = await runDeployAndroidStep({ domain, deployRoot, options: {} }, deps, (line) => hooks.onLog?.(line));
  const lines = androidReportLines(outcome);
  hooks.onStepResult?.({
    ...step,
    outcome: outcome.status === 'published' ? 'ok' : outcome.status === 'skipped' ? 'skipped' : 'failed',
    durationMs: Date.now() - startedAt,
    detail: lines[0]?.replace(/^Android APK\s+/, ''),
  });
  return ['', ...lines];
}
