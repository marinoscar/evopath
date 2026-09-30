/**
 * A plan's history (`/train/plans/:programId/history`), E5.6: its versions,
 * the difference each one made (computed in the browser from the stored
 * snapshots by `diffSnapshots`), **Restore this version** (a new version,
 * `POST /revert` with `If-Match`), and the change log with keyset paging.
 *
 * `programs:read` reaches it; restoring needs `programs:write`. The lists
 * expose slots (`renderActions`, `renderStatus`) for the proposal and undo
 * screens that build on this one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { Alert, Box, Button, Card, CardContent, Container, Link, Skeleton, Stack, Typography } from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { usePlan } from '../../hooks/usePlan';
import {
  PROGRAM_REFUSALS,
  getProgramVersion,
  listProgramChangeLog,
  listProgramVersions,
  programRefusalOf,
  type ChangeLogEntry,
  type ProgramVersionSummary,
} from '../../services/programs';
import { diffSnapshots, snapshotTree, type PlanDiff } from '../../utils/planDiff';
import { ConfirmDialog } from '../../components/gyms/ConfirmDialog';
import { ChangeLogList } from '../../components/training/ChangeLogList';
import { SnapshotDiff } from '../../components/training/SnapshotDiff';
import { VersionList } from '../../components/training/VersionList';

const PAGE = 20;

export default function PlanHistoryPage() {
  const { programId = '' } = useParams();
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('programs:write');
  const plan = usePlan(programId);
  const { program } = plan;

  const [versions, setVersions] = useState<ProgramVersionSummary[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChangeLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState<PlanDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    try {
      const list = await listProgramVersions(programId);
      setVersions(list);
      setVersionsError(null);
      setSelected((s) => s ?? list[0]?.versionNumber ?? null);
    } catch (err) {
      setVersionsError(err instanceof Error && err.message ? err.message : 'Could not load the versions');
    }
  }, [programId]);

  const loadLog = useCallback(
    async (after: string | null) => {
      setLogLoading(true);
      try {
        const page = await listProgramChangeLog(programId, { limit: PAGE, ...(after ? { cursor: after } : {}) });
        setEntries((prev) => (after ? [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))] : page.items));
        setCursor(page.nextCursor);
        setLogError(null);
      } catch (err) {
        setLogError(err instanceof Error && err.message ? err.message : 'Could not load the change log');
      } finally {
        setLogLoading(false);
      }
    },
    [programId],
  );

  useEffect(() => {
    void loadVersions();
    void loadLog(null);
  }, [loadLog, loadVersions]);

  // Exercise names for the diff sentences, from the current plan.
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const block of program?.tree.blocks ?? [])
      for (const week of block.weeks)
        for (const workout of week.workouts)
          for (const e of workout.exercises) if (e.exercise) map.set(e.exerciseId, e.exercise.name);
    return map;
  }, [program]);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setDiff(null);
    setDiffError(null);
    (async () => {
      try {
        const [current, previous] = await Promise.all([
          getProgramVersion(programId, selected),
          selected > 1 ? getProgramVersion(programId, selected - 1) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setDiff(
          diffSnapshots(previous ? snapshotTree(previous.snapshot) : null, snapshotTree(current.snapshot), (id) => names.get(id) ?? null),
        );
      } catch (err) {
        if (!cancelled) setDiffError(err instanceof Error && err.message ? err.message : 'Could not load this version');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [names, programId, selected]);

  const back = (
    <Button
      component={RouterLink}
      to={`/train/plans/${encodeURIComponent(programId)}`}
      startIcon={<BackIcon />}
      size="small"
      sx={{ mb: 1 }}
    >
      Plan
    </Button>
  );

  if (plan.notFound) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          <Alert severity="warning">
            This plan does not exist any more.{' '}
            <Link component={RouterLink} to="/train/plans">
              Back to your plans
            </Link>
          </Alert>
        </Box>
      </Container>
    );
  }

  const currentVersion = program?.currentVersion ?? versions?.[0]?.versionNumber ?? 0;

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        {back}
        <Typography variant="h4" component="h1" gutterBottom sx={{ overflowWrap: 'anywhere' }}>
          History{program ? `: ${program.name}` : ''}
        </Typography>
        {notice && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}

        <Stack spacing={2}>
          <Card variant="outlined" component="section" aria-labelledby="versions-heading">
            <CardContent>
              <Typography id="versions-heading" variant="h6" component="h2" gutterBottom>
                Versions
              </Typography>
              {versionsError ? (
                <Alert
                  severity="error"
                  action={
                    <Button color="inherit" size="small" onClick={() => void loadVersions()}>
                      Retry
                    </Button>
                  }
                >
                  {versionsError}
                </Alert>
              ) : versions ? (
                <VersionList versions={versions} currentVersion={currentVersion} selected={selected} onSelect={setSelected} />
              ) : (
                <Skeleton variant="rounded" height={120} />
              )}
            </CardContent>
          </Card>

          {selected !== null && (
            <Card variant="outlined" component="section" aria-labelledby="diff-heading">
              <CardContent>
                <Typography id="diff-heading" variant="h6" component="h2" gutterBottom>
                  {selected > 1 ? `What version ${selected} changed` : 'Version 1'}
                </Typography>
                {diffError ? (
                  <Alert severity="error">{diffError}</Alert>
                ) : diff ? (
                  <SnapshotDiff diff={diff} versionNumber={selected} />
                ) : (
                  <Skeleton variant="rounded" height={60} />
                )}
                {canWrite && program && selected !== currentVersion && (
                  <Button variant="outlined" onClick={() => setRestoreOpen(true)} sx={{ mt: 2, minHeight: 44 }}>
                    Restore this version
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <Card variant="outlined" component="section" aria-labelledby="log-heading">
            <CardContent>
              <Typography id="log-heading" variant="h6" component="h2" gutterBottom>
                Change log
              </Typography>
              {logError && (
                <Alert
                  severity="error"
                  sx={{ mb: 1 }}
                  action={
                    <Button color="inherit" size="small" onClick={() => void loadLog(entries.length > 0 ? cursor : null)}>
                      Retry
                    </Button>
                  }
                >
                  {logError}
                </Alert>
              )}
              {logLoading && entries.length === 0 ? <Skeleton variant="rounded" height={80} /> : <ChangeLogList entries={entries} />}
              {cursor && (
                <Button onClick={() => void loadLog(cursor)} disabled={logLoading} sx={{ mt: 1 }}>
                  Load more
                </Button>
              )}
            </CardContent>
          </Card>
        </Stack>
      </Box>

      <ConfirmDialog
        open={restoreOpen}
        title={`Restore version ${selected}?`}
        message="The plan goes back to this version's content as a new version. Nothing is lost: the current version stays in the history."
        confirmLabel="Restore"
        onClose={() => setRestoreOpen(false)}
        onConfirm={async () => {
          if (selected === null) return;
          try {
            const restored = await plan.revertTo(selected);
            setRestoreOpen(false);
            setNotice(`Restored version ${selected} as version ${restored.currentVersion}.`);
            setSelected(restored.currentVersion);
            await Promise.all([loadVersions(), loadLog(null)]);
          } catch (err) {
            if (programRefusalOf(err) === PROGRAM_REFUSALS.STALE_PLAN) {
              await plan.refresh();
              throw new Error('The plan changed meanwhile. It was reloaded; try again.');
            }
            throw err;
          }
        }}
      />
    </Container>
  );
}
