/**
 * One Telemetry Dashboard panel — issue #578, epic #576.
 *
 * The frame every panel shares: a titled region, a header ACTIONS SLOT, and
 * the loading / error / empty states, so a panel's own component only draws
 * its data.
 *
 * Actions slot (the seam for #579 — "Open in Explorer", "Ask assistant"): a
 * panel takes `actions`, each `{ key, label, icon, onClick }`. They render as
 * icon buttons from `sm` up and fold into one ⋮ menu on phones. `onClick`
 * receives the panel's `sql` — the statement(s) the API reports it ran for
 * this panel, primary first — so an action never has to rebuild the query.
 *
 * Failure is PER PANEL: the error Alert shows the API's message and
 * `details.reason`, with a Retry that refetches this panel only.
 */
import { useId, useState, type ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  IconButton,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { telemetryErrorTitle, type TelemetryErrorInfo } from '../../../hooks/useTelemetryExplorer';
import { sqlList } from '../../../services/telemetryDashboard';

export interface PanelAction {
  key: string;
  label: string;
  icon: ReactNode;
  /** Receives the panel's SQL, primary statement first. */
  onClick: (sql: string[]) => void;
  disabled?: boolean;
}

export interface DashboardPanelProps {
  title: string;
  /** Panel id for tests and deep links. */
  id: string;
  /** Beside the title: filters that belong to the panel (severity chips, a toggle). */
  headerExtra?: ReactNode;
  actions?: PanelAction[];
  /** The `sql` of the panel's response(s); handed to every action. */
  sql?: string | string[] | null;
  isLoading?: boolean;
  isRefreshing?: boolean;
  error?: TelemetryErrorInfo | null;
  onRetry?: () => void;
  /** True when the data is present but holds nothing to show. */
  isEmpty?: boolean;
  emptyMessage?: string;
  /** Skeleton height while the first result loads. */
  skeletonHeight?: number;
  children?: ReactNode;
}

export function PanelError({ error, onRetry }: { error: TelemetryErrorInfo; onRetry?: () => void }) {
  return (
    <Alert
      severity={error.reason === 'TELEMETRY_QUERY_TIMEOUT' ? 'warning' : 'error'}
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry} sx={{ minHeight: 44 }}>
            Retry
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>{telemetryErrorTitle(error)}</AlertTitle>
      <Box component="span" sx={{ wordBreak: 'break-word' }}>
        {error.message}
      </Box>
      {(error.reason ?? error.code) && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, opacity: 0.8 }}>
          {error.reason ?? error.code}
        </Typography>
      )}
    </Alert>
  );
}

function PanelActions({
  actions,
  sql,
  title,
  isPhone,
}: {
  actions: PanelAction[];
  sql: string[];
  title: string;
  isPhone: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();

  if (actions.length === 0) return null;

  if (isPhone) {
    return (
      <>
        <IconButton
          aria-label={`${title} actions`}
          aria-haspopup="menu"
          aria-controls={anchor ? menuId : undefined}
          aria-expanded={anchor ? 'true' : undefined}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ width: 44, height: 44 }}
        >
          <MoreVertIcon />
        </IconButton>
        <Menu id={menuId} anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
          {actions.map((action) => (
            <MenuItem
              key={action.key}
              disabled={action.disabled}
              sx={{ minHeight: 44 }}
              onClick={() => {
                setAnchor(null);
                action.onClick(sql);
              }}
            >
              <ListItemIcon>{action.icon}</ListItemIcon>
              <ListItemText>{action.label}</ListItemText>
            </MenuItem>
          ))}
        </Menu>
      </>
    );
  }

  return (
    <Stack direction="row" spacing={0.5}>
      {actions.map((action) => (
        <Tooltip key={action.key} title={action.label}>
          <span>
            <IconButton aria-label={action.label} disabled={action.disabled} onClick={() => action.onClick(sql)}>
              {action.icon}
            </IconButton>
          </span>
        </Tooltip>
      ))}
    </Stack>
  );
}

export function DashboardPanel({
  title,
  id,
  headerExtra,
  actions = [],
  sql,
  isLoading = false,
  isRefreshing = false,
  error = null,
  onRetry,
  isEmpty = false,
  emptyMessage = 'Nothing in this window.',
  skeletonHeight = 160,
  children,
}: DashboardPanelProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const headingId = `${id}-title`;
  let body: ReactNode;
  if (error) body = <PanelError error={error} onRetry={onRetry} />;
  else if (isLoading) body = <Skeleton variant="rounded" height={skeletonHeight} data-testid={`${id}-skeleton`} />;
  else if (isEmpty)
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
        {emptyMessage}
      </Typography>
    );
  else body = children;

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      data-testid={id}
      sx={{ position: 'relative', p: { xs: 1.5, sm: 2 }, minWidth: 0, height: '100%', overflow: 'hidden' }}
    >
      {isRefreshing && (
        <LinearProgress
          aria-label={`Refreshing ${title}`}
          sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2 }}
        />
      )}
      {/*
        Phones: [title ...... ⋮] on one row, then the panel's own filters
        (headerExtra) full-width underneath. Rendered in that DOM order so
        focus order matches what is on screen. From `sm` up the filters sit
        inline between the title and the action buttons.
      */}
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ alignItems: 'center', flexWrap: isPhone ? 'nowrap' : 'wrap', mb: 1.5, minHeight: 40 }}
      >
        <Typography
          id={headingId}
          variant="h6"
          component="h2"
          sx={{ fontSize: '1rem', mr: 'auto', minWidth: 0, overflowWrap: 'anywhere' }}
        >
          {title}
        </Typography>
        {!isPhone && headerExtra}
        <PanelActions actions={actions} sql={sqlList(sql)} title={title} isPhone={isPhone} />
      </Stack>
      {isPhone && headerExtra && (
        <Box data-testid={`${id}-header-extra`} sx={{ mb: 1.5, minWidth: 0 }}>
          {headerExtra}
        </Box>
      )}
      {body}
    </Paper>
  );
}
