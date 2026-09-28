/**
 * Severity presentation for the Telemetry Dashboard (#578). Severity is NEVER
 * colour alone: every mark carries an icon and a word ("Error", "Warn",
 * "Info"), so it reads in greyscale, to a screen reader and to a colour-blind
 * operator alike.
 */
import { Box, Chip, Stack, type SxProps, type Theme } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import type { SvgIconComponent } from '@mui/icons-material';
import { DASHBOARD_SEVERITIES, type DashboardSeverity } from '../../../services/telemetryDashboard';

export type SeverityKind = DashboardSeverity | 'other';

interface SeverityMeta {
  label: string;
  Icon: SvgIconComponent;
  color: 'error' | 'warning' | 'info' | 'default';
}

export const SEVERITY_META: Record<SeverityKind, SeverityMeta> = {
  error: { label: 'Error', Icon: ErrorOutlineIcon, color: 'error' },
  warn: { label: 'Warn', Icon: WarningAmberIcon, color: 'warning' },
  info: { label: 'Info', Icon: InfoOutlinedIcon, color: 'info' },
  other: { label: 'Other', Icon: HelpOutlineIcon, color: 'default' },
};

/** Map an event's severity text (`error`, `fatal`, `warning`, `debug`, …) to a band. */
export function severityKind(severity: string | null | undefined): SeverityKind {
  const text = (severity ?? '').toLowerCase();
  if (text.startsWith('err') || text.startsWith('fatal') || text.startsWith('crit')) return 'error';
  if (text.startsWith('warn')) return 'warn';
  if (text.startsWith('info')) return 'info';
  return 'other';
}

/** A small icon + word label for one severity. */
export function SeverityLabel({ severity }: { severity: string }) {
  const kind = severityKind(severity);
  const meta = SEVERITY_META[kind];
  // An unknown band keeps its own word ("debug", "trace"), capitalised.
  const label = kind === 'other' && severity ? severity.charAt(0).toUpperCase() + severity.slice(1) : meta.label;
  const color = meta.color === 'default' ? 'text.secondary' : `${meta.color}.main`;
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color, fontWeight: 500, whiteSpace: 'nowrap' }}
    >
      <meta.Icon fontSize="small" aria-hidden />
      <span>{label}</span>
    </Box>
  );
}

/** A compact chip for list rows (phone events). */
export function SeverityChip({ severity }: { severity: string }) {
  const kind = severityKind(severity);
  const meta = SEVERITY_META[kind];
  const label = kind === 'other' && severity ? severity.charAt(0).toUpperCase() + severity.slice(1) : meta.label;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={meta.color}
      icon={<meta.Icon aria-hidden />}
      label={label}
    />
  );
}

interface SeverityChipsProps {
  value: DashboardSeverity[];
  onChange: (next: DashboardSeverity[]) => void;
  /** Touch targets of 44px on phones. */
  large?: boolean;
  sx?: SxProps<Theme>;
  /** Names the group for assistive tech. */
  label?: string;
}

/**
 * Toggle chips for the `sev` filter. The last selected chip cannot be turned
 * off — an empty filter is not a view anyone means, and the API would fall
 * back to its default anyway.
 */
export function SeverityChips({ value, onChange, large = false, sx, label = 'Severity filter' }: SeverityChipsProps) {
  const toggle = (severity: DashboardSeverity) => {
    const selected = value.includes(severity);
    if (selected && value.length === 1) return;
    const next = selected ? value.filter((s) => s !== severity) : [...value, severity];
    onChange(DASHBOARD_SEVERITIES.filter((s) => next.includes(s)));
  };
  return (
    <Stack direction="row" spacing={1} useFlexGap role="group" aria-label={label} sx={{ flexWrap: 'wrap', ...sx }}>
      {DASHBOARD_SEVERITIES.map((severity) => {
        const meta = SEVERITY_META[severity];
        const selected = value.includes(severity);
        return (
          <Chip
            key={severity}
            icon={<meta.Icon aria-hidden />}
            label={meta.label}
            color={meta.color === 'default' ? undefined : meta.color}
            variant={selected ? 'filled' : 'outlined'}
            onClick={() => toggle(severity)}
            aria-pressed={selected}
            sx={large ? { minHeight: 44, borderRadius: 22, px: 0.5 } : undefined}
          />
        );
      })}
    </Stack>
  );
}
