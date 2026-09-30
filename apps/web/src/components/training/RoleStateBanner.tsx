/**
 * One training agent role's state, in words a user can act on.
 *
 * Renders the API's `RoleResolution` (`GET /api/ai/training/models`): which
 * model the role will use, who chose it (an administrator, or the automatic
 * pick when nothing assigned applies) and whose key pays; or why it cannot
 * run and who can fix it. Users never choose a model (#173), so no state
 * sends them to pick one: a key is the only fix a user can make, and an AI
 * administrator (`ai_config:write`) is linked to the assignments page.
 * Presentation only; the API resolved the state.
 */
import { Alert, Box, Link, List, ListItem, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { RoleResolution } from '../../services/trainingAgents';
import { blockerFor } from '../../hooks/useTrainingAvailability';
import { usePermissions } from '../../hooks/usePermissions';

/** Whose key pays, as the banner says it. */
export const KEY_SOURCE_PHRASE: Record<string, string> = {
  user: 'your key',
  org: 'organisation key',
  none: 'no key needed',
};

export interface RoleStateBannerProps {
  resolution: RoleResolution;
}

function modelName(resolution: RoleResolution): string {
  return resolution.model?.displayName || resolution.model?.modelId || 'a model';
}

function keyPhrase(resolution: RoleResolution): string {
  return KEY_SOURCE_PHRASE[resolution.model?.keySource ?? 'user'] ?? 'your key';
}

function StateAlert({ resolution }: RoleStateBannerProps) {
  const { hasPermission } = usePermissions();
  const { state, role } = resolution;

  if (state === 'ready' && resolution.model) {
    return (
      <Alert severity="success">
        Using {modelName(resolution)} ({keyPhrase(resolution)}). Chosen by your administrator.
      </Alert>
    );
  }
  if (state === 'auto' && resolution.model) {
    return (
      <Alert severity="info">
        Using {modelName(resolution)} ({keyPhrase(resolution)}). Chosen automatically: your administrator
        hasn&apos;t assigned a model for this agent.
      </Alert>
    );
  }

  const blocker = blockerFor(role, state, { fix: resolution.fix, canAssign: hasPermission('ai_config:write') });
  return (
    <Alert severity="warning">
      {blocker.message}
      {blocker.fix && (
        <>
          {' '}
          <Link component={RouterLink} to={blocker.fix.to}>
            {blocker.fix.label}
          </Link>
        </>
      )}
      {state === 'missing_capability' && resolution.candidates && resolution.candidates.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2">Models that would work:</Typography>
          <List dense disablePadding aria-label="Models that would work">
            {resolution.candidates.map((candidate) => (
              <ListItem key={`${candidate.provider}:${candidate.modelId}`} disableGutters sx={{ py: 0 }}>
                {candidate.displayName || candidate.modelId} ({candidate.provider}
                {candidate.enabled ? '' : ', not enabled by an administrator'})
              </ListItem>
            ))}
          </List>
        </Box>
      )}
    </Alert>
  );
}

export function RoleStateBanner({ resolution }: RoleStateBannerProps) {
  const runnable = resolution.state === 'ready' || resolution.state === 'auto';
  return (
    <Stack spacing={1}>
      {runnable && resolution.assignmentUnavailable && (
        <Alert severity="info">
          Your administrator&apos;s choice ({resolution.assignmentUnavailable.modelId}) isn&apos;t available with your
          keys, so another model is used.
        </Alert>
      )}
      <StateAlert resolution={resolution} />
      {resolution.effortNote === 'clamped' && resolution.effectiveEffort && (
        <Alert severity="info">
          This model offers up to {resolution.effectiveEffort}; using that.
        </Alert>
      )}
    </Stack>
  );
}

export default RoleStateBanner;
