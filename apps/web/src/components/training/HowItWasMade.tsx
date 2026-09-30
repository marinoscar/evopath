/** "How it was made": the models and efforts, critic rounds, tokens and warnings from the version `meta`. */
import { Box, List, ListItem, Typography } from '@mui/material';
import { ROLE_LABEL } from '../../hooks/useTrainingAvailability';
import type { TrainingAgentRole } from '../../types';
import { warningText } from './planLabels';

interface MetaModel {
  provider?: string;
  modelId?: string;
  effort?: string | null;
}

export function hasMadeMeta(meta: Record<string, unknown> | null | undefined): boolean {
  return !!meta && !!meta.models && typeof meta.models === 'object' && Object.keys(meta.models as object).length > 0;
}

export function HowItWasMade({ meta }: { meta: Record<string, unknown> }) {
  const models = (meta.models ?? {}) as Record<string, MetaModel>;
  const tokens = meta.tokens as { inputTokens?: number; outputTokens?: number } | undefined;
  const total = tokens ? (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) : null;
  const warnings = Array.isArray(meta.warnings) ? meta.warnings.filter((w): w is string => typeof w === 'string') : [];
  const rounds = typeof meta.criticRounds === 'number' ? meta.criticRounds : null;
  return (
    <Box>
      <List dense disablePadding aria-label="Agents that made this plan">
        {Object.entries(models).map(([role, model]) => (
          <ListItem key={role} disableGutters sx={{ py: 0.25 }}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {ROLE_LABEL[role as TrainingAgentRole] ?? role}: {model.modelId ?? 'unknown model'}
              {model.provider ? ` (${model.provider})` : ''}
              {model.effort ? `, ${model.effort} effort` : ''}
            </Typography>
          </ListItem>
        ))}
      </List>
      {rounds !== null && (
        <Typography variant="body2">
          {rounds} critic round{rounds === 1 ? '' : 's'}
        </Typography>
      )}
      {total !== null && <Typography variant="body2">{total.toLocaleString('en-US')} tokens</Typography>}
      {warnings.map((w) => (
        <Typography key={w} variant="body2" color="warning.main">
          {warningText(w)}
        </Typography>
      ))}
    </Box>
  );
}

export default HowItWasMade;
