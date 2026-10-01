import { join } from 'node:path';

import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { runBuild, type BuildResult } from '../../android/build.js';
import { runAndroidDoctor, type AndroidCheck, type AndroidDoctorReport } from '../../android/doctor.js';
import { exec } from '../../android/exec.js';
import { apkFileName } from '../../android/metadata.js';
import {
  bumpVersionFile,
  previewBump,
  publishBuiltApk,
  readBuiltApk,
  releasesClient,
  type PublishedApk,
} from '../../android/operations.js';
import { distDir, findRepoRoot } from '../../android/paths.js';
import { formatBytes, listReleases, makeCurrent, type AndroidRelease } from '../../android/publish.js';
import { commitVersionFile, runRelease } from '../../android/release.js';
import { credentialsForServer, getReleaseStatus, type ReleaseStatus } from '../../android/release-status.js';
import type { BumpPart } from '../../android/version.js';
import { CLI_NAME } from '../../branding.js';
import { formatError } from '../../errors.js';
import { ErrorNotice, Field, Frame } from '../layout.js';
import { ScrollBox } from '../scroll-box.js';
import {
  actionItems,
  BUMP_PARTS,
  bumpLabel,
  itemLabel,
  makeCurrentConfirmation,
  progressStep,
  publishConfirmation,
  releaseConfirmation,
  releaseLabel,
  statusRows,
  uploadProgressText,
  versionLabel,
  type ActionItem,
  type AndroidAction,
  type Confirmation,
} from './android/model.js';

// =============================================================================
// The Android screen  (issue #291, epic #290; read-only since #286)
// =============================================================================
//
// A status panel (local version, keystore, login, the server's current
// release) over an action list: doctor, bump, build, publish, release, and
// the releases list with make-current / rollback.
//
// IT REIMPLEMENTS NOTHING. Every action calls the function the `android`
// subcommand calls — `runAndroidDoctor`, `runBuild`, `publishBuiltApk`,
// `runRelease`, `listReleases`, `makeCurrent` — and differs only in rendering
// the log lines as React state. What is allowed and what each confirmation
// says is decided in android/model.ts, which the tests cover.
//
// THE TOKEN IS NEVER IN STATE. `ReleaseStatus` has no field for it; an action
// that needs it reads it with `credentialsForServer` at the moment it acts.
//
// A BUILD CANNOT BE CANCELLED FROM HERE. The Android toolchain wrapper takes
// no signal, so Esc is ignored while a task runs (the hint says so) rather
// than unmounting the screen and leaving Gradle running unseen. Ctrl-C still
// exits the whole app.
// =============================================================================

export interface AndroidScreenProps {
  onDone: () => void;
  /** Open the login screen; it returns here. */
  onLogin: () => void;
}

const SYMBOL: Record<AndroidCheck['status'], { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: 'green' },
  warn: { glyph: '⚠', color: 'yellow' },
  fail: { glyph: '✗', color: 'red' },
  skip: { glyph: '·', color: 'gray' },
};

/** Log lines kept for a running task; a Gradle build prints thousands. */
const MAX_LINES = 2_000;

type Notice = { text: string; color: 'green' | 'yellow' | 'red' };

type NotesFor = { kind: 'publish' } | { kind: 'release'; part: BumpPart };

type Phase =
  | { kind: 'menu' }
  | { kind: 'doctor' }
  | { kind: 'bump' }
  | { kind: 'release-part' }
  | { kind: 'notes'; for: NotesFor }
  | { kind: 'confirm'; confirmation: Confirmation; onYes: () => void; onNo: () => void }
  | { kind: 'task'; title: string; running: boolean; progress?: string | undefined; summary: string[]; error?: string | undefined; back: 'menu' | 'releases' }
  | { kind: 'releases' };

export function AndroidScreen({ onDone, onLogin }: AndroidScreenProps): ReactNode {
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const [repoRoot] = useState<string | undefined>(() => findRepoRoot());
  const [status, setStatus] = useState<ReleaseStatus | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'menu' });
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [lines, setLines] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setStatusError(undefined);
    const controller = new AbortController();
    void getReleaseStatus({ repoRoot }, { signal: controller.signal })
      .then((result) => {
        if (mounted.current) setStatus(result);
      })
      .catch((error: unknown) => {
        if (mounted.current) setStatusError(formatError(error));
      });
    return () => controller.abort();
  }, [repoRoot, refresh]);

  const toMenu = useCallback(() => {
    setPhase({ kind: 'menu' });
    setRefresh((value) => value + 1);
  }, []);

  const appendLine = useCallback((line: string) => {
    if (!mounted.current) return;
    setLines((current) => {
      const next = [...current, line];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  /** Run one task, streaming its log, and land on its summary or its error. */
  const runTask = useCallback(
    (title: string, work: (progress: (text: string) => void) => Promise<string[]>, back: 'menu' | 'releases' = 'menu') => {
      setLines([]);
      setPhase({ kind: 'task', title, running: true, summary: [], back });
      const progress = (text: string) => {
        if (!mounted.current) return;
        setPhase((current) => (current.kind === 'task' && current.running ? { ...current, progress: text } : current));
      };
      void work(progress)
        .then((summary) => {
          if (mounted.current) setPhase({ kind: 'task', title, running: false, summary, back });
        })
        .catch((error: unknown) => {
          if (mounted.current) setPhase({ kind: 'task', title, running: false, summary: [], error: formatError(error), back });
        });
    },
    [],
  );

  const target = status?.targetServerUrl;
  const credentials = useCallback(() => {
    const found = credentialsForServer(target);
    if (found === undefined) throw new Error(`Not logged in to ${target ?? 'a server'}. Choose "Log in".`);
    return found;
  }, [target]);

  const build = useCallback(
    async (): Promise<BuildResult> =>
      await runBuild({ ...(target === undefined ? {} : { serverUrl: target }) }, { log: appendLine, exec }),
    [appendLine, target],
  );

  const upload = useCallback(
    async (apkPath: string, progress: (text: string) => void, releaseNotes: string): Promise<PublishedApk> => {
      const total = readBuiltApk(apkPath).sizeBytes;
      let shown = -1;
      appendLine(`Uploading ${apkPath} to ${target ?? ''}…`);
      return await publishBuiltApk({
        apkPath,
        credentials: credentials(),
        notes: releaseNotes === '' ? undefined : releaseNotes,
        makeCurrent: true,
        onUploadProgress: (sent) => {
          const step = progressStep(sent, total);
          if (step === shown) return;
          shown = step;
          progress(uploadProgressText(sent, total));
        },
      });
    },
    [appendLine, credentials, target],
  );

  // ---- actions -------------------------------------------------------------------
  const builtApkPath = (): string | undefined =>
    repoRoot === undefined || status?.local == null ? undefined : join(distDir(repoRoot), apkFileName(status.local.versionName));

  const startPublish = (releaseNotes: string) => {
    const apkPath = builtApkPath();
    if (apkPath === undefined || target === undefined) return;
    let metadata;
    try {
      metadata = readBuiltApk(apkPath);
    } catch (error) {
      setNotice({ text: `${formatError(error)} Choose "Build" first.`, color: 'red' });
      setPhase({ kind: 'menu' });
      return;
    }
    setPhase({
      kind: 'confirm',
      confirmation: publishConfirmation(metadata, target, status?.server.current ?? null, releaseNotes),
      onNo: () => setPhase({ kind: 'menu' }),
      onYes: () =>
        runTask('Publish', async (progress) => {
          const { release } = await upload(apkPath, progress, releaseNotes);
          return [
            `Published ${versionLabel(release)}${release.isCurrent === true ? ' — now the current release' : ''}.`,
            `Release id: ${release.id}`,
          ];
        }),
    });
  };

  const startRelease = (part: BumpPart, releaseNotes: string) => {
    if (repoRoot === undefined || target === undefined) return;
    const preview = previewBump(repoRoot, part);
    setPhase({
      kind: 'confirm',
      confirmation: releaseConfirmation(preview.before, preview.after, target, releaseNotes),
      onNo: () => setPhase({ kind: 'menu' }),
      onYes: () =>
        runTask('Release', async (progress) => {
          // Fail on missing credentials BEFORE bumping, like `android release`.
          credentials();
          const outcome = await runRelease<BuildResult, PublishedApk>(
            { bump: part, commit: true },
            {
              bump: (bumpPart) => bumpVersionFile(repoRoot, bumpPart).after,
              build,
              publish: async (built) => await upload(built.apkPath, progress, releaseNotes),
              commit: async (version) => await commitVersionFile(exec, repoRoot, version),
            },
            appendLine,
          );
          return [
            `Released ${versionLabel(outcome.version)} — now the current release on ${target}.`,
            `APK: ${outcome.build.apkPath}`,
            `Commit: ${outcome.commit}`,
          ];
        }),
    });
  };

  const choose = (item: ActionItem) => {
    setNotice(undefined);
    if (!item.enabled) {
      setNotice({ text: item.reason ?? 'Not available.', color: 'yellow' });
      return;
    }
    const actions: Record<AndroidAction, () => void> = {
      doctor: () => setPhase({ kind: 'doctor' }),
      bump: () => setPhase({ kind: 'bump' }),
      build: () =>
        runTask('Build', async () => {
          const result = await build();
          return [
            `APK:       ${result.apkPath} (${formatBytes(result.metadata.sizeBytes)})`,
            `Metadata:  ${result.metadataPath}`,
            result.verified
              ? `apksigner: verified (${result.metadata.signingSha256})`
              : 'apksigner: not found — signature NOT verified',
          ];
        }),
      publish: () => {
        setNotes('');
        setPhase({ kind: 'notes', for: { kind: 'publish' } });
      },
      release: () => setPhase({ kind: 'release-part' }),
      releases: () => setPhase({ kind: 'releases' }),
      login: onLogin,
    };
    actions[item.action]();
  };

  // ---- keyboard --------------------------------------------------------------------
  useInput((input, key) => {
    switch (phase.kind) {
      case 'menu':
        if (key.escape) onDone();
        else if (input === 'r') {
          setNotice(undefined);
          setStatus(undefined);
          setRefresh((value) => value + 1);
        }
        return;
      case 'task':
        if (phase.running) return;
        if (key.escape || key.return) {
          if (phase.back === 'releases') setPhase({ kind: 'releases' });
          else toMenu();
        }
        return;
      case 'confirm':
        if (key.escape) phase.onNo();
        return;
      case 'doctor':
      case 'releases':
        // Their own components bind the rest.
        return;
      default:
        if (key.escape) setPhase({ kind: 'menu' });
    }
  });

  // ---- render ----------------------------------------------------------------------
  if (phase.kind === 'doctor') return <DoctorView onBack={toMenu} />;

  if (phase.kind === 'releases' && target !== undefined) {
    return (
      <ReleasesView
        serverUrl={target}
        onBack={toMenu}
        onConfirm={(confirmation, release) =>
          setPhase({
            kind: 'confirm',
            confirmation,
            onNo: () => setPhase({ kind: 'releases' }),
            onYes: () =>
              runTask(
                'Make current',
                async () => {
                  const made = await makeCurrent(releasesClient(credentials()), release.id);
                  return [`${versionLabel(made)} is now the current release on ${target}.`];
                },
                'releases',
              ),
          })
        }
      />
    );
  }

  if (phase.kind === 'confirm') return <ConfirmView confirmation={phase.confirmation} onYes={phase.onYes} onNo={phase.onNo} />;

  if (phase.kind === 'task') {
    return (
      <Frame
        title={`Android — ${phase.title}${phase.running ? '' : phase.error === undefined ? ' — done' : ' — FAILED'}`}
        hints={phase.running ? ['running — cannot be cancelled', 'ctrl-c quits the app'] : ['↑↓ scroll', 'esc/enter back']}
      >
        {phase.running ? (
          <Text>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>{' '}
            {phase.progress ?? `${phase.title}…`}
          </Text>
        ) : phase.error !== undefined ? (
          <ErrorNotice message={phase.error} />
        ) : (
          <Box flexDirection="column">
            {phase.summary.map((line, index) => (
              <Text key={`${index}:${line}`} {...(index === 0 ? { color: 'green' } : {})}>
                {line}
              </Text>
            ))}
          </Box>
        )}
        {lines.length === 0 ? null : (
          <Box marginTop={1} flexDirection="column">
            <ScrollBox lines={lines} reservedRows={14} followTail isActive={!phase.running} />
          </Box>
        )}
      </Frame>
    );
  }

  if (phase.kind === 'bump' && repoRoot !== undefined) {
    const items = BUMP_PARTS.map((part) => {
      const preview = previewBump(repoRoot, part);
      return { key: part, label: bumpLabel(part, preview.before, preview.after), value: part };
    });
    return (
      <Frame title="Android — Bump version" hints={['↑↓ move', 'enter bump', 'esc back']}>
        <Text>Writes apps/android/version.properties (name and code). Nothing is committed.</Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              try {
                const bump = bumpVersionFile(repoRoot, item.value);
                setNotice({ text: `Bumped ${versionLabel(bump.before)} → ${versionLabel(bump.after)}.`, color: 'green' });
              } catch (error) {
                setNotice({ text: formatError(error), color: 'red' });
              }
              toMenu();
            }}
          />
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'release-part' && repoRoot !== undefined) {
    const items = BUMP_PARTS.map((part) => {
      const preview = previewBump(repoRoot, part);
      return { key: part, label: bumpLabel(part, preview.before, preview.after), value: part };
    });
    return (
      <Frame title="Android — Release" hints={['↑↓ move', 'enter choose', 'esc back']}>
        <Text>Which part of the version does this release bump?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              setNotes('');
              setPhase({ kind: 'notes', for: { kind: 'release', part: item.value } });
            }}
          />
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'notes') {
    const forWhat = phase.for;
    return (
      <Frame title={`Android — ${forWhat.kind === 'publish' ? 'Publish' : 'Release'}`} hints={['enter continue', 'esc back']}>
        <Text>Release notes (optional, shown on the download page):</Text>
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <TextInput
            value={notes}
            onChange={setNotes}
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (forWhat.kind === 'publish') startPublish(trimmed);
              else startRelease(forWhat.part, trimmed);
            }}
          />
        </Box>
      </Frame>
    );
  }

  // ---- the menu ---------------------------------------------------------------------
  const items = actionItems(status);
  return (
    <Frame title="Android app" hints={['↑↓ move', 'enter select', 'r refresh', 'esc back']}>
      <Box flexDirection="column">
        {statusError !== undefined ? <ErrorNotice message={statusError} hint="Press r to try again." /> : null}
        {status === undefined && statusError === undefined ? (
          <Text>
            <Spinner type="dots" /> Reading the release status…
          </Text>
        ) : null}
        {status === undefined
          ? null
          : statusRows(status).map((row) => <Field key={row.label} label={row.label} value={row.value} color={row.color} />)}
      </Box>
      {notice === undefined ? null : (
        <Box marginTop={1}>
          <Text color={notice.color}>{notice.text}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <SelectInput
          items={items.map((item) => ({ key: item.action, label: itemLabel(item), value: item }))}
          onSelect={(entry) => choose(entry.value)}
        />
      </Box>
    </Frame>
  );
}

// -----------------------------------------------------------------------------
// Confirmation: "No" first and selected, like the deploy screens.
// -----------------------------------------------------------------------------

function ConfirmView({ confirmation, onYes, onNo }: { confirmation: Confirmation; onYes: () => void; onNo: () => void }): ReactNode {
  const items = [
    { key: 'no', label: 'No, go back', value: 'no' as const },
    { key: 'yes', label: confirmation.yes, value: 'yes' as const },
  ];
  return (
    <Frame title={`Confirm — ${confirmation.title}`} hints={['enter select', 'esc back']}>
      <Text bold>{confirmation.question}</Text>
      <Box marginTop={1} flexDirection="column">
        {confirmation.lines.map((line) => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
      </Box>
      {confirmation.warning === undefined ? null : (
        <Box marginTop={1}>
          <Text color="yellow">⚠ {confirmation.warning}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === 'yes') onYes();
            else onNo();
          }}
        />
      </Box>
    </Frame>
  );
}

// -----------------------------------------------------------------------------
// Doctor: the same `runAndroidDoctor` as `android doctor`.
// -----------------------------------------------------------------------------

function DoctorView({ onBack }: { onBack: () => void }): ReactNode {
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
    if (key.escape) onBack();
    if (input === 'r') setRun((value) => value + 1);
  });

  const width = report === undefined ? 0 : Math.max(...report.checks.map((check) => check.label.length));

  return (
    <Frame title="Android — Doctor" hints={['r re-check', 'esc back']}>
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
        <Text dimColor>{`Install the SDK from a shell: \`${CLI_NAME} android doctor --fix\`.`}</Text>
      </Box>
    </Frame>
  );
}

// -----------------------------------------------------------------------------
// Releases: the admin list; selecting one offers "make current".
// -----------------------------------------------------------------------------

function ReleasesView({
  serverUrl,
  onBack,
  onConfirm,
}: {
  serverUrl: string;
  onBack: () => void;
  onConfirm: (confirmation: Confirmation, release: AndroidRelease) => void;
}): ReactNode {
  const [releases, setReleases] = useState<AndroidRelease[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [run, setRun] = useState(0);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    setReleases(undefined);
    setError(undefined);
    const credentials = credentialsForServer(serverUrl);
    if (credentials === undefined) {
      setError(`Not logged in to ${serverUrl}.`);
      return;
    }
    void listReleases(releasesClient(credentials))
      .then((list) => {
        if (mounted.current) setReleases(list);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(formatError(cause));
      });
  }, [serverUrl, run]);

  useInput((input, key) => {
    if (key.escape) onBack();
    if (input === 'r') setRun((value) => value + 1);
  });

  return (
    <Frame title={`Android — Releases on ${serverUrl}`} hints={['↑↓ move', 'enter make current', 'r refresh', 'esc back']}>
      {error !== undefined ? <ErrorNotice message={error} hint="Press r to try again." /> : null}
      {releases === undefined && error === undefined ? (
        <Text>
          <Spinner type="dots" /> Loading releases…
        </Text>
      ) : null}
      {releases !== undefined && releases.length === 0 ? <Text>No releases have been published yet.</Text> : null}
      {notice === undefined ? null : <Text color="yellow">{notice}</Text>}
      {releases !== undefined && releases.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>* = current release</Text>
          <SelectInput
            items={releases.map((release) => ({ key: release.id, label: releaseLabel(release), value: release }))}
            onSelect={(item) => {
              if (item.value.isCurrent === true) {
                setNotice(`${versionLabel(item.value)} is already the current release.`);
                return;
              }
              onConfirm(makeCurrentConfirmation(item.value, releases, serverUrl), item.value);
            }}
          />
        </Box>
      ) : null}
    </Frame>
  );
}
