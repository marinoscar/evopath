/**
 * One training agent role: what it does, and the model and reasoning effort
 * it will use — READ-ONLY (#173).
 *
 * Every model and effort is an administrator's choice
 * (`/admin/settings/ai/assignments`); this card shows what the API resolved
 * for the caller (`GET /api/ai/training/models`): the model, who chose it,
 * the effort that will be sent, and where requests go. A blocking state names
 * who can fix it. Nothing here writes.
 */
import { Box, Card, CardContent, Stack, Typography } from '@mui/material';
import type { RoleResolution } from '../../services/trainingAgents';
import type { TrainingAgentRole } from '../../types';
import { RoleStateBanner } from './RoleStateBanner';

export const TRAINING_ROLE_COPY: Record<TrainingAgentRole, { title: string; job: string }> = {
  researcher: {
    title: 'Researcher',
    job: 'Searches the web for current evidence that bears on your goals.',
  },
  planner: {
    title: 'Planner',
    job: 'Drafts your training plan from your goals, history and the research.',
  },
  critic: {
    title: 'Critic',
    job: 'Reviews each draft for safety and fit and asks for revisions.',
  },
  evaluator: {
    title: 'Evaluator',
    job: 'Checks how the plan is going against your logged training.',
  },
};

/** Whose key a request is sent with, as the "where data goes" line says it. */
const DATA_KEY_PHRASE: Record<string, string> = {
  user: 'your key',
  org: 'the organisation key',
  none: 'no key (keyless server)',
};

function effortLine(resolution: RoleResolution): string | null {
  if (!resolution.model) return null;
  if (resolution.effortNote === 'model_has_no_reasoning' || resolution.effectiveEffort === null) {
    return 'This model has no adjustable reasoning.';
  }
  return `Reasoning effort: ${resolution.effectiveEffort}`;
}

export interface AgentModelCardProps {
  role: TrainingAgentRole;
  resolution: RoleResolution | undefined;
  providerNames: Record<string, string>;
}

export function AgentModelCard({ role, resolution, providerNames }: AgentModelCardProps) {
  const copy = TRAINING_ROLE_COPY[role];
  const titleId = `agent-${role}-title`;
  const using = resolution?.model;
  const effort = resolution ? effortLine(resolution) : null;

  return (
    <Card component="section" aria-labelledby={titleId} data-testid={`agent-card-${role}`}>
      <CardContent>
        <Typography id={titleId} variant="h6" component="h2" gutterBottom>
          {copy.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {copy.job}
        </Typography>

        <Stack spacing={1.5}>
          {resolution && <RoleStateBanner resolution={resolution} />}

          {using && (
            <Box>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                Model: {using.displayName || using.modelId} ({providerNames[using.provider] ?? using.provider})
              </Typography>
              {effort && <Typography variant="body2">{effort}</Typography>}
              <Typography variant="body2" color="text.secondary">
                Requests for this agent go to {providerNames[using.provider] ?? using.provider} using{' '}
                {DATA_KEY_PHRASE[using.keySource] ?? 'your key'}.
              </Typography>
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

export default AgentModelCard;
