/**
 * The run's stages: Context, Research, Plan, Guardrails, Critique (with the
 * round), Ready. The current stage says which agent works and on which
 * model. The sentence is announced politely; the spinner stops under
 * `prefers-reduced-motion`.
 */
import { Box, CircularProgress, Typography } from '@mui/material';
import {
  CheckCircle as DoneIcon,
  RadioButtonUnchecked as PendingIcon,
} from '@mui/icons-material';
import type { TrainingRunView } from '../../services/trainingAgents';
import { RUN_STAGES, STAGE_ROLE, type RunStage, type RunViewState } from '../../utils/reduceRunEvents';
import { ROLE_LABEL } from '../../hooks/useTrainingAvailability';

export const STAGE_LABEL: Record<RunStage, string> = {
  context: 'Context',
  research: 'Research',
  plan: 'Plan',
  guardrails: 'Guardrails',
  critique: 'Critique',
  ready: 'Ready',
};

export interface RunStageStepperProps {
  view: RunViewState;
  run: TrainingRunView | null;
  /** The run is still working (a spinner and a sentence are shown). */
  active: boolean;
}

function agentName(stage: RunStage, run: TrainingRunView | null, view: RunViewState): string {
  const role = STAGE_ROLE[stage];
  if (!role) return '';
  const model = view.usage[role]?.model || run?.roleModels[role]?.modelId;
  return model ? `${ROLE_LABEL[role]} (${model})` : ROLE_LABEL[role];
}

/** What is happening now, in one sentence. */
export function activitySentence(view: RunViewState, run: TrainingRunView | null): string {
  switch (view.current) {
    case 'context':
      return 'Gathering your goal, schedule, gym and recent training.';
    case 'research':
      return `${agentName('research', run, view)} is searching the web.`;
    case 'plan':
      return view.drafts.length > 0
        ? `${agentName('plan', run, view)} is revising the plan.`
        : `${agentName('plan', run, view)} is drafting the plan.`;
    case 'guardrails':
      return 'Checking the draft against the safety and equipment rules.';
    case 'critique':
      return `${agentName('critique', run, view)} is reviewing round ${Math.max(1, view.criticRound)}.`;
    case 'ready':
      return 'Saving your plan.';
    default:
      return run?.status === 'queued' || view.status === 'queued' ? 'Waiting for a worker to start the run.' : '';
  }
}

export function RunStageStepper({ view, run, active }: RunStageStepperProps) {
  const sentence = active ? activitySentence(view, run) : '';
  return (
    <Box>
      <Box
        component="ol"
        aria-label="Stages"
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, p: 0, m: 0, listStyle: 'none' }}
      >
        {RUN_STAGES.map((stage) => {
          const state = view.stages[stage];
          const current = active && view.current === stage;
          const label =
            stage === 'critique' && view.criticRound > 0 ? `${STAGE_LABEL[stage]} (round ${view.criticRound})` : STAGE_LABEL[stage];
          return (
            <Box
              component="li"
              key={stage}
              data-testid={`run-stage-${stage}`}
              data-state={state}
              aria-current={current ? 'step' : undefined}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                px: 1,
                py: 0.5,
                borderRadius: 2,
                border: 1,
                borderColor: current ? 'primary.main' : 'divider',
                color: state === 'pending' ? 'text.secondary' : 'text.primary',
              }}
            >
              {state === 'done' ? (
                <DoneIcon fontSize="small" color="success" aria-hidden />
              ) : current ? (
                <CircularProgress
                  size={16}
                  aria-hidden
                  sx={{ '@media (prefers-reduced-motion: reduce)': { animation: 'none', '& circle': { animation: 'none' } } }}
                />
              ) : (
                <PendingIcon fontSize="small" aria-hidden />
              )}
              <Typography variant="body2">
                {label}
                <Box component="span" sx={visuallyHidden}>
                  {state === 'done' ? ', done' : current ? ', in progress' : ', not started'}
                </Box>
              </Typography>
            </Box>
          );
        })}
      </Box>
      <Typography aria-live="polite" role="status" sx={{ mt: 1, minHeight: 24 }} data-testid="run-activity">
        {sentence}
      </Typography>
    </Box>
  );
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export default RunStageStepper;
