/**
 * The Trend and History sections of the Health page, issue #60 (E2.5), with
 * the Edit and Delete flows they start.
 *
 * Two stacked sections, never tabs: the chart and the list are two views of
 * the same readings, and the list is the chart's text equivalent, so hiding
 * either behind a tab would hide that equivalent.
 *
 * The page owns what else shows a reading (the latest tiles and, with E2.4,
 * the Today card): after an edit or a delete this calls `onChanged`, and the
 * page refreshes those and bumps `refreshToken`, which refetches the chart and
 * the list here as well.
 */

import { useId, useMemo, useState } from 'react';
import { Box, Snackbar, Typography } from '@mui/material';
import type { HealthProfile, MetricCatalog, MetricKey } from '../../services/health';
import type { HistoryEntry } from '../../utils/measurementSeries';
import { MeasurementTrendChart } from './MeasurementTrendChart';
import { MeasurementHistory } from './MeasurementHistory';
import { DeleteEntryDialog } from './DeleteEntryDialog';
import { LogMeasurementDialog } from './LogMeasurementDialog';

export interface HealthHistorySectionsProps {
  catalog: MetricCatalog;
  profile: HealthProfile | null;
  canWrite: boolean;
  /** Bumped by the page whenever readings change (a log here or elsewhere). */
  refreshToken: number;
  /** An entry was edited or deleted (or found gone): refresh everything that shows readings. */
  onChanged: () => void;
  /** Open the quick-entry dialog focused on a metric (the chart's empty state). */
  onLog: (metricKey: MetricKey) => void;
  /** Tests only: a fixed chart width (jsdom has no layout). */
  chartWidth?: number;
}

export function HealthHistorySections({
  catalog,
  profile,
  canWrite,
  refreshToken,
  onChanged,
  onLog,
  chartWidth,
}: HealthHistorySectionsProps) {
  const trendHeading = useId();
  const historyHeading = useId();
  const unitSystem = profile?.unitSystem ?? 'metric';
  const methodLabels = useMemo(
    () => new Map(catalog.methods.map((method) => [method.key, method.label])),
    [catalog],
  );
  const metricsByKey = useMemo(() => new Map(catalog.metrics.map((m) => [m.key, m])), [catalog]);

  const [editing, setEditing] = useState<{ open: boolean; entry: HistoryEntry | null }>({ open: false, entry: null });
  const [deleting, setDeleting] = useState<{ open: boolean; entry: HistoryEntry | null }>({ open: false, entry: null });
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <Box component="section" aria-labelledby={trendHeading}>
        <Typography id={trendHeading} variant="h5" component="h2" gutterBottom>
          Trend
        </Typography>
        <MeasurementTrendChart
          metrics={catalog.metrics}
          methodLabels={methodLabels}
          unitSystem={unitSystem}
          canLog={canWrite}
          onLog={(metricKey) => onLog(metricKey as MetricKey)}
          refreshToken={refreshToken}
          width={chartWidth}
        />
      </Box>

      <Box component="section" aria-labelledby={historyHeading}>
        <Typography id={historyHeading} variant="h5" component="h2" gutterBottom>
          History
        </Typography>
        <MeasurementHistory
          metrics={catalog.metrics}
          methodLabels={methodLabels}
          unitSystem={unitSystem}
          canWrite={canWrite}
          refreshToken={refreshToken}
          onEdit={(entry) => setEditing({ open: true, entry })}
          onDelete={(entry) => setDeleting({ open: true, entry })}
        />
      </Box>

      <LogMeasurementDialog
        open={editing.open}
        entry={editing.entry}
        profile={profile}
        onClose={() => setEditing((prev) => ({ ...prev, open: false }))}
        onSaved={() => onChanged()}
        onStale={(reason) => {
          setNotice(
            reason === 'gone'
              ? 'That entry was already removed. Your history has been reloaded.'
              : 'That entry was changed elsewhere and has been reloaded. Try your edit again.',
          );
          onChanged();
        }}
      />

      <DeleteEntryDialog
        open={deleting.open}
        entry={deleting.entry}
        metricsByKey={metricsByKey}
        unitSystem={unitSystem}
        onClose={() => setDeleting((prev) => ({ ...prev, open: false }))}
        onDeleted={() => {
          setNotice('Entry deleted');
          onChanged();
        }}
        onMissing={() => {
          setNotice('That entry was already removed. Your history has been reloaded.');
          onChanged();
        }}
      />

      <Snackbar
        open={notice !== null}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        message={notice ?? ''}
      />
    </>
  );
}

export default HealthHistorySections;
