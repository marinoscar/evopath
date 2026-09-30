/**
 * Settings → Training agents (`/settings/ai/agents`).
 *
 * The model and reasoning effort for each training-plan agent (researcher,
 * planner, critic, evaluator), each role's state as the API resolves it, and
 * the run limits with a token estimate.
 *
 * A THIN PAGE WRAPPER, like `UserAiKeysPage`. The choices live in the user
 * settings document (`ai.taskModels`, `ai.training`) and are saved through
 * `useUserSettings` (PATCH `/api/user-settings`, `If-Match` on the loaded
 * version); the API merges them field by field, so a save here never drops
 * the default model saved at `/settings/ai`, and the reverse. The role states
 * come from `GET /api/ai/training/models` and are re-read after every save.
 *
 * Reachability is gated outside this file: the route wraps it in
 * `RequirePermission('ai:use')` and `RequireAiEnabled`, and the registry card
 * is feature-gated on AI. The `ai:use` re-check below is defence in depth.
 */
import { Alert, Box, CircularProgress, Container, Stack, Typography } from '@mui/material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { useAiConfig } from '../hooks/useAiConfig';
import { useAgentModels } from '../hooks/useAgentModels';
import { useUsableAiModels } from '../hooks/useUsableAiModels';
import { useUserSettings } from '../hooks/useUserSettings';
import { AgentModelCard } from '../components/training/AgentModelCard';
import { TrainingRunLimits } from '../components/training/TrainingRunLimits';
import { TRAINING_AGENT_ROLES } from '../services/trainingAgents';
import type { AiTaskModel, TrainingAgentRole } from '../types';

export default function UserAgentModelsPage() {
  const { hasPermission } = usePermissions();
  const { config } = useAiConfig();
  const usable = useUsableAiModels();
  const agents = useAgentModels();
  // `syncTheme: false`: this page never edits the theme.
  const { settings, isLoading: settingsLoading, error: settingsError, updateSettings } =
    useUserSettings({ syncTheme: false });
  const refreshAgents = agents.refresh;

  if (!hasPermission('ai:use')) {
    return <Navigate to="/" replace />;
  }

  const providerNames = Object.fromEntries(
    config.providers.map((provider) => [provider.id, provider.displayName]),
  );

  const saveRole = async (role: TrainingAgentRole, next: AiTaskModel | null) => {
    await updateSettings({ ai: { taskModels: { [role]: next } } });
    await refreshAgents();
  };

  const saveLimits = async (next: { maxRunTokens: number | null; maxCriticRounds: 1 | 2 | 3 }) => {
    await updateSettings({ ai: { training: next } });
    await refreshAgents();
  };

  const loading = usable.isLoading || agents.isLoading || settingsLoading;
  const formDisabled = !settings;

  return (
    <Container maxWidth="md">
      <Box sx={{ py: { xs: 2, md: 4 } }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Training agents
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Your training plan is written by four agents. Choose the model and reasoning effort each
          one uses, and cap what a run may spend.
        </Typography>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress aria-label="Loading training agents" />
          </Box>
        ) : (
          <Stack spacing={3}>
            {agents.error && <Alert severity="error">{agents.error}</Alert>}
            {usable.error && <Alert severity="error">{usable.error}</Alert>}
            {settingsError && <Alert severity="error">{settingsError}</Alert>}

            {TRAINING_AGENT_ROLES.map((role) => (
              <AgentModelCard
                key={role}
                role={role}
                resolution={agents.view?.roles[role]}
                models={usable.models}
                value={settings?.ai?.taskModels?.[role]}
                onSave={(next) => saveRole(role, next)}
                providerNames={providerNames}
                disabled={formDisabled}
              />
            ))}

            <TrainingRunLimits
              value={settings?.ai?.training}
              limits={agents.view?.limits}
              estimate={agents.estimate}
              estimateError={agents.estimateError}
              onSave={saveLimits}
              disabled={formDisabled}
            />
          </Stack>
        )}
      </Box>
    </Container>
  );
}
