/**
 * What one agent run used (E6.3): a table of steps (graph nodes) with the role
 * that ran each, the model, whose key paid, requests, input and output tokens
 * and the summed provider time; a totals row; the per-run token cap as a
 * meter; and "Tokens, not currency". From
 * `GET /api/ai/training/runs/:runId/usage` (`useAgentRunUsage`).
 *
 * One component for every run screen: the adaptation review (E6.1) and the
 * plan run view (E5.6) mount it with the run's id. While the run is still
 * going the numbers are partial and say so; the parent passes `settled` when
 * the run ends and the panel reads the final numbers once more.
 *
 * Usage rows removed by `ai.usageRetentionDays` are not an error: the numbers
 * then come from the run's own tally and a line says so.
 */
import { useId, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { formatCount } from '../../ai/usage';
import { useAgentRunUsage, type UseAgentRunUsageReturn } from '../../../hooks/useAgentUsage';
import type { TrainingRunUsage } from '../../../services/trainingUsage';
import { formatDuration, keySourceLabel, nodeLabel, roleLabel } from './agentUsageLabels';
import { TokenCapMeter } from './TokenCapMeter';
import { TokensNotCurrencyNote } from './TokensNotCurrencyNote';

/** Run statuses whose numbers may still grow. */
const UNSETTLED_STATUSES = ['queued', 'running'];

export interface AgentUsagePanelProps {
  runId: string;
  /** The run has ended: refetch the final numbers once (default true: read once). */
  settled?: boolean;
  /**
   * `true`: render only the contents, for a parent that already frames them
   * in a titled section. Default: an outlined card titled "Tokens used".
   */
  embedded?: boolean;
  /**
   * A parent that reads the same usage for its own copy (the cap numbers in a
   * failure message) passes its reader here, so the run is fetched once.
   */
  state?: UseAgentRunUsageReturn;
}

export function AgentUsagePanel({ runId, settled = true, embedded = false, state }: AgentUsagePanelProps) {
  const own = useAgentRunUsage(state ? null : runId, { settled });
  const { usage, isLoading, error, notFound } = state ?? own;
  const headingId = useId();

  let body: ReactNode;
  if (isLoading && !usage) {
    body = (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={24} aria-label="Loading the usage of this run" />
      </Box>
    );
  } else if (!usage) {
    body = (
      <Alert severity={notFound ? 'info' : 'error'}>
        {notFound ? "The usage of this run isn't available." : (error ?? 'Failed to load the usage of this run')}
      </Alert>
    );
  } else {
    body = <AgentUsageContents usage={usage} />;
  }

  if (embedded) return <Box data-testid="agent-usage-panel">{body}</Box>;
  return (
    <Card variant="outlined" component="section" aria-labelledby={headingId} data-testid="agent-usage-panel">
      <CardContent>
        <Typography id={headingId} variant="h6" component="h2" gutterBottom>
          Tokens used
        </Typography>
        {body}
      </CardContent>
    </Card>
  );
}

function ModelCell({ provider, modelId, keySource }: { provider: string | null; modelId: string | null; keySource: string | null }) {
  return (
    <>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {modelId ? `${provider ? `${provider} ` : ''}${modelId}` : 'Unknown model'}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {keySourceLabel(keySource)}
      </Typography>
    </>
  );
}

/** The panel's contents for a loaded usage report; exported for tests and other frames. */
export function AgentUsageContents({ usage }: { usage: TrainingRunUsage }) {
  const partial = UNSETTLED_STATUSES.includes(usage.status);
  const { totals } = usage;
  return (
    <Stack spacing={2}>
      {partial && (
        <Typography variant="body2" color="text.secondary" role="status">
          The run is still going: these numbers are partial.
        </Typography>
      )}
      <TokenCapMeter cap={usage.cap} />

      {usage.byNode.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No tokens were used by this run.
        </Typography>
      ) : (
        <TableContainer
          tabIndex={0}
          role="region"
          aria-label="Tokens by step, scrollable"
          sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
        >
          <Table size="small" aria-label="Tokens by step" data-testid="agent-usage-table">
            <TableHead>
              <TableRow>
                <TableCell scope="col" component="th">Step</TableCell>
                <TableCell scope="col" component="th">Model and key</TableCell>
                <TableCell scope="col" component="th" align="right">Requests</TableCell>
                <TableCell scope="col" component="th" align="right">Input tokens</TableCell>
                <TableCell scope="col" component="th" align="right">Output tokens</TableCell>
                <TableCell scope="col" component="th" align="right">Duration</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {usage.byNode.map((row, index) => (
                <TableRow key={`${row.node ?? 'unattributed'}-${row.provider ?? ''}-${row.modelId ?? ''}-${index}`} data-testid="agent-usage-row">
                  <TableCell component="th" scope="row">
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {nodeLabel(row.node)}
                    </Typography>
                    {row.node !== null && (
                      <Typography variant="caption" color="text.secondary">
                        {roleLabel(row.role)}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <ModelCell provider={row.provider} modelId={row.modelId} keySource={row.keySource} />
                  </TableCell>
                  <TableCell align="right">
                    {formatCount(row.requests)}
                    {row.failed > 0 && (
                      <Typography variant="caption" color="text.secondary" component="span" sx={{ display: 'block' }}>
                        {formatCount(row.failed)} failed
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">{formatCount(row.inputTokens)}</TableCell>
                  <TableCell align="right">{formatCount(row.outputTokens)}</TableCell>
                  <TableCell align="right">{formatDuration(row.latencyMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow data-testid="agent-usage-total">
                <TableCell component="th" scope="row" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  Total
                </TableCell>
                <TableCell />
                <TableCell align="right" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  {formatCount(totals.requests)}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  {formatCount(totals.inputTokens)}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  {formatCount(totals.outputTokens)}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  {formatDuration(totals.latencyMs)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </TableContainer>
      )}

      {totals.reasoningTokens > 0 && (
        <Typography variant="body2" color="text.secondary">
          Output includes {formatCount(totals.reasoningTokens)} reasoning tokens.
        </Typography>
      )}
      {usage.retention.purged && (
        <Typography variant="body2" color="text.secondary" data-testid="agent-usage-purged">
          The detailed usage records of this run were removed after {usage.retention.retentionDays} days. These numbers
          come from the run&apos;s own tally.
        </Typography>
      )}
      <TokensNotCurrencyNote />
    </Stack>
  );
}

export default AgentUsagePanel;
