/**
 * Biomarkers (`/health/biomarkers`), H5 (#189): the user's blood work over
 * time, one card per analyte with at least one result, grouped by panel.
 * Reached from the "Blood work" section of the Health page; part of the
 * `health` destination through the `/health` prefix. Not a settings page.
 *
 * Filters (out-of-range only, panel) are sent to the API
 * (`GET /api/health/biomarkers/summary?panel=&outOfRange=`), which decides
 * what "out of range" means (the latest result's flag). With no results at
 * all, the empty state points to "Import lab report" (H4).
 *
 * `health_data:read` decides whether there is anything to show (the API
 * enforces it on every call; this only avoids asking).
 */
import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  FormControlLabel,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import FilterListOffIcon from '@mui/icons-material/FilterListOff';
import { HEALTH_DATA_UNAVAILABLE } from '../services/health';
import { LAB_PANELS, LAB_PANEL_LABELS, labMetrics, type LabPanel } from '../services/labReport';
import { usePermissions } from '../hooks/usePermissions';
import { useBiomarkerSummary } from '../hooks/useBiomarkers';
import { useMeasurementCatalog } from '../hooks/useMeasurementCatalog';
import { useCanReadFromPhoto } from '../hooks/useCanReadFromPhoto';
import { EmptyState } from '../components/common/EmptyState';
import { BIOMARKERS_TITLE, BiomarkerList, STANDARD_UNITS_NOTE } from '../components/health/biomarkers/BiomarkerList';
import { LabReportButton } from '../components/health/LabReportButton';
import { LabReportDialog } from '../components/health/LabReportDialog';


function BiomarkerListSkeleton() {
  return (
    <Stack spacing={2} data-testid="biomarkers-skeleton">
      <Skeleton variant="text" width={160} height={32} />
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' } }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={150} />
        ))}
      </Box>
    </Stack>
  );
}

function BiomarkersOverview() {
  const [outOfRange, setOutOfRange] = useState(false);
  const [panel, setPanel] = useState<LabPanel | ''>('');
  const [labOpen, setLabOpen] = useState(false);
  const canImport = useCanReadFromPhoto();
  const summary = useBiomarkerSummary({ outOfRange, panel: panel || undefined });
  const { catalog } = useMeasurementCatalog();
  const decimals = useMemo(
    () => new Map(labMetrics(catalog).map((metric) => [metric.key, metric.decimals])),
    [catalog],
  );
  const filtered = outOfRange || panel !== '';
  const clearFilters = () => {
    setOutOfRange(false);
    setPanel('');
  };

  const body = () => {
    if (summary.forbidden) return <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>;
    if (summary.error && !summary.isLoading) {
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={summary.refresh}>
              Retry
            </Button>
          }
        >
          Could not load your biomarkers. {summary.error}
        </Alert>
      );
    }
    if (!summary.data) return <BiomarkerListSkeleton />;
    if (summary.data.length === 0) {
      return filtered ? (
        <EmptyState
          Icon={FilterListOffIcon}
          title="No biomarkers match these filters"
          description={
            outOfRange
              ? 'None of your latest results is flagged out of range.'
              : 'You have no results in this panel yet.'
          }
          action={
            <Button variant="outlined" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <EmptyState
          Icon={ScienceOutlinedIcon}
          title="No blood work yet"
          description={
            canImport
              ? 'Import a lab report (a PDF or photos of the pages) and your results will appear here, grouped by panel.'
              : 'Results from your lab reports appear here, grouped by panel, once they are imported.'
          }
          action={canImport ? <LabReportButton variant="contained" onClick={() => setLabOpen(true)} /> : undefined}
        />
      );
    }
    return <BiomarkerList items={summary.data} decimals={decimals} />;
  };

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2, mb: 2 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h4" component="h1" gutterBottom>
            {BIOMARKERS_TITLE}
          </Typography>
          <Typography color="text.secondary">Your blood work over time. {STANDARD_UNITS_NOTE}</Typography>
        </Box>
        {!summary.forbidden && <LabReportButton onClick={() => setLabOpen(true)} />}
      </Box>

      {!summary.forbidden && (
        <Box
          role="group"
          aria-label="Filters"
          sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, mb: 3 }}
        >
          <TextField
            id="biomarker-panel-filter"
            select
            size="small"
            label="Panel"
            value={panel}
            onChange={(event) => setPanel(event.target.value as LabPanel | '')}
            sx={{ width: { xs: '100%', sm: 240 } }}
          >
            <MenuItem value="">All panels</MenuItem>
            {LAB_PANELS.map((key) => (
              <MenuItem key={key} value={key}>
                {LAB_PANEL_LABELS[key]}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={<Switch checked={outOfRange} onChange={(event) => setOutOfRange(event.target.checked)} />}
            label="Out of range only"
          />
        </Box>
      )}

      {body()}

      <LabReportDialog
        open={labOpen && !summary.forbidden}
        onClose={() => setLabOpen(false)}
        onSaved={() => summary.refresh()}
      />
    </>
  );
}

export default function BiomarkersPage() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('health_data:read');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Button component={RouterLink} to="/health" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
          Health
        </Button>
        {canRead ? (
          <BiomarkersOverview />
        ) : (
          <>
            <Typography variant="h4" component="h1" gutterBottom>
              {BIOMARKERS_TITLE}
            </Typography>
            <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>
          </>
        )}
      </Box>
    </Container>
  );
}
