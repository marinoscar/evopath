/**
 * One training agent role's state, in words a user can act on.
 *
 * Renders the API's `RoleResolution` (`GET /api/ai/training/models`): which
 * model the role will use and whose key pays, or why it cannot run and where to
 * go to fix it. Presentation only; the API resolved the state.
 */
import { Alert, Box, Link, List, ListItem, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { RoleResolution } from '../../services/trainingAgents';

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
  const { state, role } = resolution;

  switch (state) {
    case 'ready':
      return (
        <Alert severity="success">
          Using {modelName(resolution)} ({keyPhrase(resolution)})
        </Alert>
      );
    case 'auto':
      return (
        <Alert severity="info">
          Using {modelName(resolution)} (chosen automatically). Choose one below.
        </Alert>
      );
    case 'stale_preference':
      return (
        <Alert severity="warning">
          Your saved model is no longer available. Using {modelName(resolution)}.
        </Alert>
      );
    case 'no_key':
      return (
        <Alert severity="warning">
          <Link component={RouterLink} to="/settings/ai">
            Add an AI key to use this
          </Link>
        </Alert>
      );
    case 'no_models':
      return (
        <Alert severity="warning">
          No enabled model is available. Ask an administrator or add a key.
        </Alert>
      );
    case 'missing_capability':
      return (
        <Alert severity="warning">
          {role === 'researcher'
            ? 'None of your models can search the web. Web search needs an OpenAI model that supports hosted tools.'
            : 'None of your models support structured output.'}
          {resolution.candidates && resolution.candidates.length > 0 && (
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
    case 'web_search_disabled':
      return (
        <Alert severity="warning">
          Web search is switched off for this deployment. An administrator can turn it on at Admin,
          AI, Hosted tools, Web search.
        </Alert>
      );
    case 'ai_disabled':
      return <Alert severity="warning">AI is switched off for this deployment.</Alert>;
    default:
      return null;
  }
}

export function RoleStateBanner({ resolution }: RoleStateBannerProps) {
  const staleBlocked = resolution.stalePreference && resolution.state !== 'stale_preference';

  return (
    <Stack spacing={1}>
      {staleBlocked && (
        <Alert severity="warning">
          Your saved model ({resolution.stalePreference?.modelId}) is no longer available.
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
