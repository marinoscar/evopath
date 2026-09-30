/**
 * Which models will adapt and review the workout (the planner and the
 * critic, from the E5.2 resolver), or why one cannot run, with the link that
 * fixes it. Models are an administrator's choice (#173): nothing here lets a
 * user pick one. A key is the only fix a user makes (Settings, AI Keys); an
 * administrator's fix links an AI administrator (`ai_config:write`) to the
 * assignments page. The copy is the shared `blockerFor`, so it matches the
 * plan wizard. Presentation only: the API resolved every state.
 */
import { Alert, Box, Link, Skeleton, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { AdaptationRoleModel } from '../../../services/trainingAdaptation';
import { blockerFor, ROLE_LABEL, type TrainingBlocker } from '../../../hooks/useTrainingAvailability';
import { usePermissions } from '../../../hooks/usePermissions';

export interface RoleModelBannerProps {
  /** null while loading. */
  models: { planner: AdaptationRoleModel; critic: AdaptationRoleModel } | null;
}

export interface RoleProblemOptions {
  /** The caller holds `ai_config:write`: link an administrator's fix to the assignments page. */
  canAssign?: boolean;
}

/** The blocking state in words, and where to fix it (null when the role can run). */
export function roleProblem(role: AdaptationRoleModel, { canAssign = false }: RoleProblemOptions = {}): TrainingBlocker | null {
  if (role.runnable) return null;
  return blockerFor(role.role, role.state, { fix: role.fix, canAssign });
}

function modelName(role: AdaptationRoleModel): string {
  return role.model?.displayName || role.model?.modelId || 'automatic';
}

export function RoleModelBanner({ models }: RoleModelBannerProps) {
  const { hasPermission } = usePermissions();
  if (!models) {
    return <Skeleton variant="text" width="60%" data-testid="role-model-banner-loading" />;
  }
  const canAssign = hasPermission('ai_config:write');
  const roles = [models.planner, models.critic];
  const problems = roles.map((role) => ({ role, problem: roleProblem(role, { canAssign }) })).filter((entry) => entry.problem);

  return (
    <Box data-testid="role-model-banner">
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {roles.map((role) => `${ROLE_LABEL[role.role]}: ${role.runnable ? modelName(role) : 'unavailable'}`).join(' · ')}
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
    </Box>
  );
}

export default RoleModelBanner;
