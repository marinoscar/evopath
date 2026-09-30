/**
 * A getting-started checklist — issue #203.
 *
 * Presentation only: every step's status comes from `GET /api/onboarding`,
 * which derives it from real data. Nothing here can tick a step.
 *
 * Accessibility:
 *   - a real list (`<ul>`/`<li>`), one per group, each labelled by its subheader;
 *   - each step's status is a WORD ("Done" / "To do") beside an icon, never
 *     colour alone;
 *   - progress is visible text ("2 of 4 done") plus a determinate
 *     `LinearProgress` carrying `aria-label` and `aria-valuetext`;
 *   - a to-do step is a link to the page where it is done, with the API's
 *     `detail` as secondary text.
 */
import { useId } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type { OnboardingStep } from '../../types';

export interface OnboardingChecklistProps {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  /** Accessible name of the progress bar and of an ungrouped list. */
  label?: string;
  /** Split the steps under `Required` / `Optional features` subheaders. */
  grouped?: boolean;
  /** Called when a to-do step's link is followed (e.g. to close a surrounding dialog). */
  onNavigate?: () => void;
}

const GROUP_LABEL: Record<'required' | 'features', string> = {
  required: 'Required',
  features: 'Optional features',
};

function StepRow({ step, onNavigate }: { step: OnboardingStep; onNavigate?: () => void }) {
  const done = step.status === 'done';
  const statusWord = done ? 'Done' : 'To do';
  const secondary = (
    <>
      <Box component="span" sx={{ fontWeight: 500, color: done ? 'success.main' : 'text.secondary' }}>
        {statusWord}
      </Box>
      {!done && step.detail ? <Box component="span">{` · ${step.detail}`}</Box> : null}
    </>
  );
  const icon = (
    <ListItemIcon sx={{ minWidth: 40 }}>
      {done ? (
        <CheckCircleIcon color="success" aria-hidden />
      ) : (
        <RadioButtonUncheckedIcon color="action" aria-hidden />
      )}
    </ListItemIcon>
  );
  const text = (
    <ListItemText
      primary={step.label}
      secondary={secondary}
      slotProps={{
        primary: { sx: done ? { color: 'text.secondary' } : undefined },
      }}
    />
  );

  if (done) {
    return (
      <ListItem data-testid={`onboarding-step-${step.id}`} data-status="done">
        {icon}
        {text}
      </ListItem>
    );
  }

  return (
    <ListItem disablePadding data-testid={`onboarding-step-${step.id}`} data-status="todo">
      <ListItemButton component={RouterLink} to={step.href} onClick={onNavigate} sx={{ minHeight: 48 }}>
        {icon}
        {text}
        <ChevronRightIcon color="action" aria-hidden />
      </ListItemButton>
    </ListItem>
  );
}

export function OnboardingChecklist({
  steps,
  completed,
  total,
  label = 'Getting started',
  grouped = false,
  onNavigate,
}: OnboardingChecklistProps) {
  const baseId = useId();
  const progressText = `${completed} of ${total} done`;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  type Group = { key: string; label: string | null; steps: OnboardingStep[] };
  const groups: Group[] = grouped
    ? [
        ...(['required', 'features'] as const).map<Group>((key) => ({
          key,
          label: GROUP_LABEL[key],
          steps: steps.filter((s) => s.group === key),
        })),
        { key: 'other', label: null, steps: steps.filter((s) => s.group === null) },
      ].filter((g) => g.steps.length > 0)
    : [{ key: 'all', label: null, steps }];

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }} data-testid="onboarding-progress-text">
        {progressText}
      </Typography>
      <LinearProgress
        variant="determinate"
        value={percent}
        aria-label={`${label} progress`}
        aria-valuetext={progressText}
        sx={{ mb: 1, height: 6, borderRadius: 3 }}
      />
      {groups.map((group) => {
        const headerId = `${baseId}-${group.key}`;
        return (
          <List
            key={group.key}
            aria-labelledby={group.label ? headerId : undefined}
            aria-label={group.label ? undefined : label}
            subheader={
              group.label ? (
                <ListSubheader id={headerId} component="div" disableSticky sx={{ px: 0, bgcolor: 'transparent' }}>
                  {group.label}
                </ListSubheader>
              ) : undefined
            }
          >
            {group.steps.map((step) => (
              <StepRow key={step.id} step={step} onNavigate={onNavigate} />
            ))}
          </List>
        );
      })}
    </Box>
  );
}

export default OnboardingChecklist;
