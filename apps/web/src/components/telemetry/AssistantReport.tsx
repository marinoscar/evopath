/**
 * The troubleshooting agent's analysed report — issue #571.
 *
 * `ReportCard` renders `answer.report`: a status and confidence, the summary,
 * findings with severity, the likely root cause, numbered next steps, and the
 * supporting queries (collapsed SQL with Insert / Insert & run). `LegacyAnswer`
 * is the pre-#571 rendering (explanation + one SQL block), used whenever the
 * API sent no report (an older API, or a model reply that did not parse).
 *
 * Plain text only: every string here came from a model and is rendered as a
 * React text node, never as HTML or markdown. Mobile-first: chips wrap, long
 * words break, and SQL scrolls inside its own box.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  Link,
  Stack,
  Typography,
} from '@mui/material';
import type { ChipProps } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type {
  TelemetryAssistantAnswer,
  TelemetryAssistantReport,
  TelemetryFindingSeverity,
  TelemetryReportConfidence,
  TelemetryReportStatus,
} from '../../services/telemetry';

type ChipColor = ChipProps['color'];

const STATUS_CHIPS: Record<TelemetryReportStatus, { label: string; color: ChipColor }> = {
  issue_found: { label: 'Issue found', color: 'error' },
  no_issue_found: { label: 'No issue found', color: 'success' },
  inconclusive: { label: 'Inconclusive', color: 'warning' },
  no_data: { label: 'No data', color: 'default' },
};

const SEVERITY_COLORS: Record<TelemetryFindingSeverity, ChipColor> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'info',
  info: 'default',
};

const CONFIDENCE_LABELS: Record<TelemetryReportConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

const TEXT_SX = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as const;

export interface SqlActions {
  onInsert: (sql: string) => void;
  onInsertAndRun: (sql: string) => void;
}

function SqlBlock({ sql, testId }: { sql: string; testId?: string }) {
  return (
    <Box
      component="pre"
      data-testid={testId}
      sx={{
        m: 0,
        p: 1,
        borderRadius: 1,
        bgcolor: 'action.hover',
        fontFamily: 'monospace',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 240,
        overflow: 'auto',
      }}
    >
      {sql}
    </Box>
  );
}

function QueryButtons({ sql, onInsert, onInsertAndRun }: { sql: string } & SqlActions) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
      <Button size="small" onClick={() => onInsert(sql)}>
        Insert into editor
      </Button>
      <Button size="small" variant="outlined" onClick={() => onInsertAndRun(sql)}>
        Insert &amp; run
      </Button>
    </Stack>
  );
}

function SectionHeading({ children }: { children: string }) {
  return (
    <Typography variant="subtitle2" component="h3" sx={{ mt: 1.5, mb: 0.5 }}>
      {children}
    </Typography>
  );
}

/** The pre-#571 answer: the explanation, and the one SQL block when there is one. */
export function LegacyAnswer({ answer, onInsert, onInsertAndRun }: { answer: TelemetryAssistantAnswer } & SqlActions) {
  return (
    <>
      <Typography variant="body2" component="div" data-testid="assistant-explanation" sx={TEXT_SX}>
        {answer.explanation}
      </Typography>
      {answer.sql && (
        <Box sx={{ mt: 1 }}>
          <SqlBlock sql={answer.sql} testId="assistant-sql" />
          <QueryButtons sql={answer.sql} onInsert={onInsert} onInsertAndRun={onInsertAndRun} />
        </Box>
      )}
    </>
  );
}

export function ReportCard({ report, onInsert, onInsertAndRun }: { report: TelemetryAssistantReport } & SqlActions) {
  const status = STATUS_CHIPS[report.status] ?? { label: report.status, color: 'default' as ChipColor };
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [scrollTarget, setScrollTarget] = useState<number | null>(null);
  const queryRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (scrollTarget === null) return;
    queryRefs.current[scrollTarget]?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    setScrollTarget(null);
  }, [scrollTarget]);

  const setQueryExpanded = (index: number, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(index);
      else next.delete(index);
      return next;
    });

  const viewQuery = (index: number) => {
    setQueryExpanded(index, true);
    setScrollTarget(index);
  };

  const hasQuery = (index: number | undefined): index is number =>
    typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < report.queries.length;

  return (
    <Box data-testid="assistant-report" sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 1 }}>
        <Chip
          size="small"
          label={status.label}
          color={status.color}
          data-testid="assistant-report-status"
          data-status={report.status}
        />
        <Chip size="small" variant="outlined" label={CONFIDENCE_LABELS[report.confidence] ?? report.confidence} />
      </Stack>

      <Typography variant="body2" component="div" data-testid="assistant-explanation" sx={TEXT_SX}>
        {report.summary}
      </Typography>

      {report.findings.length > 0 && (
        <>
          <SectionHeading>Findings</SectionHeading>
          <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {report.findings.map((finding, i) => (
              <Box
                component="li"
                key={i}
                data-testid="assistant-finding"
                data-severity={finding.severity}
                sx={{ minWidth: 0 }}
              >
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Chip
                    size="small"
                    label={finding.severity}
                    color={SEVERITY_COLORS[finding.severity] ?? 'default'}
                    sx={{ textTransform: 'capitalize' }}
                  />
                  <Typography variant="body2" component="span" sx={{ fontWeight: 600, ...TEXT_SX, minWidth: 0 }}>
                    {finding.title}
                  </Typography>
                </Stack>
                {finding.evidence && (
                  <Typography variant="body2" color="text.secondary" component="div" sx={{ mt: 0.25, ...TEXT_SX }}>
                    {finding.evidence}
                  </Typography>
                )}
                {hasQuery(finding.queryIndex) && (
                  <Link
                    component="button"
                    type="button"
                    variant="caption"
                    onClick={() => viewQuery(finding.queryIndex as number)}
                    sx={{ mt: 0.25 }}
                  >
                    View query
                  </Link>
                )}
              </Box>
            ))}
          </Stack>
        </>
      )}

      {report.rootCause && (
        <>
          <SectionHeading>Likely root cause</SectionHeading>
          <Typography variant="body2" component="div" data-testid="assistant-root-cause" sx={TEXT_SX}>
            {report.rootCause}
          </Typography>
        </>
      )}

      {report.recommendations.length > 0 && (
        <>
          <SectionHeading>Recommended next steps</SectionHeading>
          <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
            {report.recommendations.map((item, i) => (
              <Typography
                component="li"
                variant="body2"
                key={i}
                data-testid="assistant-recommendation"
                sx={{ ...TEXT_SX, mb: 0.25 }}
              >
                {item}
              </Typography>
            ))}
          </Box>
        </>
      )}

      {report.queries.length > 0 && (
        <>
          <SectionHeading>Supporting queries</SectionHeading>
          <Stack spacing={0.75}>
            {report.queries.map((query, i) => (
              <Accordion
                key={i}
                ref={(el: HTMLDivElement | null) => {
                  queryRefs.current[i] = el;
                }}
                data-testid="assistant-query"
                variant="outlined"
                disableGutters
                expanded={expanded.has(i)}
                onChange={(_, open) => setQueryExpanded(i, open)}
                sx={{ '&::before': { display: 'none' }, minWidth: 0 }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon />}
                  sx={{ minHeight: 40, px: 1, '& .MuiAccordionSummary-content': { my: 0.75, minWidth: 0 } }}
                >
                  <Typography variant="body2" sx={TEXT_SX}>
                    {query.title || `Query ${i + 1}`}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 1, pt: 0, pb: 1 }}>
                  <SqlBlock sql={query.sql} testId={i === 0 ? 'assistant-sql' : undefined} />
                  <QueryButtons sql={query.sql} onInsert={onInsert} onInsertAndRun={onInsertAndRun} />
                </AccordionDetails>
              </Accordion>
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}
