/**
 * Edit mode of the plan screen, and the manual builder (the same editor for
 * AI and manual plans: they differ in provenance, not in shape).
 *
 * Holds a draft of the whole tree and saves it with `PUT /structure` and
 * `If-Match`, which makes a NEW version ("Edited by you") with its change
 * log entry. A stale version (the coach adjusted the plan meanwhile) opens a
 * dialog that keeps the local edits copyable; a network failure keeps them
 * and offers retry. Row problems are announced politely.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { ApiError } from '../../services/api';
import { PLAN_LIMITS, PROGRAM_REFUSALS, programRefusalOf, type PlanTree, type Program } from '../../services/programs';
import type { WeightUnit } from '../../utils/units';
import { ExercisePickerDialog } from '../train/ExercisePickerDialog';
import { StickyActionBar } from './StickyActionBar';
import { WeekEditor } from './WeekEditor';
import { WeekSelector } from './WeekSelector';
import { weekOptions } from './PlanViewer';
import {
  addBlock,
  addExercises,
  addWeek,
  addWorkout,
  allWeeks,
  copyWeek,
  makeDeload,
  moveExercise,
  planErrors,
  removeExercise,
  removeLastWeek,
  removeWorkout,
  setDeload,
  toEditTree,
  toSaveTree,
  updateExercise,
  updateWorkout,
} from './planEdits';

export const STALE_MESSAGE = 'This plan changed elsewhere (for example the coach adjusted it). Reload?';

export interface PlanEditorProps {
  program: Program;
  unit: WeightUnit;
  canCreateExercise: boolean;
  saveStructure: (tree: PlanTree) => Promise<Program>;
  updateName: (name: string) => Promise<Program>;
  /** Discard local state and load the latest version. */
  reload: () => Promise<Program | null>;
  onSaved: (program: Program) => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

function namesOf(program: Program): Record<string, string> {
  const names: Record<string, string> = {};
  for (const block of program.tree.blocks)
    for (const week of block.weeks)
      for (const workout of week.workouts)
        for (const exercise of workout.exercises) if (exercise.exercise) names[exercise.exerciseId] = exercise.exercise.name;
  return names;
}

function issuesOf(error: ApiError): string[] {
  const issues = (error.details as { issues?: Array<{ path?: string; message?: string }> } | undefined)?.issues;
  return Array.isArray(issues) ? issues.map((i) => i.message ?? '').filter(Boolean) : [];
}

export function PlanEditor({
  program,
  unit,
  canCreateExercise,
  saveStructure,
  updateName,
  reload,
  onSaved,
  onCancel,
  onDirtyChange,
}: PlanEditorProps) {
  const initial = useMemo(() => toEditTree(program.tree), [program.tree]);
  const [tree, setTree] = useState<PlanTree>(initial);
  const [name, setName] = useState(program.name);
  const [names, setNames] = useState<Record<string, string>>(() => namesOf(program));
  const [weekNumber, setWeekNumber] = useState(() => allWeeks(initial)[0]?.week.weekNumber ?? 1);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [copyTo, setCopyTo] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; issues: string[]; retry: boolean } | null>(null);
  const [staleOpen, setStaleOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const dirty = useMemo(
    () => JSON.stringify(toSaveTree(tree)) !== JSON.stringify(toSaveTree(initial)) || name.trim() !== program.name,
    [initial, name, program.name, tree],
  );
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const errors = useMemo(() => planErrors(tree), [tree]);
  const errorList = Object.values(errors);
  const nameError = !name.trim() ? 'Name the plan.' : name.length > PLAN_LIMITS.nameMax ? `At most ${PLAN_LIMITS.nameMax} characters.` : null;
  const weeks = weekOptions(tree);
  const week = allWeeks(tree).find((w) => w.week.weekNumber === weekNumber)?.week ?? allWeeks(tree)[0]?.week;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Content first (If-Match guards it); the name is a header field.
      let saved = await saveStructure(toSaveTree(tree));
      if (name.trim() !== saved.name) saved = await updateName(name.trim());
      onSaved(saved);
    } catch (err) {
      if (programRefusalOf(err) === PROGRAM_REFUSALS.STALE_PLAN) {
        setStaleOpen(true);
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setSaveError({ message: err.message || 'The plan could not be saved.', issues: issuesOf(err), retry: false });
      } else {
        setSaveError({
          message: 'The plan could not be saved. Your edits are kept here; check your connection and try again.',
          issues: [],
          retry: true,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const editsJson = JSON.stringify({ name, tree: toSaveTree(tree) }, null, 2);
  const copyEdits = async () => {
    try {
      await navigator.clipboard.writeText(editsJson);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Box>
      <TextField
        label="Plan name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={!!nameError}
        helperText={nameError ?? ' '}
        fullWidth
        sx={{ mb: 2 }}
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ mb: 2, flexWrap: 'wrap' }}>
        <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setTree((t) => addWeek(t))} sx={{ minHeight: 44 }}>
          Add week
        </Button>
        <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setTree((t) => addBlock(t))} sx={{ minHeight: 44 }}>
          Add block
        </Button>
        <Button
          variant="outlined"
          color="error"
          onClick={() => setTree((t) => removeLastWeek(t))}
          disabled={weeks.length <= 1}
          sx={{ minHeight: 44 }}
        >
          Remove last week
        </Button>
      </Stack>

      {week && (
        <>
          <WeekSelector weeks={weeks} value={week.weekNumber} onChange={setWeekNumber} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ my: 2, alignItems: { sm: 'center' }, flexWrap: 'wrap' }}>
            <TextField
              select
              size="small"
              label={`Copy week ${week.weekNumber} to`}
              value={copyTo}
              onChange={(e) => setCopyTo(Number(e.target.value))}
              sx={{ minWidth: 180 }}
            >
              {weeks
                .filter((w) => w.weekNumber !== week.weekNumber)
                .map((w) => (
                  <MenuItem key={w.weekNumber} value={w.weekNumber}>
                    Week {w.weekNumber}
                  </MenuItem>
                ))}
            </TextField>
            <Button
              onClick={() => {
                if (copyTo !== '') setTree((t) => copyWeek(t, week.weekNumber, copyTo));
                setCopyTo('');
              }}
              disabled={copyTo === ''}
              sx={{ minHeight: 44 }}
            >
              Copy
            </Button>
            {week.isDeload ? (
              <Button onClick={() => setTree((t) => setDeload(t, week.weekNumber, false))} sx={{ minHeight: 44 }}>
                Not a deload week
              </Button>
            ) : (
              <Button onClick={() => setTree((t) => makeDeload(t, week.weekNumber))} sx={{ minHeight: 44 }}>
                Make week {week.weekNumber} a deload
              </Button>
            )}
          </Stack>
          <WeekEditor
            week={week}
            names={names}
            unit={unit}
            errors={errors}
            onExerciseChange={(wid, eid, patch) => setTree((t) => updateExercise(t, week.weekNumber, wid, eid, patch))}
            onMoveExercise={(wid, eid, delta) => setTree((t) => moveExercise(t, week.weekNumber, wid, eid, delta))}
            onRemoveExercise={(wid, eid) => setTree((t) => removeExercise(t, week.weekNumber, wid, eid))}
            onAddExercise={(wid) => setPickerFor(wid)}
            onWorkoutChange={(wid, patch) => setTree((t) => updateWorkout(t, week.weekNumber, wid, patch))}
            onRemoveWorkout={(wid) => setTree((t) => removeWorkout(t, week.weekNumber, wid))}
            onAddWorkout={() => setTree((t) => addWorkout(t, week.weekNumber))}
          />
        </>
      )}

      <Box aria-live="polite" role="status" sx={{ mt: 2 }} data-testid="editor-problems">
        {errorList.length > 0 && (
          <Alert severity="warning">
            {errorList.length} problem{errorList.length === 1 ? '' : 's'} to fix before saving: {errorList.slice(0, 3).join(' ')}
          </Alert>
        )}
      </Box>
      {saveError && (
        <Alert
          severity="error"
          sx={{ mt: 2 }}
          action={
            saveError.retry ? (
              <Button color="inherit" size="small" onClick={() => void save()}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {saveError.message}
          {saveError.issues.length > 0 && (
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {saveError.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </Box>
          )}
        </Alert>
      )}

      <StickyActionBar label="Editor actions">
        <Button onClick={onCancel} disabled={saving} sx={{ minHeight: 44 }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void save()}
          disabled={saving || !dirty || errorList.length > 0 || !!nameError}
          sx={{ minHeight: 44 }}
          data-testid="plan-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </StickyActionBar>

      <ExercisePickerDialog
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        gym={program.gym}
        canCreate={canCreateExercise}
        onAdd={async (ids, picked) => {
          if (pickerFor && week) {
            setNames((n) => ({ ...n, ...picked }));
            setTree((t) => addExercises(t, week.weekNumber, pickerFor, ids));
          }
        }}
      />

      <Dialog open={staleOpen} onClose={() => setStaleOpen(false)} aria-labelledby="stale-title" maxWidth="sm" fullWidth>
        <DialogTitle id="stale-title">Plan changed</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>{STALE_MESSAGE}</DialogContentText>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Reloading replaces your edits with the latest version. Copy them first if you want to keep them.
          </Typography>
          <TextField
            label="Your edits"
            value={editsJson}
            multiline
            minRows={3}
            maxRows={8}
            fullWidth
            slotProps={{ htmlInput: { readOnly: true } }}
          />
          {copied && (
            <Typography variant="body2" color="success.main" sx={{ mt: 1 }}>
              Copied.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void copyEdits()}>Copy my edits</Button>
          <Button onClick={() => setStaleOpen(false)}>Keep editing</Button>
          <Button
            variant="contained"
            onClick={async () => {
              setStaleOpen(false);
              const fresh = await reload();
              if (fresh) {
                // Start over from the latest version.
                setTree(toEditTree(fresh.tree));
                setName(fresh.name);
                setNames(namesOf(fresh));
                setSaveError(null);
              }
            }}
          >
            Reload
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default PlanEditor;
