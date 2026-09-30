/**
 * One plan (`/train/plans/:programId`), E5.6: the viewer.
 *
 * Header with provenance ("AI-generated plan" or "Manual plan", VISION 64),
 * the version, gym and autonomy; the lifecycle actions (`programs:write`);
 * "Why this plan" (the rationale) and "How it was made" (the version meta,
 * when present); the evidence (verified sources only) with chips that open
 * each claim; and the body one week at a time.
 *
 * `programs:read` reaches it; nothing here needs AI.
 */
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Container,
  Link,
  List,
  ListItem,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import { ArrowBack as BackIcon, Edit as EditIcon, History as HistoryIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { usePlan } from '../../hooks/usePlan';
import { useTrainingAvailability } from '../../hooks/useTrainingAvailability';
import { useWeightUnit } from '../../hooks/useWeightUnit';
import { listExercises } from '../../services/exercises';
import { PROGRAM_REFUSALS, programRefusalOf, type Program } from '../../services/programs';
import { localDateIn } from '../../utils/localDates';
import { ConfirmDialog } from '../../components/gyms/ConfirmDialog';
import { ActivatePlanDialog } from '../../components/training/ActivatePlanDialog';
import { HowItWasMade, hasMadeMeta } from '../../components/training/HowItWasMade';
import { PlanViewer, weekOptions } from '../../components/training/PlanViewer';
import { SOURCE_KIND_LABEL } from '../../components/training/SourceList';
import { GOAL_LABEL, ORIGIN_LABEL, STATUS_COLOR, STATUS_LABEL } from '../../components/training/planLabels';
import { parseEvidence } from '../../components/training/planEvidence';
import { PlanEditor } from '../../components/training/PlanEditor';
import { ReviseWithAi } from '../../components/training/ReviseWithAi';

export const HAS_HISTORY_MESSAGE = 'Workouts were logged from this plan, so it cannot be deleted. Archive it instead.';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card variant="outlined" component="section" aria-labelledby={id}>
      <CardContent>
        <Typography id={id} variant="h6" component="h2" gutterBottom>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

/** Weekdays used by week 1 (what the start date lines up with). */
function firstWeekWeekdays(program: Program): number[] {
  const first = program.tree.blocks.flatMap((b) => b.weeks).find((w) => w.weekNumber === 1);
  return (first?.workouts ?? []).map((w) => w.weekday).filter((d): d is number => typeof d === 'number');
}

export default function PlanViewerPage() {
  const { programId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('programs:write');
  const plan = usePlan(programId);
  const { program } = plan;
  const unit = useWeightUnit();
  const [weekNumber, setWeekNumber] = useState(1);
  const [availability, setAvailability] = useState<Map<string, boolean>>(new Map());
  const [dialog, setDialog] = useState<'activate' | 'archive' | 'delete' | null>(null);
  const [notice, setNotice] = useState<string | null>((location.state as { notice?: string } | null)?.notice ?? null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<boolean>(!!(location.state as { edit?: boolean } | null)?.edit);
  const [dirty, setDirty] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const aiAvailability = useTrainingAvailability();

  // The dirty-state guard: a reload or closing the tab asks first. In-app
  // link on this page (Plans) asks through the discard dialog.
  useEffect(() => {
    if (!editing || !dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, editing]);


  const evidence = useMemo(() => parseEvidence(program?.version.evidence), [program?.version.evidence]);
  const weeks = useMemo(() => (program ? weekOptions(program.tree) : []), [program]);

  // Keep the selected week valid as the plan changes.
  useEffect(() => {
    if (weeks.length > 0 && !weeks.some((w) => w.weekNumber === weekNumber)) setWeekNumber(weeks[0].weekNumber);
  }, [weeks, weekNumber]);

  // Which exercises the plan's gym can do (for "Not available at {gym}").
  const gymId = program?.gymId ?? null;
  useEffect(() => {
    if (!gymId || !hasPermission('exercises:read')) {
      setAvailability(new Map());
      return;
    }
    let cancelled = false;
    listExercises({ gymId, limit: 200 })
      .then((list) => {
        if (!cancelled) {
          setAvailability(new Map(list.filter((e) => typeof e.available === 'boolean').map((e) => [e.id, e.available as boolean])));
        }
      })
      .catch(() => {
        // Availability is a hint; the plan renders without it.
      });
    return () => {
      cancelled = true;
    };
  }, [gymId, hasPermission]);

  const back = (
    <Button
      component={RouterLink}
      to="/train/plans"
      onClick={(e: MouseEvent) => {
        if (editing && dirty) {
          e.preventDefault();
          setLeaveTo('/train/plans');
        }
      }}
      startIcon={<BackIcon />}
      size="small"
      sx={{ mb: 1 }}
    >
      Plans
    </Button>
  );

  if (plan.notFound) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          {back}
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

  if (!program) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          {back}
          {plan.error ? (
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={() => void plan.refresh()}>
                  Retry
                </Button>
              }
            >
              {plan.error}
            </Alert>
          ) : (
            <Skeleton variant="rounded" height={200} />
          )}
        </Box>
      </Container>
    );
  }

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setActionError(null);
    try {
      await action();
      if (done) setNotice(done);
    } catch (err) {
      setActionError(err instanceof Error && err.message ? err.message : 'That did not work');
    }
  };

  const scheduled = firstWeekWeekdays(program);
  const canActivate = program.status === 'draft' || program.status === 'paused';
  const sources = [...evidence.sources.values()];

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        {back}
        <Typography variant="h4" component="h1" sx={{ overflowWrap: 'anywhere' }}>
          {program.name}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 1 }}>
          {GOAL_LABEL[program.goal] ?? program.goal}
          {program.gym ? ` · ${program.gym.name}` : ' · No equipment'}
          {program.startDate ? ` · Started ${program.startDate}` : ''}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }}>
          <Chip size="small" label={STATUS_LABEL[program.status]} color={STATUS_COLOR[program.status]} />
          <Chip
            size="small"
            variant="outlined"
            color={program.source === 'ai' ? 'secondary' : 'default'}
            label={program.source === 'ai' ? 'AI-generated plan' : 'Manual plan'}
            data-testid="plan-source"
          />
          <Chip size="small" variant="outlined" label={`Version ${program.currentVersion}`} />
          <Chip size="small" variant="outlined" label={ORIGIN_LABEL[program.version.origin] ?? program.version.origin} />
          <Chip
            size="small"
            variant="outlined"
            label={program.autonomy === 'autonomous' ? 'Adjusts automatically' : 'Asks before changes'}
          />
        </Stack>

        {notice && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        )}
        {actionError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}

        {!editing && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 3 }}>
            {canWrite && (
              <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEditing(true)} sx={{ minHeight: 44 }}>
                Edit
              </Button>
            )}
            {canWrite && canActivate && (
              <Button
                variant="contained"
                onClick={() => setDialog('activate')}
                disabled={scheduled.length === 0}
                aria-describedby={scheduled.length === 0 ? 'activate-reason' : undefined}
                sx={{ minHeight: 44 }}
              >
                Activate
              </Button>
            )}
            {canWrite && program.status === 'active' && (
              <Button variant="outlined" onClick={() => void run(plan.pause, 'Plan paused.')} sx={{ minHeight: 44 }}>
                Pause
              </Button>
            )}
            {canWrite && program.status !== 'archived' && (
              <Button variant="outlined" onClick={() => setDialog('archive')} sx={{ minHeight: 44 }}>
                Archive
              </Button>
            )}
            {canWrite && (
              <Button
                variant="outlined"
                onClick={() =>
                  void run(async () => {
                    const copy = await plan.duplicate();
                    navigate(`/train/plans/${encodeURIComponent(copy.id)}`, { state: { notice: 'A copy of the plan was made.' } });
                  })
                }
                sx={{ minHeight: 44 }}
              >
                Duplicate
              </Button>
            )}
            {canWrite && (
              <Button variant="outlined" color="error" onClick={() => setDialog('delete')} sx={{ minHeight: 44 }}>
                Delete
              </Button>
            )}
            <Button
              component={RouterLink}
              to={`/train/plans/${encodeURIComponent(program.id)}/history`}
              startIcon={<HistoryIcon />}
              sx={{ minHeight: 44 }}
            >
              History
            </Button>
          </Stack>
        )}
        {!editing && canWrite && canActivate && scheduled.length === 0 && (
          <Typography id="activate-reason" variant="body2" color="text.secondary" sx={{ mt: -2, mb: 3 }}>
            Schedule at least one week 1 workout on a weekday before activating.
          </Typography>
        )}

        {editing ? (
          <PlanEditor
            key={program.id}
            program={program}
            unit={unit}
            canCreateExercise={hasPermission('exercises:write')}
            saveStructure={plan.saveStructure}
            updateName={(name) => plan.updateHeader({ name })}
            reload={plan.refresh}
            onDirtyChange={setDirty}
            onCancel={() => {
              if (dirty) setLeaveTo('stay');
              else setEditing(false);
            }}
            onSaved={(saved) => {
              setDirty(false);
              setEditing(false);
              setNotice(`Saved as version ${saved.currentVersion} (edited by you).`);
            }}
          />
        ) : (
          <Stack spacing={2}>
            {(program.rationale || hasMadeMeta(program.version.meta)) && (
              <Section id="why-heading" title="Why this plan">
                {program.rationale && <Typography sx={{ overflowWrap: 'anywhere' }}>{program.rationale}</Typography>}
                {hasMadeMeta(program.version.meta) && (
                  <Box sx={{ mt: program.rationale ? 2 : 0 }}>
                    <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
                      How it was made
                    </Typography>
                    <HowItWasMade meta={program.version.meta} />
                  </Box>
                )}
              </Section>
            )}

            {sources.length > 0 && (
              <Section id="evidence-heading" title="Evidence">
                <List dense disablePadding aria-label="Sources">
                  {sources.map((source) => (
                    <ListItem key={source.id} disableGutters sx={{ display: 'block', py: 0.5 }} data-testid="evidence-source">
                      <Link href={source.url} target="_blank" rel="noopener noreferrer" sx={{ overflowWrap: 'anywhere' }}>
                        {source.title || source.domain}
                      </Link>
                      <Typography variant="body2" color="text.secondary">
                        {source.domain}
                        {source.kind ? ` · ${SOURCE_KIND_LABEL[source.kind] ?? source.kind}` : ''}
                        {source.year ? ` · ${source.year}` : ''}
                      </Typography>
                    </ListItem>
                  ))}
                </List>
              </Section>
            )}

            {aiAvailability.aiVisible && canWrite && program.status !== 'archived' && (
              <Section id="revise-heading" title="Revise with AI">
                <ReviseWithAi
                  programId={program.id}
                  currentVersion={program.currentVersion}
                  blocker={aiAvailability.blocker('revise')}
                />
              </Section>
            )}

            <Section id="weeks-heading" title="Weeks">
              <PlanViewer
                tree={program.tree}
                weekNumber={weekNumber}
                onWeekChange={setWeekNumber}
                unit={unit}
                evidence={evidence}
                availability={availability}
                gymName={program.gym?.name ?? null}
              />
            </Section>
          </Stack>
        )}
      </Box>

      <ConfirmDialog
        open={leaveTo !== null}
        title="Discard your edits?"
        message="You have unsaved changes to this plan. Leaving discards them."
        confirmLabel="Discard"
        onClose={() => setLeaveTo(null)}
        onConfirm={async () => {
          const to = leaveTo;
          setLeaveTo(null);
          setDirty(false);
          setEditing(false);
          if (to && to !== 'stay') navigate(to);
        }}
      />
      <ActivatePlanDialog
        open={dialog === 'activate'}
        today={localDateIn(null)}
        weekdays={scheduled}
        onClose={() => setDialog(null)}
        onActivate={async (startDate) => {
          await plan.activate(startDate);
          setNotice('Plan activated.');
        }}
      />
      <ConfirmDialog
        open={dialog === 'archive'}
        title="Archive this plan?"
        message="It stops being scheduled and moves out of the way. Its history is kept."
        confirmLabel="Archive"
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          await plan.archive();
          setDialog(null);
          setNotice('Plan archived.');
        }}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        title="Delete this plan?"
        message="The plan and all its versions are removed. This cannot be undone."
        confirmLabel="Delete"
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          try {
            await plan.remove();
          } catch (err) {
            if (programRefusalOf(err) === PROGRAM_REFUSALS.HAS_HISTORY) throw new Error(HAS_HISTORY_MESSAGE);
            throw err;
          }
          navigate('/train/plans', { state: { notice: 'Plan deleted.' } });
        }}
      />
    </Container>
  );
}
