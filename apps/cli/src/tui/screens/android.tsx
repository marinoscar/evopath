import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { runAndroidDoctor, type AndroidCheck, type AndroidDoctorReport } from '../../android/doctor.js';
import { CLI_NAME } from '../../branding.js';
import { formatError } from '../../errors.js';
import { ErrorNotice, Frame } from '../layout.js';

// =============================================================================
// The Android screen  (issue #286, epic #276)
// =============================================================================
//
// READ-ONLY: it runs the same `runAndroidDoctor` the `android doctor`
// subcommand runs and renders the checks. Building, signing and publishing
// stay one-line commands — they take minutes, prompt for passwords and act on
// a server, none of which belongs behind a highlighted menu row.
// =============================================================================

export interface AndroidScreenProps {
  onDone: () => void;
}

const SYMBOL: Record<AndroidCheck['status'], { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: 'green' },
  warn: { glyph: '⚠', color: 'yellow' },
  fail: { glyph: '✗', color: 'red' },
  skip: { glyph: '·', color: 'gray' },
};

export function AndroidScreen({ onDone }: AndroidScreenProps): ReactNode {
  const [report, setReport] = useState<AndroidDoctorReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [run, setRun] = useState(0);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    setReport(undefined);
    setError(undefined);
    void runAndroidDoctor()
      .then((result) => {
        if (mounted.current) setReport(result);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(formatError(cause));
      });
  }, [run]);

  useInput((input, key) => {
    if (key.escape) onDone();
    if (input === 'r') setRun((value) => value + 1);
  });

  const width = report === undefined ? 0 : Math.max(...report.checks.map((check) => check.label.length));

  return (
    <Frame title="Android app" hints={['r re-check', 'esc back']}>
      <Box flexDirection="column" gap={1}>
        {error !== undefined ? <ErrorNotice message={error} /> : null}
        {report === undefined && error === undefined ? (
          <Text>
            <Spinner type="dots" /> Checking the Android toolchain…
          </Text>
        ) : null}
        {report !== undefined ? (
          <Box flexDirection="column">
            {report.checks.map((check) => (
              <Box key={check.id} flexDirection="column">
                <Text>
                  <Text color={SYMBOL[check.status].color}>{SYMBOL[check.status].glyph}</Text> {check.label.padEnd(width)}{' '}
                  <Text dimColor>{check.detail}</Text>
                </Text>
                {check.fix !== undefined && check.status !== 'pass' ? <Text dimColor>{`   → ${check.fix}`}</Text> : null}
              </Box>
            ))}
          </Box>
        ) : null}
        <Text dimColor>
          {`Build and publish from a shell: \`${CLI_NAME} android build\`, \`${CLI_NAME} android publish\`, or \`${CLI_NAME} android release\`.`}
        </Text>
      </Box>
    </Frame>
  );
}
