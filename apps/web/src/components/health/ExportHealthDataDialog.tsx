/**
 * "Export health data" (issue #191, H7): choose a format, a range and the
 * datasets, queue the export, watch it finish and download it.
 *
 * The dialog collects and presents; the API decides. Its own checks (at least
 * one dataset, a sane custom range) only explain a problem before the round
 * trip, and a `400` or `429` from the API is shown in words a person can act
 * on. Progress lives in the "Recent exports" list (`useHealthExports`), which
 * is re-read whenever the dialog opens, so closing it never loses an export.
 *
 * Full-screen below `sm` through its own media query: a local layout choice,
 * not one of the five coupled shell gates (docs/specs/settings-ui.md).
 */

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormHelperText,
  FormLabel,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import {
  HEALTH_EXPORT_DATASETS,
  HEALTH_EXPORT_DATASET_LABELS,
  HEALTH_EXPORT_FORMATS,
  HEALTH_EXPORT_FORMAT_DESCRIPTIONS,
  HEALTH_EXPORT_FORMAT_LABELS,
  HEALTH_EXPORT_RANGE_LABELS,
  HEALTH_EXPORT_RANGE_PRESETS,
  HEALTH_EXPORT_STATUS_LABELS,
  customRangeProblem,
  describeHealthExportError,
  formatExportSize,
  isHealthExportActive,
  localToday,
  rangeForPreset,
  type HealthExport,
  type HealthExportDataset,
  type HealthExportFormat,
  type HealthExportRangePreset,
  type HealthExportStatus,
} from '../../services/healthExport';
import { useHealthExports, type UseHealthExportsOptions } from '../../hooks/useHealthExports';

export interface ExportHealthDataDialogProps extends UseHealthExportsOptions {
  open: boolean;
  onClose: () => void;
  /** The user's calendar date, `YYYY-MM-DD`; tests pin it. Defaults to the local date. */
  today?: string;
}

const STATUS_COLORS: Record<HealthExportStatus, 'default' | 'info' | 'success' | 'error'> = {
  pending: 'info',
  running: 'info',
  ready: 'success',
  failed: 'error',
  expired: 'default',
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function describeExport(item: HealthExport): string {
  return `${HEALTH_EXPORT_FORMAT_LABELS[item.format]}, ${item.from} to ${item.to}`;
}

/** What the live region says about the export started in this dialog. */
function statusAnnouncement(item: HealthExport): string {
  switch (item.status) {
    case 'pending':
    case 'running':
      return 'Preparing your export. You can close this dialog; it keeps going.';
    case 'ready':
      return 'Your export is ready to download.';
    case 'expired':
      return 'Your export has expired.';
    case 'failed':
      return item.error ?? 'The export could not be created. Please try again.';
  }
}

interface RecentExportProps {
  item: HealthExport;
  highlighted: boolean;
  downloading: boolean;
  onDownload: (item: HealthExport) => void;
}

function RecentExport({ item, highlighted, downloading, onDownload }: RecentExportProps) {
  const size = formatExportSize(item.sizeBytes);
  const active = isHealthExportActive(item);
  return (
    <Box
      component="li"
      aria-label={`${describeExport(item)}, ${HEALTH_EXPORT_STATUS_LABELS[item.status]}`}
      sx={{
        listStyle: 'none',
        p: 1.5,
        borderRadius: 1,
        border: 1,
        borderColor: highlighted ? 'primary.main' : 'divider',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {describeExport(item)}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5, mt: 0.5 }}>
            <Chip size="small" color={STATUS_COLORS[item.status]} label={HEALTH_EXPORT_STATUS_LABELS[item.status]} />
            {size && (
              <Typography variant="caption" color="text.secondary">
                {size}
              </Typography>
            )}
            {item.status === 'ready' && item.expiresAt && (
              <Typography variant="caption" color="text.secondary">
                Expires {formatDateTime(item.expiresAt)}
              </Typography>
            )}
            {item.status === 'failed' && item.error && (
              <Typography variant="caption" color="error">
                {item.error}
              </Typography>
            )}
          </Stack>
        </Box>
        {item.status === 'ready' && (
          <Button
            size="small"
            variant={highlighted ? 'contained' : 'outlined'}
            startIcon={downloading ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
            disabled={downloading}
            onClick={() => onDownload(item)}
            aria-label={`Download ${describeExport(item)}`}
          >
            Download
          </Button>
        )}
      </Stack>
      {active && (
        <LinearProgress sx={{ mt: 1 }} aria-label={`Export ${HEALTH_EXPORT_STATUS_LABELS[item.status].toLowerCase()}`} />
      )}
    </Box>
  );
}

export function ExportHealthDataDialog({ open, onClose, today: todayProp, pollIntervalMs, openUrl }: ExportHealthDataDialogProps) {
  const theme = useTheme();
  // A local layout choice for this dialog, NOT one of the five coupled `sm`
  // shell gates (docs/specs/settings-ui.md#breakpoint-gates).
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const idBase = useId();
  const titleId = `${idBase}-title`;
  const recentId = `${idBase}-recent`;

  const { items, isLoading, error: listError, refresh, create, download } = useHealthExports(open, {
    pollIntervalMs,
    openUrl,
  });

  const [format, setFormat] = useState<HealthExportFormat>('pdf');
  const [preset, setPreset] = useState<HealthExportRangePreset>('3m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [datasets, setDatasets] = useState<HealthExportDataset[]>([...HEALTH_EXPORT_DATASETS]);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  // The day is read again on every opening, so the presets end on the right day.
  const [localDay, setLocalDay] = useState(() => localToday());
  const today = todayProp ?? localDay;

  // Each opening starts from a clean status (the form keeps the last choices).
  useEffect(() => {
    if (!open) return;
    setLocalDay(localToday());
    setSubmitted(false);
    setCreateError(null);
    setDownloadError(null);
    setCurrentId(null);
  }, [open]);

  const range = useMemo(
    () => (preset === 'custom' ? { from: customFrom, to: customTo } : rangeForPreset(preset, today)),
    [preset, customFrom, customTo, today],
  );
  const rangeProblem = preset === 'custom' ? customRangeProblem(customFrom, customTo, today) : null;
  const datasetProblem = datasets.length === 0 ? 'Choose at least one dataset' : null;
  const current = currentId ? (items ?? []).find((item) => item.id === currentId) ?? null : null;

  const toggleDataset = (dataset: HealthExportDataset, checked: boolean) => {
    setDatasets((prev) => (checked ? [...prev, dataset] : prev.filter((d) => d !== dataset)));
  };

  const choosePreset = (next: HealthExportRangePreset) => {
    // Custom starts from the range that was showing, so it is a tweak rather than a blank.
    if (next === 'custom' && preset !== 'custom') {
      setCustomFrom(range.from);
      setCustomTo(range.to);
    }
    setPreset(next);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (rangeProblem || datasetProblem || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await create({ format, from: range.from, to: range.to, datasets, includeHistory });
      setCurrentId(created.id);
      setSubmitted(false);
    } catch (err) {
      setCreateError(describeHealthExportError(err, 'Could not create the export. Check your connection and try again.'));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const onDownload = async (item: HealthExport) => {
    setDownloadingId(item.id);
    setDownloadError(null);
    const problem = await download(item.id);
    setDownloadingId(null);
    setDownloadError(problem);
  };

  return (
    <Dialog
      open={open}
      onClose={creating ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
    >
      <Box
        component="form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}
      >
        <DialogTitle id={titleId}>Export health data</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={3}>
            <FormControl component="fieldset" disabled={creating}>
              <FormLabel component="legend">Format</FormLabel>
              <RadioGroup
                name={`${idBase}-format`}
                value={format}
                onChange={(event) => setFormat(event.target.value as HealthExportFormat)}
              >
                {HEALTH_EXPORT_FORMATS.map((value) => (
                  <FormControlLabel
                    key={value}
                    value={value}
                    control={<Radio />}
                    label={
                      <Box>
                        <Typography component="span">{HEALTH_EXPORT_FORMAT_LABELS[value]}</Typography>
                        <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
                          {HEALTH_EXPORT_FORMAT_DESCRIPTIONS[value]}
                        </Typography>
                      </Box>
                    }
                    sx={{ alignItems: 'flex-start', '& .MuiRadio-root': { pt: 0.5 }, mb: 0.5 }}
                  />
                ))}
              </RadioGroup>
            </FormControl>

            <FormControl component="fieldset" disabled={creating}>
              <FormLabel component="legend">Date range</FormLabel>
              <RadioGroup
                row
                name={`${idBase}-range`}
                value={preset}
                onChange={(event) => choosePreset(event.target.value as HealthExportRangePreset)}
              >
                {HEALTH_EXPORT_RANGE_PRESETS.map((value) => (
                  <FormControlLabel key={value} value={value} control={<Radio />} label={HEALTH_EXPORT_RANGE_LABELS[value]} />
                ))}
              </RadioGroup>
              {preset === 'custom' ? (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1.5 }}>
                  <TextField
                    id={`${idBase}-from`}
                    label="From"
                    type="date"
                    value={customFrom}
                    onChange={(event) => setCustomFrom(event.target.value)}
                    disabled={creating}
                    error={submitted && !!rangeProblem}
                    slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: today } }}
                    fullWidth
                  />
                  <TextField
                    id={`${idBase}-to`}
                    label="To"
                    type="date"
                    value={customTo}
                    onChange={(event) => setCustomTo(event.target.value)}
                    disabled={creating}
                    error={submitted && !!rangeProblem}
                    slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: today } }}
                    fullWidth
                  />
                </Stack>
              ) : null}
              {submitted && rangeProblem ? (
                <FormHelperText error>{rangeProblem}</FormHelperText>
              ) : (
                !rangeProblem && (
                  <FormHelperText>
                    From {range.from} to {range.to}
                  </FormHelperText>
                )
              )}
            </FormControl>

            <FormControl component="fieldset" disabled={creating} error={submitted && !!datasetProblem}>
              <FormLabel component="legend">Include</FormLabel>
              <FormGroup>
                {HEALTH_EXPORT_DATASETS.map((dataset) => (
                  <FormControlLabel
                    key={dataset}
                    control={
                      <Checkbox
                        checked={datasets.includes(dataset)}
                        onChange={(event) => toggleDataset(dataset, event.target.checked)}
                      />
                    }
                    label={HEALTH_EXPORT_DATASET_LABELS[dataset]}
                  />
                ))}
              </FormGroup>
              {submitted && datasetProblem && <FormHelperText>{datasetProblem}</FormHelperText>}
            </FormControl>

            <FormControlLabel
              disabled={creating}
              control={<Switch checked={includeHistory} onChange={(event) => setIncludeHistory(event.target.checked)} />}
              label={
                <Box>
                  <Typography component="span">Include edit history</Typography>
                  <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
                    Also export earlier versions of readings you edited. Deleted readings are never exported.
                  </Typography>
                </Box>
              }
              sx={{ alignItems: 'flex-start', '& .MuiSwitch-root': { mt: -0.5 } }}
            />

            {createError && <Alert severity="error">{createError}</Alert>}

            <Divider />

            <Box component="section" aria-labelledby={recentId}>
              <Typography id={recentId} variant="subtitle1" component="h3" sx={{ mb: 1 }}>
                Recent exports
              </Typography>
              <Typography role="status" variant="body2" sx={{ mb: current ? 1 : 0 }}>
                {current ? statusAnnouncement(current) : ''}
              </Typography>
              {downloadError && (
                <Alert severity="error" sx={{ mb: 1 }}>
                  {downloadError}
                </Alert>
              )}
              {listError && !items ? (
                <Alert
                  severity="error"
                  action={
                    <Button color="inherit" size="small" onClick={() => void refresh()}>
                      Retry
                    </Button>
                  }
                >
                  {listError}
                </Alert>
              ) : items === null ? (
                isLoading && (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                    <CircularProgress size={24} aria-label="Loading recent exports" />
                  </Box>
                )
              ) : items.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No exports yet. Files are kept for 7 days.
                </Typography>
              ) : (
                <Stack component="ul" spacing={1} aria-labelledby={recentId} sx={{ p: 0, m: 0 }}>
                  {items.map((item) => (
                    <RecentExport
                      key={item.id}
                      item={item}
                      highlighted={item.id === currentId}
                      downloading={downloadingId === item.id}
                      onDownload={(target) => void onDownload(target)}
                    />
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>
        </DialogContent>

        <DialogActions>
          <Button onClick={onClose} disabled={creating}>
            Close
          </Button>
          <Button type="submit" variant="contained" disabled={creating}>
            {creating ? 'Creating…' : 'Create export'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
