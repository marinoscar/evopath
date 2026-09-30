/**
 * Tokens per agent (provider, model, whose key) with a running total and the
 * run's cap. Live counts come from `agent.usage` events; the run row's usage
 * fills in for a run that is loaded after the fact.
 */
import { List, ListItem, Typography } from '@mui/material';
import type { TrainingRunView } from '../../services/trainingAgents';
import type { RunViewState } from '../../utils/reduceRunEvents';
import type { TrainingAgentRole } from '../../types';
import { ROLE_LABEL } from '../../hooks/useTrainingAvailability';
import { KEY_SOURCE_PHRASE } from './RoleStateBanner';

const ROLES: TrainingAgentRole[] = ['researcher', 'planner', 'critic', 'evaluator'];
const fmt = (n: number) => n.toLocaleString('en-US');

export function UsageLine({ view, run }: { view: RunViewState; run: TrainingRunView | null }) {
  const rows = ROLES.map((role) => {
    const live = view.usage[role];
    const stored = run?.usage.byRole[role];
    const model = run?.roleModels[role];
    const tokens = live
      ? live.inputTokens + live.outputTokens
      : stored
        ? stored.inputTokens + stored.outputTokens
        : 0;
    if (!live && !stored) return null;
    return {
      role,
      tokens,
      provider: live?.provider || model?.provider || '',
      model: live?.model || model?.modelId || '',
      keySource: model?.keySource,
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null);

  const liveTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
  const storedTotal = run ? run.usage.total.inputTokens + run.usage.total.outputTokens : 0;
  const total = Math.max(liveTotal, storedTotal);

  return (
    <>
      {rows.length === 0 ? (
        <Typography color="text.secondary">No tokens used yet.</Typography>
      ) : (
        <List dense disablePadding aria-label="Usage by agent">
          {rows.map((row) => (
            <ListItem key={row.role} disableGutters sx={{ py: 0.25 }} data-testid={`usage-${row.role}`}>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {ROLE_LABEL[row.role]}: {fmt(row.tokens)} tokens
                {row.model ? ` on ${row.provider ? `${row.provider} ` : ''}${row.model}` : ''}
                {row.keySource ? ` (${KEY_SOURCE_PHRASE[row.keySource] ?? row.keySource})` : ''}
              </Typography>
            </ListItem>
          ))}
        </List>
      )}
      <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 600 }} data-testid="usage-total">
        Total {fmt(total)} of {fmt(run?.tokenCap ?? 0)} tokens
      </Typography>
    </>
  );
}

export default UsageLine;
