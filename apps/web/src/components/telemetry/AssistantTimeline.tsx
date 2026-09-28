/**
 * The investigation timeline of one assistant turn — issue #571.
 *
 * Every tool step the agent ran, in order, with the model's interim reasoning
 * (`thought`, sent on the first call of a round) shown as a short italic line
 * before the step it led to. While the turn streams the timeline is open and
 * headed "Investigating…"; once the answer arrives it collapses behind a
 * toggle so the report is what the viewer sees first (a phone especially).
 *
 * Plain text only: nothing the model says is interpreted as HTML.
 */
import { useId, useState } from 'react';
import { Box, Button, CircularProgress, Collapse, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { TelemetryAssistantStep } from '../../services/telemetry';

const TOOL_LABELS: Record<string, string> = {
  list_tables: 'Listed tables',
  describe_table: 'Described table',
  run_query: 'Ran query',
  get_app_context: 'Read app configuration',
  health_overview: 'Health overview',
  get_trace: 'Traced',
};

const TRACE_ID_SHORT = 8;

/** What follows the label: the table, the window, or a shortened trace id. */
function stepTarget(step: TelemetryAssistantStep): string {
  const input = step.input;
  if (!input) return '';
  if (step.tool === 'get_trace' && input.traceId) {
    return input.traceId.length > TRACE_ID_SHORT ? `${input.traceId.slice(0, TRACE_ID_SHORT)}…` : input.traceId;
  }
  if (step.tool === 'health_overview' && input.window) return input.window;
  return input.table ?? '';
}

function stepFacts(step: TelemetryAssistantStep): string {
  const facts: string[] = [];
  if (step.rowCount !== undefined) facts.push(`${step.rowCount} row${step.rowCount === 1 ? '' : 's'}`);
  if (step.truncated) facts.push('truncated');
  facts.push(`${Math.round(step.durationMs)} ms`);
  return facts.join(' · ');
}

function StepRow({ step }: { step: TelemetryAssistantStep }) {
  const label = TOOL_LABELS[step.tool] ?? step.tool;
  const target = stepTarget(step);

  return (
    <Box sx={{ minWidth: 0 }}>
      {step.thought && (
        <Typography
          variant="caption"
          component="div"
          color="text.secondary"
          data-testid="assistant-thought"
          sx={{ fontStyle: 'italic', whiteSpace: 'pre-wrap', wordBreak: 'break-word', pt: 0.5 }}
        >
          {step.thought}
        </Typography>
      )}
      <Box data-testid="assistant-step" sx={{ py: 0.5, minWidth: 0 }}>
        <Typography
          variant="caption"
          component="div"
          color={step.error ? 'error' : 'text.secondary'}
          sx={{ wordBreak: 'break-word' }}
        >
          <strong>{label}</strong>
          {target ? ` ${target}` : ''} · {stepFacts(step)}
        </Typography>
        {step.input?.sql && (
          <Box
            component="pre"
            sx={{
              m: 0,
              mt: 0.25,
              p: 0.75,
              borderRadius: 1,
              bgcolor: 'action.hover',
              fontFamily: 'monospace',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 96,
              overflow: 'auto',
            }}
          >
            {step.input.sql}
          </Box>
        )}
        {step.error && (
          <Typography variant="caption" component="div" color="error" sx={{ wordBreak: 'break-word' }}>
            {step.error}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function stepCount(n: number): string {
  return `${n} step${n === 1 ? '' : 's'}`;
}

export interface AssistantTimelineProps {
  steps: TelemetryAssistantStep[];
  /** The turn is still streaming (no answer yet). */
  isInvestigating: boolean;
  /** An answer arrived: collapse the steps behind a toggle. */
  collapsible: boolean;
}

export function AssistantTimeline({ steps, isInvestigating, collapsible }: AssistantTimelineProps) {
  const [open, setOpen] = useState(false);
  const regionId = useId();

  if (isInvestigating) {
    return (
      <Box>
        {steps.map((step) => (
          <StepRow key={`${step.index}-${step.tool}`} step={step} />
        ))}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pt: steps.length ? 0.5 : 0 }}>
          <CircularProgress size={14} />
          <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
            Investigating…{steps.length > 0 ? ` (${stepCount(steps.length)})` : ''}
          </Typography>
        </Stack>
      </Box>
    );
  }

  if (steps.length === 0) return null;

  if (!collapsible) {
    return (
      <Box>
        {steps.map((step) => (
          <StepRow key={`${step.index}-${step.tool}`} step={step} />
        ))}
      </Box>
    );
  }

  return (
    <Box>
      <Button
        size="small"
        color="inherit"
        data-testid="assistant-timeline-toggle"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
        startIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        sx={{ px: 0.5, color: 'text.secondary', textTransform: 'none' }}
      >
        {open ? 'Hide' : 'Show'} investigation ({stepCount(steps.length)})
      </Button>
      <Collapse in={open} id={regionId}>
        <Box sx={{ pl: 0.5, pb: 0.5 }}>
          {steps.map((step) => (
            <StepRow key={`${step.index}-${step.tool}`} step={step} />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}
