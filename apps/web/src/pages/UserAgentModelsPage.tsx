/**
 * Settings → Training agents (`/settings/ai/agents`).
 *
 * The model and reasoning effort each training-plan agent (researcher,
 * planner, critic, evaluator) will use, READ-ONLY: every model is an
 * administrator's choice (#173, `/admin/settings/ai/assignments`), resolved
 * for this user by `GET /api/ai/training/models`. What the user still owns is
 * the run limits (token cap, critic rounds), with a token estimate.
 *
 * A THIN PAGE WRAPPER, like `UserAiKeysPage`. The limits live in the user
 * settings document (`ai.training`) and are saved through `useUserSettings`
 * (PATCH `/api/user-settings`, `If-Match` on the loaded version); the role
 * states are re-read after every save.
 *
 * The "Use my health summary in training plans and coach chat" section (H8, #192) sits at the
 * bottom: shown only with `health_data:read` (the GET's permission), its
 * controls enabled only with `health_data:write` (the PUT/POST's). It is a
 * section of this page, not a card or a tab of its own.
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
import { useUserSettings } from '../hooks/useUserSettings';
import { useHealthSummary } from '../hooks/useHealthSummary';
import { AgentModelCard } from '../components/training/AgentModelCard';
import { TrainingRunLimits } from '../components/training/TrainingRunLimits';
import { HealthSummarySection } from '../components/training/HealthSummarySection';
import { TRAINING_AGENT_ROLES } from '../services/trainingAgents';

export default function UserAgentModelsPage() {
  const { hasPermission } = usePermissions();
  const { config } = useAiConfig();
  const agents = useAgentModels();
  // `syncTheme: false`: this page never edits the theme.
  const { settings, isLoading: settingsLoading, error: settingsError, updateSettings } =
    useUserSettings({ syncTheme: false });
  const refreshAgents = agents.refresh;
  const canReadHealth = hasPermission('health_data:read');
  const healthSummary = useHealthSummary({ enabled: canReadHealth });

  if (!hasPermission('ai:use')) {
    return <Navigate to="/" replace />;
  }

  const providerNames = Object.fromEntries(
    config.providers.map((provider) => [provider.id, provider.displayName]),
  );

  const saveLimits = async (next: { maxRunTokens: number | null; maxCriticRounds: 1 | 2 | 3 }) => {
    await updateSettings({ ai: { training: next } });
    await refreshAgents();
  };

  const loading = agents.isLoading || settingsLoading;
  const formDisabled = !settings;

  return (
    <Container maxWidth="md">
      <Box sx={{ py: { xs: 2, md: 4 } }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Training agents
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Your training plan is written by four agents. Your administrator chooses the model and
          reasoning effort each one uses; you can cap what a run may spend and choose whether
          they see a summary of your health data.
        </Typography>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress aria-label="Loading training agents" />
          </Box>
        ) : (
          <Stack spacing={3}>
            {agents.error && <Alert severity="error">{agents.error}</Alert>}
            {settingsError && <Alert severity="error">{settingsError}</Alert>}

            {TRAINING_AGENT_ROLES.map((role) => (
              <AgentModelCard
                key={role}
                role={role}
                resolution={agents.view?.roles[role]}
                providerNames={providerNames}
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

            {canReadHealth && (
              <HealthSummarySection
                view={healthSummary.view}
                isLoading={healthSummary.isLoading}
                error={healthSummary.error}
                canWrite={hasPermission('health_data:write')}
                providerNames={providerNames}
                onSetConsent={healthSummary.setConsent}
                onRefresh={healthSummary.refresh}
              />
            )}
          </Stack>
        )}
      </Box>
    </Container>
  );
}
