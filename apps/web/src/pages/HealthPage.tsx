/**
 * Health (`/health`), issue #53 (E2.3): the latest body and vital values and
 * the quick-entry dialog. Replaces the E1 placeholder.
 *
 * `health_data:read` decides whether there is anything to show (the API
 * enforces it on every call; this only avoids asking); `health_data:write`
 * enables the Log buttons. Later stories append sections below the tiles in
 * the same plain stack, no tabs: tiles, Daily check-in (E2.4), then Trend and
 * History (E2.5, #60, `HealthHistorySections`).
 *
 * E2.6 (#64): "Read from photo" sits next to "Log measurement" (and inside the
 * quick-entry dialog) when AI and the needed permissions allow it
 * (`useCanReadFromPhoto`); it opens `PhotoReadDialog`, which saves one entry
 * through the photo-intake apply and refreshes the tiles and History.
 *
 * H7 (#191): "Export health data" sits with the header actions for anyone who
 * can read health data, whatever the AI state; it opens
 * `ExportHealthDataDialog` (format, range, datasets, progress, download).
 *
 * H4 (#188): "Import lab report" sits beside it under the same gate and opens
 * `LabReportDialog` (a PDF or page photos become reviewed lab results).
 *
 * H5 (#189): the "Blood work" section links to the biomarker views
 * (`/health/biomarkers`), between the check-in and Trend/History.
 *
 * E7.9 (#249): the "Progress photos" section, right after Blood work, links
 * to the private gallery (`/health/progress-photos`).
 *
 * #283 (epic #276): the "Sleep" section, right after Progress photos, shows
 * the last 14 nights (asleep time and a stage bar) from `GET /api/sleep`.
 */

import { useState } from 'react';
import { Alert, Box, Button, Container, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { HEALTH_DATA_UNAVAILABLE, type MetricKey } from '../services/health';
import { usePermissions } from '../hooks/usePermissions';
import { useHealthProfile } from '../hooks/useHealthProfile';
import { useLatestMeasurements } from '../hooks/useLatestMeasurements';
import { useMeasurementCatalog } from '../hooks/useMeasurementCatalog';
import {
  LatestMeasurementTiles,
  LatestMeasurementTilesSkeleton,
} from '../components/health/LatestMeasurementTiles';
import { LogMeasurementDialog } from '../components/health/LogMeasurementDialog';
import { LogMeasurementButton } from '../components/health/LogMeasurementButton';
import { CheckInSection } from '../components/health/CheckInSection';
import { HealthHistorySections } from '../components/health/HealthHistorySections';
import { PhotoReadButton } from '../components/health/PhotoReadButton';
import { PhotoReadDialog } from '../components/health/PhotoReadDialog';
import { ExportHealthDataDialog } from '../components/health/ExportHealthDataDialog';
import { LabReportButton } from '../components/health/LabReportButton';
import { LabReportDialog } from '../components/health/LabReportDialog';
import { BloodWorkSection } from '../components/health/biomarkers/BloodWorkSection';
import { labUnitsOf } from '../utils/labUnits';
import { ProgressPhotosSection } from '../components/health/ProgressPhotosSection';
import { SleepSection } from '../components/health/SleepSection';

function HealthOverview({ canLog }: { canLog: boolean }) {
  const {
    catalog,
    isLoading: catalogLoading,
    error: catalogError,
    errorStatus,
    refresh: retryCatalog,
  } = useMeasurementCatalog();
  const latest = useLatestMeasurements();
  const { profile, isLoading: profileLoading } = useHealthProfile();
  const [dialog, setDialog] = useState<{ open: boolean; focusMetric?: MetricKey }>({ open: false });
  // E2.6 (#64): the photo-read dialog, opened from the header or over the quick-entry dialog.
  const [photoOpen, setPhotoOpen] = useState(false);
  // H7 (#191): the export dialog. Reading is enough: exporting changes nothing.
  const [exportOpen, setExportOpen] = useState(false);
  // H4 (#188): the lab report import.
  const [labOpen, setLabOpen] = useState(false);
  // Bumped after every change to readings: the Trend chart and History refetch.
  const [readingsVersion, setReadingsVersion] = useState(0);
  const readingsChanged = () => {
    void latest.refresh();
    setReadingsVersion((n) => n + 1);
  };

  const openDialog = (focusMetric?: MetricKey) => setDialog({ open: true, focusMetric });
  // "Enter manually": the quick-entry dialog, left as it was when it is already open.
  const enterManually = () => {
    setPhotoOpen(false);
    setDialog((prev) => (prev.open ? prev : { open: true }));
  };
  const forbidden = latest.forbidden || errorStatus === 403;
  // A refetch after a save keeps the tiles on screen; only the first load shows skeletons.
  const loading = catalogLoading || profileLoading || (latest.isLoading && latest.items.length === 0);
  const loadError = latest.error ?? (catalog ? null : catalogError);

  const retry = () => {
    if (!catalog) retryCatalog();
    void latest.refresh();
  };

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2, mb: 3 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h4" component="h1" gutterBottom>
            Health
          </Typography>
          <Typography color="text.secondary">Your body and how you feel</Typography>
        </Box>
        {!forbidden && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <Button variant="outlined" startIcon={<FileDownloadOutlinedIcon />} onClick={() => setExportOpen(true)}>
              Export health data
            </Button>
            <PhotoReadButton onClick={() => setPhotoOpen(true)} showUnavailable />
            <LabReportButton onClick={() => setLabOpen(true)} />
            <LogMeasurementButton variant="contained" startIcon={<AddIcon />} canLog={canLog} onClick={() => openDialog()}>
              Log measurement
            </LogMeasurementButton>
          </Box>
        )}
      </Box>

      <Stack spacing={4}>
        {forbidden ? (
          <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>
        ) : loadError && !loading ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={retry}>
                Retry
              </Button>
            }
          >
            Could not load your measurements. {loadError}
          </Alert>
        ) : loading || !catalog ? (
          <LatestMeasurementTilesSkeleton />
        ) : (
          <Box component="section" aria-label="Latest measurements">
            <LatestMeasurementTiles
              catalog={catalog}
              items={latest.items}
              unitSystem={profile?.unitSystem ?? 'metric'}
              heightMm={profile?.heightMm ?? null}
              canLog={canLog}
              onLog={openDialog}
            />
          </Box>
        )}
        {/* E2.4 (#56): today's check-in and the recent ones. */}
        {!forbidden && <CheckInSection canWrite={canLog} />}

        {/* H5 (#189): the way into the blood-work history. */}
        {!forbidden && <BloodWorkSection labUnits={labUnitsOf(profile)} />}

        {/* E7.9 (#249): the way into the private progress-photo gallery. */}
        {!forbidden && <ProgressPhotosSection />}

        {/* #283 (epic #276): the last 14 nights, synced from Health Connect. */}
        {!forbidden && !profileLoading && <SleepSection timeZone={profile?.timeZone} />}

        {!forbidden && catalog && !loading && (
          <HealthHistorySections
            catalog={catalog}
            profile={profile}
            canWrite={canLog}
            refreshToken={readingsVersion}
            onChanged={readingsChanged}
            onLog={openDialog}
          />
        )}
      </Stack>

      <LogMeasurementDialog
        open={dialog.open}
        focusMetric={dialog.focusMetric}
        latest={latest.items}
        profile={profile}
        onClose={() => setDialog((prev) => ({ ...prev, open: false }))}
        onSaved={readingsChanged}
        onReadFromPhoto={() => setPhotoOpen(true)}
      />

      <PhotoReadDialog
        open={photoOpen && !forbidden}
        profile={profile}
        onClose={() => setPhotoOpen(false)}
        onEnterManually={enterManually}
        onSaved={readingsChanged}
      />

      <ExportHealthDataDialog
        open={exportOpen && !forbidden}
        onClose={() => setExportOpen(false)}
        defaultLabUnits={labUnitsOf(profile)}
      />
      <LabReportDialog open={labOpen && !forbidden} onClose={() => setLabOpen(false)} onSaved={readingsChanged} />
    </>
  );
}

export default function HealthPage() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('health_data:read');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {canRead ? (
          <HealthOverview canLog={hasPermission('health_data:write')} />
        ) : (
          <>
            <Typography variant="h4" component="h1" gutterBottom>
              Health
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              Your body and how you feel
            </Typography>
            <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>
          </>
        )}
      </Box>
    </Container>
  );
}
