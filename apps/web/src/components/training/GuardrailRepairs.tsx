/**
 * The guardrails' report per round: clean, repaired (with the server-authored
 * repair sentences) or blocked.
 */
import { Box, Chip, List, ListItem, Stack, Typography } from '@mui/material';
import type { RunGuardrailReport } from '../../utils/reduceRunEvents';

const STATUS: Record<RunGuardrailReport['status'], { label: string; color: 'success' | 'info' | 'error' }> = {
  clean: { label: 'Clean', color: 'success' },
  repaired: { label: 'Repaired', color: 'info' },
  blocked: { label: 'Blocked', color: 'error' },
};

export function GuardrailRepairs({ reports }: { reports: RunGuardrailReport[] }) {
  if (reports.length === 0) return <Typography color="text.secondary">No checks yet.</Typography>;
  return (
    <Stack spacing={1.5}>
      {reports.map((report) => (
        <Box key={report.round} data-testid="guardrail-round">
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="subtitle2" component="h3">
              Round {report.round}
            </Typography>
            <Chip size="small" label={STATUS[report.status].label} color={STATUS[report.status].color} />
            {report.counts.warn > 0 && (
              <Typography variant="body2" color="text.secondary">
                {report.counts.warn} note{report.counts.warn === 1 ? '' : 's'}
              </Typography>
            )}
          </Stack>
          {report.repairs.length > 0 && (
            <List dense disablePadding aria-label={`Repairs in round ${report.round}`}>
              {report.repairs.map((repair, i) => (
                <ListItem key={i} disableGutters sx={{ py: 0.25 }}>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {repair.summary}
                  </Typography>
                </ListItem>
              ))}
            </List>
          )}
        </Box>
      ))}
    </Stack>
  );
}

export default GuardrailRepairs;
