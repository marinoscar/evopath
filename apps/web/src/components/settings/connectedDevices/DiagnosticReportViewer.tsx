/**
 * One uploaded diagnostic report (#283): the summary, each self-test check
 * with its status icon, detail and remedy, the key environment facts, the
 * log tail, and the whole JSON as a download. Renders whatever the phone sent;
 * an older app build may send less.
 */
import {
  Box,
  Button,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorIcon from '@mui/icons-material/Error';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlineOutlined';
import DownloadIcon from '@mui/icons-material/Download';
import type { DiagnosticCheckStatus, Report } from '../../../services/healthSync';
import { CHECK_STATUS_LABELS, formatDateTime } from './format';

const LOG_TAIL_LINES = 100;

function CheckIcon({ status }: { status: DiagnosticCheckStatus }) {
  const label = CHECK_STATUS_LABELS[status];
  switch (status) {
    case 'pass':
      return <CheckCircleIcon color="success" titleAccess={label} data-testid="check-icon-pass" />;
    case 'warn':
      return <WarningAmberIcon color="warning" titleAccess={label} data-testid="check-icon-warn" />;
    case 'fail':
      return <ErrorIcon color="error" titleAccess={label} data-testid="check-icon-fail" />;
    default:
      return <RemoveCircleOutlineIcon color="disabled" titleAccess={label} data-testid="check-icon-skip" />;
  }
}

function join(...parts: Array<string | number | null | undefined>): string {
  return parts.filter((p) => p !== null && p !== undefined && p !== '').join(' · ');
}

/** Save the report JSON through the browser's own download machinery. */
function downloadJson(report: Report) {
  if (typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([JSON.stringify(report.report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `health-sync-diagnostics-${report.createdAt.replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function DiagnosticReportViewer({ report }: { report: Report }) {
  const body = report.report ?? {};
  const checks = Array.isArray(body.checks) ? body.checks : [];
  const log = Array.isArray(body.log) ? body.log.slice(-LOG_TAIL_LINES) : [];

  const facts: Array<[string, string]> = [
    [
      'App',
      join(
        body.app?.versionName,
        body.app?.versionCode !== undefined ? `build ${body.app.versionCode}` : null,
        body.app?.packageName,
      ),
    ],
    [
      'Device',
      join(
        join(body.device?.manufacturer, body.device?.model),
        body.device?.androidVersion ? `Android ${body.device.androidVersion}` : null,
        body.device?.sdkInt !== undefined ? `SDK ${body.device.sdkInt}` : null,
        body.device?.timezone,
      ),
    ],
    [
      'Health Connect',
      join(
        body.healthConnect?.status,
        body.healthConnect?.version,
        body.healthConnect?.grantedPermissions
          ? `${body.healthConnect.grantedPermissions.length} permissions granted`
          : null,
      ),
    ],
    [
      'Background sync',
      join(body.work?.state, body.work?.nextRunAt ? `next ${formatDateTime(body.work.nextRunAt)}` : null),
    ],
    ['Server', join(body.server?.url)],
  ];

  return (
    <Stack spacing={2} data-testid="diagnostic-report">
      <Box>
        <Typography variant="subtitle2">Uploaded {formatDateTime(report.createdAt)}</Typography>
        {report.summary && <Typography variant="body2">{report.summary}</Typography>}
      </Box>

      <Box>
        <Typography variant="subtitle1" component="h3">
          Checks
        </Typography>
        {checks.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            This report has no self-test results.
          </Typography>
        ) : (
          <List dense disablePadding aria-label="Self-test checks">
            {checks.map((check) => (
              <ListItem key={check.id} disableGutters alignItems="flex-start">
                <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>
                  <CheckIcon status={check.status} />
                </ListItemIcon>
                <ListItemText
                  primary={check.id}
                  secondary={
                    <>
                      {check.detail && (
                        <Typography component="span" variant="body2" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                          {check.detail}
                        </Typography>
                      )}
                      {check.remedy && (
                        <Typography component="span" variant="body2" sx={{ display: 'block', color: 'text.primary' }}>
                          Fix: {check.remedy}
                        </Typography>
                      )}
                    </>
                  }
                />
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle1" component="h3">
          Environment
        </Typography>
        <Box component="dl" sx={{ m: 0 }}>
          {facts
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <Box key={label} sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Typography component="dt" variant="body2" sx={{ fontWeight: 500 }}>
                  {label}:
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>
                  {value}
                </Typography>
              </Box>
            ))}
        </Box>
      </Box>

      {log.length > 0 && (
        <Box>
          <Typography variant="subtitle1" component="h3">
            Log (last {log.length} lines)
          </Typography>
          <Box
            component="pre"
            tabIndex={0}
            aria-label="Log tail"
            sx={{
              m: 0,
              p: 1,
              maxHeight: 240,
              overflow: 'auto',
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              bgcolor: 'action.hover',
              borderRadius: 1,
              whiteSpace: 'pre',
            }}
          >
            {log.join('\n')}
          </Box>
        </Box>
      )}

      <Box>
        <Button variant="outlined" size="small" startIcon={<DownloadIcon />} onClick={() => downloadJson(report)}>
          Download JSON
        </Button>
      </Box>
    </Stack>
  );
}
