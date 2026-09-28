/**
 * The Telemetry Dashboard's filter bar — issue #578, epic #576.
 *
 * Range (15m … 7d), service and instance (the values `/filters` reports for
 * the window), auto-refresh, "Updated Xs ago", and — while zoomed — a
 * "Reset zoom" chip that drops `from`/`to` and returns to the preset.
 *
 * - Desktop (≥ lg): everything inline, range as a ToggleButtonGroup.
 * - Tablet (sm–md): range Select inline; service, instance and auto-refresh
 *   behind a "Filters" button in a popover.
 * - Phone (< sm): a sticky compact bar (range chip + Filters) whose button
 *   opens a full-screen dialog with every control, applied on "Apply" (a
 *   draft, so a half-made choice never fires five requests) or "Reset".
 */
import { useEffect, useId, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Popover,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import TuneIcon from '@mui/icons-material/Tune';
import CloseIcon from '@mui/icons-material/Close';
import {
  DASHBOARD_RANGES,
  DASHBOARD_RANGE_LABELS,
  type DashboardRange,
} from '../../../services/telemetryDashboard';
import { DEFAULT_DASHBOARD_STATE, isZoomed, type DashboardState } from './dashboardState';
import { formatTimestamp } from './format';

export type DashboardLayout = 'phone' | 'tablet' | 'desktop';

export interface DashboardFilterBarProps {
  state: DashboardState;
  onChange: (patch: Partial<DashboardState>) => void;
  services: string[];
  instances: string[];
  /** `Date.now()` of the latest summary, for "Updated Xs ago". */
  updatedAt: number | null;
  layout: DashboardLayout;
}

/** Re-renders itself once a second; the rest of the page does not. */
export function UpdatedAgo({ updatedAt }: { updatedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (updatedAt === null) return null;
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  const text = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
  return (
    <Typography variant="caption" color="text.secondary" data-testid="updated-ago" sx={{ whiteSpace: 'nowrap' }}>
      Updated {text} ago
    </Typography>
  );
}

export function zoomLabel(state: DashboardState): string {
  return `${formatTimestamp(state.from)} – ${formatTimestamp(state.to)}`;
}

export function ResetZoomChip({ state, onChange }: Pick<DashboardFilterBarProps, 'state' | 'onChange'>) {
  if (!isZoomed(state)) return null;
  return (
    <Chip
      icon={<ZoomOutIcon aria-hidden />}
      label="Reset zoom"
      title={zoomLabel(state)}
      onClick={() => onChange({ from: null, to: null })}
      onDelete={() => onChange({ from: null, to: null })}
      color="primary"
      variant="outlined"
      sx={{ minHeight: 36 }}
    />
  );
}

interface SelectProps {
  label: string;
  allLabel: string;
  value: string | null;
  options: string[];
  onChange: (value: string | null) => void;
  fullWidth?: boolean;
}

export function FilterSelect({ label, allLabel, value, options, onChange, fullWidth }: SelectProps) {
  const id = `dashboard-${label.toLowerCase()}`;
  // A value from the URL that `/filters` does not (yet) list is still shown.
  const values = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <FormControl size="small" fullWidth={fullWidth} sx={{ minWidth: 160, maxWidth: fullWidth ? undefined : 240 }}>
      <InputLabel id={`${id}-label`} shrink>
        {label}
      </InputLabel>
      <Select
        labelId={`${id}-label`}
        id={id}
        input={<OutlinedInput notched label={label} />}
        value={value ?? ''}
        displayEmpty
        onChange={(event) => onChange(event.target.value ? String(event.target.value) : null)}
        renderValue={(selected) => (selected ? String(selected) : allLabel)}
      >
        <MenuItem value="">{allLabel}</MenuItem>
        {values.map((option) => (
          <MenuItem key={option} value={option}>
            {option}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

export function RefreshSwitch({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <FormControlLabel
      control={<Switch checked={checked} onChange={(event) => onChange(event.target.checked)} />}
      label="Auto-refresh"
      sx={{ mr: 0, whiteSpace: 'nowrap' }}
    />
  );
}

export function RangeToggle({ state, onChange }: Pick<DashboardFilterBarProps, 'state' | 'onChange'>) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      aria-label="Time range"
      value={isZoomed(state) ? null : state.range}
      onChange={(_event, next: DashboardRange | null) => {
        if (next) onChange({ range: next, from: null, to: null });
        else if (isZoomed(state)) onChange({ from: null, to: null });
      }}
    >
      {DASHBOARD_RANGES.map((range) => (
        <ToggleButton key={range} value={range} aria-label={DASHBOARD_RANGE_LABELS[range]} sx={{ px: 1.5, textTransform: 'none' }}>
          {range}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export function RangeSelect({
  state,
  onChange,
  fullWidth,
}: Pick<DashboardFilterBarProps, 'state' | 'onChange'> & { fullWidth?: boolean }) {
  const id = useId();
  return (
    <FormControl size="small" fullWidth={fullWidth} sx={{ minWidth: 170 }}>
      <InputLabel id={`${id}-label`} shrink>
        Range
      </InputLabel>
      <Select
        labelId={`${id}-label`}
        input={<OutlinedInput notched label="Range" />}
        value={isZoomed(state) ? 'zoom' : state.range}
        onChange={(event) => {
          const next = event.target.value;
          if (next !== 'zoom') onChange({ range: next as DashboardRange, from: null, to: null });
        }}
      >
        {isZoomed(state) && (
          <MenuItem value="zoom" disabled>
            Zoomed window
          </MenuItem>
        )}
        {DASHBOARD_RANGES.map((range) => (
          <MenuItem key={range} value={range}>
            {DASHBOARD_RANGE_LABELS[range]}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

/** How many non-default filters hide behind the Filters button. */
function hiddenFilterCount(state: DashboardState): number {
  return (state.service ? 1 : 0) + (state.instance ? 1 : 0) + (state.refresh ? 0 : 1);
}

function TabletFilterBar({ state, onChange, services, instances, updatedAt }: DashboardFilterBarProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const popoverId = useId();
  return (
    <Stack
      direction="row"
      spacing={1.5}
      useFlexGap
      role="toolbar"
      aria-label="Dashboard filters"
      sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}
    >
      <RangeSelect state={state} onChange={onChange} />
      <Badge color="primary" badgeContent={hiddenFilterCount(state)}>
        <Button
          variant="outlined"
          startIcon={<TuneIcon />}
          aria-haspopup="dialog"
          aria-controls={anchor ? popoverId : undefined}
          aria-expanded={anchor ? 'true' : 'false'}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ minHeight: 40 }}
        >
          Filters
        </Button>
      </Badge>
      <ResetZoomChip state={state} onChange={onChange} />
      <Box sx={{ ml: 'auto' }}>
        <UpdatedAgo updatedAt={updatedAt} />
      </Box>
      <Popover
        id={popoverId}
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { role: 'dialog', 'aria-label': 'Filters', sx: { p: 2, width: 320 } } as object }}
      >
        <Stack spacing={2}>
          <FilterSelect
            label="Service"
            allLabel="All services"
            value={state.service}
            options={services}
            onChange={(service) => onChange({ service })}
            fullWidth
          />
          <FilterSelect
            label="Instance"
            allLabel="All instances"
            value={state.instance}
            options={instances}
            onChange={(instance) => onChange({ instance })}
            fullWidth
          />
          <RefreshSwitch checked={state.refresh} onChange={(refresh) => onChange({ refresh })} />
        </Stack>
      </Popover>
    </Stack>
  );
}

function PhoneFilterBar({ state, onChange, services, instances, updatedAt }: DashboardFilterBarProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DashboardState>(state);
  const titleId = useId();

  const openDialog = () => {
    setDraft(state);
    setOpen(true);
  };
  const patchDraft = (patch: Partial<DashboardState>) => setDraft((current) => ({ ...current, ...patch }));
  const apply = () => {
    onChange({
      range: draft.range,
      from: draft.from,
      to: draft.to,
      service: draft.service,
      instance: draft.instance,
      refresh: draft.refresh,
    });
    setOpen(false);
  };
  const reset = () => {
    const { range, from, to, service, instance, refresh } = DEFAULT_DASHBOARD_STATE;
    onChange({ range, from, to, service, instance, refresh });
    setOpen(false);
  };

  const rangeText = isZoomed(state) ? 'Zoomed' : state.range;

  return (
    <>
      <Paper
        square
        elevation={0}
        role="toolbar"
        aria-label="Dashboard filters"
        data-testid="phone-filter-bar"
        sx={{
          position: 'sticky',
          // Below the sticky AppBar (56px on phones).
          top: 56,
          zIndex: (theme) => theme.zIndex.appBar - 1,
          mx: -3,
          px: 3,
          py: 1,
          bgcolor: 'background.default',
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minWidth: 0,
        }}
      >
        <Chip label={rangeText} onClick={openDialog} aria-label={`Range: ${rangeText}. Change filters`} sx={{ minHeight: 44 }} />
        {isZoomed(state) && (
          <IconButton aria-label="Reset zoom" onClick={() => onChange({ from: null, to: null })} sx={{ width: 44, height: 44 }}>
            <ZoomOutIcon />
          </IconButton>
        )}
        <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <UpdatedAgo updatedAt={updatedAt} />
        </Box>
        <Badge color="primary" badgeContent={hiddenFilterCount(state)}>
          <Button
            variant="outlined"
            startIcon={<TuneIcon />}
            aria-haspopup="dialog"
            onClick={openDialog}
            sx={{ minHeight: 44 }}
          >
            Filters
          </Button>
        </Badge>
      </Paper>

      <Dialog fullScreen open={open} onClose={() => setOpen(false)} aria-labelledby={titleId}>
        <DialogTitle id={titleId} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Filters
          <IconButton aria-label="Close filters" onClick={() => setOpen(false)} sx={{ width: 44, height: 44 }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={3} sx={{ pt: 1 }}>
            <RangeSelect state={draft} onChange={patchDraft} fullWidth />
            <FilterSelect
              label="Service"
              allLabel="All services"
              value={draft.service}
              options={services}
              onChange={(service) => patchDraft({ service })}
              fullWidth
            />
            <FilterSelect
              label="Instance"
              allLabel="All instances"
              value={draft.instance}
              options={instances}
              onChange={(instance) => patchDraft({ instance })}
              fullWidth
            />
            <RefreshSwitch checked={draft.refresh} onChange={(refresh) => patchDraft({ refresh })} />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button onClick={reset} sx={{ minHeight: 44 }}>
            Reset
          </Button>
          <Button variant="contained" onClick={apply} sx={{ minHeight: 44, flex: 1 }}>
            Apply
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export function DashboardFilterBar(props: DashboardFilterBarProps) {
  if (props.layout === 'phone') return <PhoneFilterBar {...props} />;
  if (props.layout === 'tablet') return <TabletFilterBar {...props} />;
  return <DesktopFilterBar {...props} />;
}

function DesktopFilterBar({ state, onChange, services, instances, updatedAt }: DashboardFilterBarProps) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      useFlexGap
      role="toolbar"
      aria-label="Dashboard filters"
      sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}
    >
      <RangeToggle state={state} onChange={onChange} />
      <ResetZoomChip state={state} onChange={onChange} />
      <FilterSelect
        label="Service"
        allLabel="All services"
        value={state.service}
        options={services}
        onChange={(service) => onChange({ service })}
      />
      <FilterSelect
        label="Instance"
        allLabel="All instances"
        value={state.instance}
        options={instances}
        onChange={(instance) => onChange({ instance })}
      />
      <RefreshSwitch checked={state.refresh} onChange={(refresh) => onChange({ refresh })} />
      <UpdatedAgo updatedAt={updatedAt} />
    </Stack>
  );
}
