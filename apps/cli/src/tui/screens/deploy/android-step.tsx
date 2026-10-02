import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { useEffect, useState, type ReactNode } from 'react';

import { runAndroidDoctor, type AndroidDoctorReport } from '../../../android/doctor.js';
import { findRepoRoot } from '../../../android/paths.js';
import { getReleaseStatus } from '../../../android/release-status.js';
import { CLI_NAME } from '../../../branding.js';
import { androidBuildSource, describeBuildSource } from '../../../deploy/android-step.js';
import { checkoutPathFor } from '../../../deploy/version-step.js';
import { Field, Frame, useIsMounted } from '../../layout.js';
import {
  ANDROID_CHOICES,
  ANDROID_YES,
  checkoutVersionLine,
  doctorLines,
  lookupReleaseLine,
  type ReleaseLookupDeps,
} from './android-step-model.js';

// =============================================================================
// The "Android app" step of Deploy → Install and Deploy → Update  (issue #315)
// =============================================================================
//
// A yes/no with the facts needed to answer it, between the options and the
// confirmation. It replaces the `--with-android` row that used to sit last in
// the toggle list, where it was easy to miss.
//
// ⚠ THE CONTEXT NEVER BLOCKS THE CHOICE. The published release (network,
// bounded by a timeout) and the toolchain pre-flight (the Android doctor,
// against the checkout the build will use) load in the background with a
// "checking…" line; the operator can answer before either finishes. Neither
// can throw into the screen: each failure is a sentence.
//
// One input at a time: the select owns ↑↓/Enter, and this component's own
// `useInput` takes Esc only (the screen's run-level Esc is off on this step).
// =============================================================================

export interface AndroidStepDeps extends ReleaseLookupDeps {
  findOwnCheckout: () => string | undefined;
  doctor: (repoRoot: string) => Promise<AndroidDoctorReport>;
}

export function defaultAndroidStepScreenDeps(): AndroidStepDeps {
  return {
    findOwnCheckout: () => findRepoRoot(),
    doctor: (repoRoot) => runAndroidDoctor({ cwd: repoRoot }),
    getReleaseStatus: (url, repoRoot, signal) => getReleaseStatus({ repoRoot, serverUrl: url }, { signal }),
  };
}

export interface AndroidAppStepProps {
  /** `Update — shop · Android app`. */
  title: string;
  deployRoot: string;
  /** The deployment's public domain, when known. */
  domain: string | undefined;
  /** The selection to open on. */
  initialYes: boolean;
  /** A dim note under the checkout version: what this action may change about it. */
  versionNote: string;
  onChoose: (yes: boolean) => void;
  onBack: () => void;
  deps?: AndroidStepDeps | undefined;
}

type Preflight =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'done'; lines: string[]; ok: boolean }
  | { kind: 'error'; message: string };

export function AndroidAppStep({
  title,
  deployRoot,
  domain,
  initialYes,
  versionNote,
  onChoose,
  onBack,
  deps,
}: AndroidAppStepProps): ReactNode {
  const isMounted = useIsMounted();
  const [resolved] = useState<AndroidStepDeps>(() => deps ?? defaultAndroidStepScreenDeps());
  const [checkoutVersion] = useState(() => checkoutVersionLine(deployRoot));
  const [source] = useState(() => {
    try {
      return androidBuildSource(deployRoot, resolved.findOwnCheckout);
    } catch {
      return undefined;
    }
  });
  const [release, setRelease] = useState<string | undefined>(undefined);
  const [preflight, setPreflight] = useState<Preflight>(source === undefined ? { kind: 'none' } : { kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    void lookupReleaseLine(domain, source?.repoRoot ?? checkoutPathFor(deployRoot), resolved, controller.signal).then(
      (line) => {
        if (isMounted()) setRelease(line);
      },
    );
    return () => controller.abort();
    // Read once per mount: the inputs are fixed for the step's lifetime.
  }, []);

  useEffect(() => {
    if (source === undefined) return;
    void (async () => {
      try {
        const report = await resolved.doctor(source.repoRoot);
        if (isMounted()) setPreflight({ kind: 'done', lines: doctorLines(report, source), ok: report.ok });
      } catch (error) {
        if (isMounted()) setPreflight({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, []);

  useInput((_input, key) => {
    if (key.escape) onBack();
  });

  return (
    <Frame title={title} hints={['↑↓ move', 'enter select', 'esc back']}>
      <Text>Include the Android app in this deploy?</Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="checkout" value={checkoutVersion} />
        <Text dimColor>{`${' '.repeat(10)}${versionNote}`}</Text>
        <Field label="published" value={release ?? 'checking…'} dim={release === undefined} />
        <PreflightRows preflight={preflight} />
        {source === undefined ? null : <Text dimColor>{`${' '.repeat(10)}builds from ${describeBuildSource(source)}`}</Text>}
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[...ANDROID_CHOICES]}
          initialIndex={initialYes ? 1 : 0}
          onSelect={(item) => {
            onChoose(item.value === ANDROID_YES);
          }}
        />
      </Box>
    </Frame>
  );
}

function PreflightRows({ preflight }: { preflight: Preflight }): ReactNode {
  switch (preflight.kind) {
    case 'checking':
      return (
        <Box>
          <Text dimColor>{'preflight'.padEnd(10)}</Text>
          <Text>
            <Spinner type="dots" /> checking the Android toolchain…
          </Text>
        </Box>
      );
    case 'none':
      return (
        <Field
          label="preflight"
          value={`no apps/android checkout to check yet — run \`${CLI_NAME} android doctor\` in yours`}
          dim
        />
      );
    case 'error':
      return <Field label="preflight" value={`could not run the Android doctor: ${preflight.message}`} color="yellow" />;
    case 'done': {
      const [head, ...rest] = preflight.lines;
      return (
        <Box flexDirection="column">
          <Field label="preflight" value={head ?? ''} color={preflight.ok ? 'green' : 'yellow'} />
          {rest.map((line, index) => (
            // Lines can repeat (two checks with the same fix); the index keeps keys unique.
            <Text key={`${index}-${line}`} dimColor>{`${' '.repeat(10)}${line}`}</Text>
          ))}
        </Box>
      );
    }
  }
}
