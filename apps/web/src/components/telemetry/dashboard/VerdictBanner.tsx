/**
 * The Telemetry Dashboard's verdict — issue #578, epic #576.
 *
 * The first thing on the page answers "is anything wrong?". The level and its
 * reasons are the API's (`summary.verdict`); this only presents them. Every
 * level carries an icon AND a word, never colour alone, and the banner is a
 * polite live region, so a verdict that changes on auto-refresh is announced.
 *
 * On phones it collapses to one line (level + first reason) and expands on
 * tap (`aria-expanded`).
 *
 * `action` (#579) adds one button to the banner — the dashboard's "Explain
 * this", which opens the assistant with the verdict prefilled.
 */
import { useId, useState } from 'react';
import { Alert, Box, Button, ButtonBase, Skeleton, Typography, type AlertColor } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { SvgIconComponent } from '@mui/icons-material';
import type { DashboardVerdictLevel } from '../../../services/telemetryDashboard';
import type { TelemetryErrorInfo } from '../../../hooks/useTelemetryExplorer';
import { PanelError } from './DashboardPanel';

interface LevelMeta {
  label: string;
  Icon: SvgIconComponent;
  /** `null` = neutral grey (no data). */
  severity: AlertColor | null;
}

export const VERDICT_META: Record<DashboardVerdictLevel, LevelMeta> = {
  healthy: { label: 'Healthy', Icon: CheckCircleOutlineIcon, severity: 'success' },
  degraded: { label: 'Degraded', Icon: WarningAmberIcon, severity: 'warning' },
  critical: { label: 'Critical', Icon: ErrorOutlineIcon, severity: 'error' },
  no_data: { label: 'No telemetry received', Icon: CloudOffOutlinedIcon, severity: null },
};

export interface VerdictBannerProps {
  verdict: { level: DashboardVerdictLevel; reasons: string[] } | null;
  isLoading?: boolean;
  error?: TelemetryErrorInfo | null;
  onRetry?: () => void;
  /** Phone layout: one line, tap to expand. */
  compact?: boolean;
  /** One button on the banner (#579: "Explain this"). */
  action?: { label: string; onClick: () => void };
}

export function VerdictBanner({
  verdict,
  isLoading = false,
  error = null,
  onRetry,
  compact = false,
  action,
}: VerdictBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const reasonsId = useId();

  if (error) return <PanelError error={error} onRetry={onRetry} />;
  if (isLoading || !verdict) {
    return <Skeleton variant="rounded" height={compact ? 48 : 64} data-testid="verdict-skeleton" />;
  }

  const meta = VERDICT_META[verdict.level] ?? VERDICT_META.no_data;
  const reasons = verdict.reasons;
  const neutral = meta.severity === null;
  const canExpand = compact && reasons.length > 0;

  const reasonList = (hidden: boolean) =>
    reasons.length > 0 && (
    <Box component="ul" id={reasonsId} hidden={hidden} sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
      {reasons.map((reason, index) => (
        <Typography key={`${index}-${reason}`} component="li" variant="body2" sx={{ wordBreak: 'break-word' }}>
          {reason}
        </Typography>
      ))}
    </Box>
  );

  return (
    <Alert
      role="status"
      aria-live="polite"
      data-testid="verdict-banner"
      data-level={verdict.level}
      severity={meta.severity ?? 'info'}
      icon={<meta.Icon aria-hidden />}
      action={
        action ? (
          <Button
            color="inherit"
            size="small"
            onClick={action.onClick}
            sx={{ minHeight: 44, whiteSpace: 'nowrap', alignSelf: 'center' }}
          >
            {action.label}
          </Button>
        ) : undefined
      }
      sx={{
        minWidth: 0,
        '& .MuiAlert-message': { minWidth: 0, flex: 1 },
        ...(neutral && {
          bgcolor: 'action.hover',
          color: 'text.primary',
          '& .MuiAlert-icon': { color: 'text.secondary' },
        }),
      }}
    >
      {canExpand ? (
        <>
          <ButtonBase
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-controls={reasonsId}
            sx={{
              display: 'flex',
              width: '100%',
              minHeight: 44,
              justifyContent: 'space-between',
              textAlign: 'left',
              gap: 1,
              borderRadius: 1,
            }}
          >
            <Typography variant="body2" noWrap={!expanded} sx={{ minWidth: 0, flex: 1 }}>
              <strong>{meta.label}</strong>
              {!expanded && ` · ${reasons[0]}`}
            </Typography>
            <ExpandMoreIcon
              aria-hidden
              fontSize="small"
              sx={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
            />
          </ButtonBase>
          {reasonList(!expanded)}
        </>
      ) : (
        <>
          <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600, lineHeight: 1.4 }}>
            {meta.label}
          </Typography>
          {reasonList(false)}
        </>
      )}
    </Alert>
  );
}
