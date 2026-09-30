/**
 * Admin → Observability → Doctor (`/admin/settings/doctor`) — issue #634.
 *
 * A REGISTRY CARD and nothing else, per CLAUDE.md's MANDATORY Settings UI
 * Pattern: one entry in `ADMIN_SECTIONS` (`config/adminSections.tsx`), one
 * route in `App.tsx` gated on `system_settings:read` (the string
 * `doctor/doctor.controller.ts` enforces), and no tab anywhere.
 *
 * The question it answers: **is every capability configured, reachable and
 * healthy?** One row per check, grouped by category, with the remedy and a
 * link to the settings page that fixes it.
 *
 * ⚠ A FAILING CHECK IS NOT A PAGE ERROR. The endpoint answers 200 with a
 * `fail` verdict; that renders as the verdict Alert and the rows below it.
 * The page-level error Alert is reserved for a request that actually failed.
 *
 * Deliberately NOT feature-gated: the page reports on AI and telemetry while
 * they are switched off (as `skip`), which is precisely when an admin asks
 * why a capability is missing.
 */

import { useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  FormControlLabel,
  Skeleton,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import type { AlertColor } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Navigate } from 'react-router-dom';
import { useDoctor } from '../../hooks/useDoctor';
import { usePermissions } from '../../hooks/usePermissions';
import { formatRelativeTime } from '../../utils/relativeTime';
import { CheckRow, STATUS_CHIP_COLORS, STATUS_LABELS, StatusIcon } from '../../components/doctor/CheckRow';
import { DOCTOR_STATUS_ORDER } from '../../services/doctor';
import type { DoctorCheckReport, DoctorReport, DoctorStatus } from '../../services/doctor';

/** Mirrors the `Doctor` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'Doctor';
const PAGE_DESCRIPTION =
  'Check the configuration, connectivity and health of every capability, including telemetry capture.';

/** Display order and labels. A category a fork adds renders after these, title-cased. */
export const DOCTOR_CATEGORIES: readonly { key: string; label: string }[] = [
  { key: 'core', label: 'Core' },
  { key: 'auth', label: 'Authentication' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'storage', label: 'Object storage' },
  { key: 'email', label: 'Email' },
  { key: 'push', label: 'Web Push' },
  { key: 'ai', label: 'AI' },
  { key: 'jobs', label: 'Job queue' },
  { key: 'nodes', label: 'Worker nodes' },
  { key: 'backup', label: 'Database backup' },
  { key: 'telemetry', label: 'Telemetry' },
];

export function categoryLabel(key: string): string {
  const known = DOCTOR_CATEGORIES.find((category) => category.key === key);
  if (known) return known.label;
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isProblem(status: DoctorStatus): boolean {
  return status === 'warn' || status === 'fail';
}

function worstStatus(checks: DoctorCheckReport[]): DoctorStatus {
  let worst: DoctorStatus = 'pass';
  for (const check of checks) {
    if (DOCTOR_STATUS_ORDER.indexOf(check.status) > DOCTOR_STATUS_ORDER.indexOf(worst)) {
      worst = check.status;
    }
  }
  return worst;
}

interface CategoryGroup {
  key: string;
  label: string;
  checks: DoctorCheckReport[];
}

/** Known categories in display order, then unknown ones in the order the API sent them. */
function groupByCategory(checks: DoctorCheckReport[]): CategoryGroup[] {
  const byKey = new Map<string, DoctorCheckReport[]>();
  for (const check of checks) {
    const list = byKey.get(check.category);
    if (list) list.push(check);
    else byKey.set(check.category, [check]);
  }
  const knownKeys = DOCTOR_CATEGORIES.map((category) => category.key);
  const ordered = [
    ...knownKeys.filter((key) => byKey.has(key)),
    ...[...byKey.keys()].filter((key) => !knownKeys.includes(key)),
  ];
  return ordered.map((key) => ({ key, label: categoryLabel(key), checks: byKey.get(key) ?? [] }));
}

function countByStatus(checks: DoctorCheckReport[]): Record<DoctorStatus, number> {
  const counts: Record<DoctorStatus, number> = { pass: 0, skip: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

function verdictSeverity(verdict: DoctorStatus): AlertColor {
  switch (verdict) {
    case 'fail':
      return 'error';
    case 'warn':
      return 'warning';
    case 'skip':
      return 'info';
    default:
      return 'success';
  }
}

function verdictTitle(report: DoctorReport, counts: Record<DoctorStatus, number>): string {
  const problems = counts.warn + counts.fail;
  if (problems > 0) {
    return problems === 1 ? '1 problem needs attention' : `${problems} problems need attention`;
  }
  if (counts.skip > 0 || report.verdict === 'skip') {
    return 'No problems found; some checks were skipped';
  }
  return 'All checks passed';
}

function formatReportDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function LoadingSkeleton() {
  return (
    <Stack spacing={2} data-testid="doctor-loading" aria-busy="true" aria-label="Running checks">
      <Skeleton variant="rounded" height={72} />
      <Skeleton variant="rounded" height={32} width="60%" />
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} variant="rounded" height={56} />
      ))}
    </Stack>
  );
}

export default function DoctorPage() {
  const { hasPermission } = usePermissions();
  const { report, isLoading, error, rerun } = useDoctor();
  const [problemsOnly, setProblemsOnly] = useState(false);
  // Only the categories the admin has toggled; the rest follow the default
  // (expanded when they contain a problem), which re-derives on each run.
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});

  const checks = useMemo(() => report?.checks ?? [], [report]);
  const counts = useMemo(() => countByStatus(checks), [checks]);
  // Grouped from ALL checks so each category's summary stays truthful; the
  // "Problems only" filter is applied per category below.
  const groups = useMemo(
    () =>
      groupByCategory(checks)
        .map((group) => ({
          ...group,
          visible: problemsOnly
            ? group.checks.filter((check) => isProblem(check.status))
            : group.checks,
        }))
        .filter((group) => group.visible.length > 0),
    [checks, problemsOnly],
  );

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. After every hook so hook order never changes.
  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  const handleRerun = () => {
    setExpandedOverrides({});
    void rerun();
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
        </Typography>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1, sm: 2 }}
          sx={{ mb: 3, alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          <Button
            variant="contained"
            onClick={handleRerun}
            disabled={isLoading}
            startIcon={
              isLoading ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />
            }
          >
            {isLoading ? 'Running checks…' : 'Run again'}
          </Button>
          {report && (
            <Typography variant="body2" color="text.secondary" data-testid="doctor-generated">
              Generated {formatRelativeTime(report.generatedAt)} · took{' '}
              {formatReportDuration(report.durationMs)}
            </Typography>
          )}
        </Stack>

        {/* THE REQUEST FAILED — never a failing check. */}
        {error && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            data-testid="doctor-request-error"
            action={
              <Button color="inherit" size="small" onClick={handleRerun} disabled={isLoading}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        {isLoading && !report && <LoadingSkeleton />}

        {report && (
          <Stack spacing={3}>
            <Alert
              severity={verdictSeverity(report.verdict)}
              role="status"
              aria-live="polite"
              data-testid="doctor-verdict"
            >
              <AlertTitle sx={{ mb: 0 }}>{verdictTitle(report, counts)}</AlertTitle>
            </Alert>

            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={{ xs: 1, sm: 2 }}
              sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between' }}
            >
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: 'wrap' }}
                aria-label="Checks by status"
                data-testid="doctor-summary"
              >
                {(['pass', 'warn', 'fail', 'skip'] as const).map((status) => (
                  <Chip
                    key={status}
                    size="small"
                    variant="outlined"
                    icon={<StatusIcon status={status} />}
                    color={STATUS_CHIP_COLORS[status]}
                    label={`${STATUS_LABELS[status]}: ${counts[status]}`}
                    data-testid={`doctor-count-${status}`}
                  />
                ))}
              </Stack>
              <FormControlLabel
                control={
                  <Switch
                    checked={problemsOnly}
                    onChange={(event) => setProblemsOnly(event.target.checked)}
                  />
                }
                label="Problems only"
              />
            </Stack>

            {groups.length === 0 && (
              <Typography color="text.secondary" data-testid="doctor-empty">
                {problemsOnly ? 'No warnings or failures.' : 'No checks were reported.'}
              </Typography>
            )}

            <Box>
              {groups.map((group) => {
                const worst = worstStatus(group.checks);
                const expanded = expandedOverrides[group.key] ?? isProblem(worst);
                const headingId = `doctor-category-${group.key}-heading`;
                const groupCounts = countByStatus(group.checks);
                return (
                  <Accordion
                    key={group.key}
                    expanded={expanded}
                    onChange={(_event, isExpanded) =>
                      setExpandedOverrides((previous) => ({ ...previous, [group.key]: isExpanded }))
                    }
                    disableGutters
                    data-testid={`doctor-category-${group.key}`}
                  >
                    <AccordionSummary
                      expandIcon={<ExpandMoreIcon />}
                      aria-controls={`doctor-category-${group.key}-content`}
                      id={headingId}
                    >
                      <Stack
                        direction="row"
                        spacing={1.5}
                        useFlexGap
                        sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}
                      >
                        <StatusIcon status={worst} />
                        <Typography variant="subtitle1" component="h2">
                          {group.label}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {groupCounts.pass}/{group.checks.length} passed
                        </Typography>
                      </Stack>
                    </AccordionSummary>
                    <AccordionDetails id={`doctor-category-${group.key}-content`}>
                      <Stack component="ul" spacing={2} sx={{ m: 0, p: 0 }}>
                        {group.visible.map((check) => (
                          <CheckRow key={check.id} check={check} />
                        ))}
                      </Stack>
                    </AccordionDetails>
                  </Accordion>
                );
              })}
            </Box>
          </Stack>
        )}
      </Box>
    </Container>
  );
}
