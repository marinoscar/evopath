/**
 * One biomarker (`/health/biomarkers/:analyteKey`), H5 (#189): the trend of
 * every result with the lab's reference range drawn per result, then every
 * result in a table (cards on a phone) with its range, flag, origin and
 * source report. A value opens its revision history.
 *
 * The analyte must be a lab metric of the catalog (`GET /api/measurements/metrics`);
 * anything else reads "not found" without asking the API for its results.
 * Values are canonical and shown as they are (docs/specs/health-records.md §2.8).
 */
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { Alert, Box, Button, Container, Pagination, Skeleton, Stack, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { HEALTH_DATA_UNAVAILABLE } from '../services/health';
import { LAB_PANELS, LAB_PANEL_LABELS, labMetrics, type LabPanel } from '../services/labReport';
import type { LabMeasurement } from '../services/biomarkers';
import { usePermissions } from '../hooks/usePermissions';
import { useMeasurementCatalog } from '../hooks/useMeasurementCatalog';
import { useBiomarkerResults, useBiomarkerSeries } from '../hooks/useBiomarkers';
import { EmptyState } from '../components/common/EmptyState';
import { BIOMARKERS_TITLE } from '../components/health/biomarkers/BiomarkerList';
import { BiomarkerTrendChart } from '../components/health/biomarkers/BiomarkerTrendChart';
import { BiomarkerResults } from '../components/health/biomarkers/BiomarkerResults';
import { RevisionHistoryDialog } from '../components/health/biomarkers/RevisionHistoryDialog';

function panelLabel(panel: string | null | undefined): string {
  return panel && (LAB_PANELS as readonly string[]).includes(panel) ? LAB_PANEL_LABELS[panel as LabPanel] : LAB_PANEL_LABELS.other;
}

function RetryAlert({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert
      severity="error"
      action={
        <Button color="inherit" size="small" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {message}
    </Alert>
  );
}

function BiomarkerDetail({ analyteKey }: { analyteKey: string }) {
  const { catalog, isLoading: catalogLoading, error: catalogError, errorStatus, refresh: retryCatalog } =
    useMeasurementCatalog();
  const metric = labMetrics(catalog).find((m) => m.key === analyteKey) ?? null;
  const known = metric !== null;
  const [page, setPage] = useState(1);
  const [historyOf, setHistoryOf] = useState<LabMeasurement | null>(null);
  const series = useBiomarkerSeries(known ? analyteKey : null);
  const results = useBiomarkerResults(known ? analyteKey : null, page);

  if (errorStatus === 403 || series.forbidden || results.forbidden) {
    return <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>;
  }
  if (!catalog) {
    if (catalogError && !catalogLoading) {
      return <RetryAlert message={`Could not load the lab catalog. ${catalogError}`} onRetry={retryCatalog} />;
    }
    return <Skeleton variant="rounded" height={320} data-testid="biomarker-detail-skeleton" />;
  }
  if (!metric) {
    return (
      <>
        <Typography variant="h4" component="h1" gutterBottom>
          Biomarker not found
        </Typography>
        <Alert severity="info">There is no lab test called “{analyteKey}”.</Alert>
      </>
    );
  }

  const label = metric.label;
  const unit = metric.canonicalUnit;
  const points = series.data?.points ?? [];
  const rows = results.data?.items ?? [];

  const trend = () => {
    if (series.error && !series.isLoading) {
      return <RetryAlert message={`Could not load the chart. ${series.error}`} onRetry={series.refresh} />;
    }
    if (!series.data) return <Skeleton variant="rounded" height={300} data-testid="biomarker-chart-skeleton" />;
    if (points.length === 0) {
      return (
        <EmptyState
          Icon={ScienceOutlinedIcon}
          headingLevel="h3"
          title={`No ${label} results in the last five years`}
          description="Import a lab report from the Biomarkers page to add results."
        />
      );
    }
    return (
      <Stack spacing={1.5}>
        {series.data.truncated && <Alert severity="info">Showing your most recent 1000 results.</Alert>}
        <BiomarkerTrendChart label={label} unit={unit} decimals={metric.decimals} points={points} />
        {points.some((p) => p.referenceLow !== null || p.referenceHigh !== null) && (
          <Typography variant="caption" color="text.secondary">
            The shaded band is the reference range printed with each result; labs can print different ranges.
          </Typography>
        )}
      </Stack>
    );
  };

  const table = () => {
    if (results.error && !results.isLoading) {
      return <RetryAlert message={`Could not load the results. ${results.error}`} onRetry={results.refresh} />;
    }
    if (!results.data) return <Skeleton variant="rounded" height={200} data-testid="biomarker-results-skeleton" />;
    if (rows.length === 0) {
      return (
        <Typography color="text.secondary">No results yet.</Typography>
      );
    }
    return (
      <Stack spacing={2}>
        <BiomarkerResults label={label} decimals={metric.decimals} rows={rows} onShowHistory={setHistoryOf} />
        {results.data.totalPages > 1 && (
          <Pagination
            count={results.data.totalPages}
            page={page}
            onChange={(_event, next) => setPage(next)}
            size="small"
            sx={{ alignSelf: 'center' }}
            getItemAriaLabel={(type, item) =>
              type === 'page' ? `Results page ${item}` : type === 'next' ? 'Next results page' : 'Previous results page'
            }
          />
        )}
      </Stack>
    );
  };

  return (
    <>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {label}
        </Typography>
        <Typography color="text.secondary">
          {panelLabel(metric.panel)} · Shown in {unit}, the standard unit for this test.
        </Typography>
      </Box>

      <Stack spacing={4}>
        <Box component="section" aria-labelledby="biomarker-trend-heading">
          <Typography id="biomarker-trend-heading" variant="h6" component="h2" sx={{ mb: 1.5 }}>
            Trend
          </Typography>
          {trend()}
        </Box>
        <Box component="section" aria-labelledby="biomarker-results-heading">
          <Typography id="biomarker-results-heading" variant="h6" component="h2" sx={{ mb: 1 }}>
            Results
          </Typography>
          {table()}
        </Box>
      </Stack>

      <RevisionHistoryDialog
        measurementId={historyOf?.id ?? null}
        label={label}
        decimals={metric.decimals}
        onClose={() => setHistoryOf(null)}
      />
    </>
  );
}

export default function BiomarkerDetailPage() {
  const { analyteKey = '' } = useParams<{ analyteKey: string }>();
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('health_data:read');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Button component={RouterLink} to="/health/biomarkers" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
          {BIOMARKERS_TITLE}
        </Button>
        {canRead ? (
          <BiomarkerDetail key={analyteKey} analyteKey={analyteKey} />
        ) : (
          <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>
        )}
      </Box>
    </Container>
  );
}
