/**
 * The agents a run will use: one row per role with its model, reasoning
 * effort and whose key pays, or its blocking state and who can fix it.
 * Renders the API's role resolution; decides nothing. Models are an
 * administrator's choice (#173), so a row offers no way to change one.
 */
import { Alert, Box, Link, List, ListItem, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { RoleResolution, TrainingModelsView } from '../../services/trainingAgents';
import type { TrainingAgentRole } from '../../types';
import { ROLE_LABEL, blockerFor } from '../../hooks/useTrainingAvailability';
import { usePermissions } from '../../hooks/usePermissions';
import { KEY_SOURCE_PHRASE } from './RoleStateBanner';

const READY_STATES = new Set(['ready', 'auto']);

export interface RoleSummaryProps {
  models: TrainingModelsView;
  roles: TrainingAgentRole[];
}

function RoleRow({ resolution }: { resolution: RoleResolution }) {
  const { hasPermission } = usePermissions();
  const ready = READY_STATES.has(resolution.state) && resolution.model;
  const blocker = ready
    ? null
    : blockerFor(resolution.role, resolution.state, {
        fix: resolution.fix,
        canAssign: hasPermission('ai_config:write'),
      });
  return (
    <ListItem disableGutters sx={{ display: 'block', py: 1 }} data-testid={`role-row-${resolution.role}`}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }} useFlexGap>
        <Typography component="span" sx={{ fontWeight: 600 }}>
          {ROLE_LABEL[resolution.role]}
        </Typography>
        {ready && resolution.model && (
          <Typography component="span" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {resolution.model.displayName || resolution.model.modelId}
            {resolution.effectiveEffort ? `, ${resolution.effectiveEffort} effort` : ''}
            {`, ${KEY_SOURCE_PHRASE[resolution.model.keySource] ?? 'your key'}`}
          </Typography>
        )}
      </Stack>
      {blocker && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {blocker.message}{' '}
          {blocker.fix && (
            <Link component={RouterLink} to={blocker.fix.to}>
              {blocker.fix.label}
            </Link>
          )}
        </Alert>
      )}
    </ListItem>
  );
}

export function RoleSummary({ models, roles }: RoleSummaryProps) {
  return (
    <Box>
      <List dense disablePadding aria-label="Agents">
        {roles.map((role) => (
          <RoleRow key={role} resolution={models.roles[role]} />
        ))}
      </List>
    </Box>
  );
}

export default RoleSummary;
