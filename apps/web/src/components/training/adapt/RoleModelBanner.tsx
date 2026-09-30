/**
 * Which models will adapt and review the workout (the planner and the
 * critic, from the E5.2 resolver), or why one cannot run, with the link that
 * fixes it. Presentation only: the API resolved every state.
 */
import { Alert, Box, Link, Skeleton, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { AdaptationRoleModel } from '../../../services/trainingAdaptation';
import { AGENT_SETTINGS_PATH, ROLE_LABEL } from '../../../hooks/useTrainingAvailability';

export const AI_KEYS_SETTINGS_PATH = '/settings/ai';

export interface RoleModelBannerProps {
  /** null while loading. */
  models: { planner: AdaptationRoleModel; critic: AdaptationRoleModel } | null;
}

/** The blocking state in words, and where to fix it. */
export function roleProblem(role: AdaptationRoleModel): { message: string; fix: { label: string; to: string } | null } | null {
  if (role.runnable) return null;
  const who = ROLE_LABEL[role.role];
  const fixLink =
    role.fix === 'keys'
      ? { label: 'Add an AI key', to: AI_KEYS_SETTINGS_PATH }
      : role.fix === 'settings'
        ? { label: 'Choose a model', to: AGENT_SETTINGS_PATH }
        : null;
  switch (role.state) {
    case 'no_key':
      return { message: `${who}: add an AI key to use this.`, fix: { label: 'Add an AI key', to: AI_KEYS_SETTINGS_PATH } };
    case 'missing_capability':
      return {
        message: `${who}: this model can't return structured output.`,
        fix: { label: 'Choose a model', to: AGENT_SETTINGS_PATH },
      };
    case 'no_models':
      return { message: `${who}: model disabled by your administrator.`, fix: fixLink };
    case 'ai_disabled':
      return { message: 'AI is switched off for this app.', fix: null };
    default:
      return { message: `${who} can't run right now.`, fix: fixLink ?? { label: 'Check the agents', to: AGENT_SETTINGS_PATH } };
  }
}

function modelName(role: AdaptationRoleModel): string {
  return role.model?.displayName || role.model?.modelId || 'automatic';
}

export function RoleModelBanner({ models }: RoleModelBannerProps) {
  if (!models) {
    return <Skeleton variant="text" width="60%" data-testid="role-model-banner-loading" />;
  }
  const roles = [models.planner, models.critic];
  const problems = roles.map((role) => ({ role, problem: roleProblem(role) })).filter((entry) => entry.problem);

  return (
    <Box data-testid="role-model-banner">
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {roles.map((role) => `${ROLE_LABEL[role.role]}: ${role.runnable ? modelName(role) : 'unavailable'}`).join(' · ')}{' '}
        <Link component={RouterLink} to={AGENT_SETTINGS_PATH}>
          Change
        </Link>
      </Typography>
      {problems.map(({ role, problem }) => (
        <Alert
          key={role.role}
          severity="warning"
          sx={{ mt: 1 }}
          data-testid={`role-problem-${role.role}`}
        >
          {problem!.message}{' '}
          {problem!.fix && (
            <Link component={RouterLink} to={problem!.fix.to}>
              {problem!.fix.label}
            </Link>
          )}
        </Alert>
      ))}
      {roles.some((role) => role.state === 'stale_preference') && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          A saved model is no longer available; another one is used instead.
        </Typography>
      )}
    </Box>
  );
}

export default RoleModelBanner;
