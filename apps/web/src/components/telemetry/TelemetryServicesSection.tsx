/**
 * Telemetry services — a SECTION of `/admin/settings/telemetry` (issue #567),
 * not a card or a tab of its own.
 *
 * Shows the telemetry containers (GreptimeDB and the OpenTelemetry collector)
 * as the API reports them, and lets an administrator (re)deploy them with one
 * click. The deployment is a queue job the API runs; this section only asks
 * for it and follows it (`useTelemetryStack` polls every 3 s while a job is
 * active, every 30 s otherwise). When a deploy succeeds, `onDeployed` lets the
 * page refresh its connection and status.
 *
 * Gates are the API's: the section is mounted for `system_settings:read`, and
 * the deploy button is disabled without `system_settings:write` (`canDeploy`).
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import visuallyHidden from '@mui/utils/visuallyHidden';
import {
  isDeployActive,
  useTelemetryStack,
  type UseTelemetryStackOptions,
} from '../../hooks/useTelemetryStack';
import type { TelemetryStackService } from '../../services/telemetry';

export const TELEMETRY_SERVICES_SECTION_ID = 'telemetry-services';

const SECTION_TITLE = 'Telemetry services';

const SERVICE_LABELS: Record<string, string> = {
  greptimedb: 'GreptimeDB (telemetry store)',
  'otel-collector': 'OpenTelemetry collector',
};

type ChipColor = 'success' | 'info' | 'warning' | 'error' | 'default';

export function serviceLabel(name: string): string {
  return SERVICE_LABELS[name] ?? name;
}

/** The chip for one container: its label and colour. */
export function serviceChip(service: TelemetryStackService): { label: string; color: ChipColor } {
  switch (service.state) {
    case 'running':
      if (service.health === 'starting') return { label: 'Starting', color: 'info' };
      if (service.health === 'unhealthy') return { label: 'Unhealthy', color: 'warning' };
      return { label: service.health === 'healthy' ? 'Running · healthy' : 'Running', color: 'success' };
    case 'restarting':
      return { label: 'Restarting', color: 'info' };
    case 'created':
      return { label: 'Created', color: 'default' };
    case 'paused':
      return { label: 'Paused', color: 'warning' };
    case 'missing':
      return { label: 'Not deployed', color: 'error' };
    case 'exited':
      return { label: 'Stopped', color: 'error' };
    case 'dead':
      return { label: 'Failed', color: 'error' };
    default:
      return { label: service.state, color: 'default' };
  }
}

export const UNAVAILABLE_MESSAGE =
  "Automatic deployment isn't available in this environment (it's available on server deployments). " +
  'In development, the telemetry services start with the rest of the stack.';

export interface TelemetryServicesSectionProps {
  /** `system_settings:write` — what `POST /admin/telemetry/stack/deploy` enforces. */
  canDeploy: boolean;
  /** Called once when a deploy this page followed succeeds. */
  onDeployed?: () => void;
  /** Poll intervals; tests shorten them. */
  pollOptions?: UseTelemetryStackOptions;
}

export function TelemetryServicesSection({
  canDeploy,
  onDeployed,
  pollOptions,
}: TelemetryServicesSectionProps) {
  const { stack, isLoading, loadError, deployError, isDeploying, requestedJobId, deploy } =
    useTelemetryStack(pollOptions);
  const [succeeded, setSucceeded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The job this page watched go through pending/running. Only ITS success is
  // announced — an old succeeded job seen on load is not news.
  const watchedJobId = useRef<string | null>(null);
  const onDeployedRef = useRef(onDeployed);
  onDeployedRef.current = onDeployed;

  const latest = stack?.deploy ?? null;

  useEffect(() => {
    if (requestedJobId) watchedJobId.current = requestedJobId;
  }, [requestedJobId]);

  useEffect(() => {
    if (!latest) return;
    if (isDeployActive(latest)) {
      watchedJobId.current = latest.jobId;
      setSucceeded(false);
      return;
    }
    if (watchedJobId.current !== latest.jobId) return;
    watchedJobId.current = null;
    if (latest.status === 'succeeded') {
      setSucceeded(true);
      onDeployedRef.current?.();
    }
  }, [latest]);

  const agent = stack?.agent;
  const agentAvailable = agent === 'available';
  const services = stack?.services ?? [];
  const allRunning = services.length > 0 && services.every((service) => service.state === 'running');
  const failed = !isDeploying && latest?.status === 'failed';

  const handleDeploy = async () => {
    setSucceeded(false);
    setDetailsOpen(false);
    await deploy();
  };

  const announcement = isDeploying
    ? 'Deploying the telemetry services.'
    : succeeded
      ? 'The telemetry services were deployed.'
      : failed
        ? 'The telemetry services deployment failed.'
        : '';

  return (
    <Paper
      sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}
      component="section"
      aria-label={SECTION_TITLE}
      id={TELEMETRY_SERVICES_SECTION_ID}
    >
      <Typography variant="h6" component="h2" gutterBottom>
        {SECTION_TITLE}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The containers that store and collect telemetry for this application.
      </Typography>

      <Box role="status" aria-live="polite" sx={visuallyHidden} data-testid="telemetry-services-live">
        {announcement}
      </Box>

      {isLoading && !stack && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} aria-label="Loading the telemetry services" />
        </Box>
      )}

      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}

      {(agent === 'unavailable' || agent === 'not_configured') && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="telemetry-services-unavailable">
          {UNAVAILABLE_MESSAGE}
        </Alert>
      )}

      {agent === 'unauthorized' && (
        <Alert severity="error" sx={{ mb: 2 }} data-testid="telemetry-services-unauthorized">
          <AlertTitle>Deployment refused</AlertTitle>
          This deployment&apos;s internal service credentials don&apos;t match, so the telemetry
          services can&apos;t be managed from here. Update the application to bring them back in
          line.
        </Alert>
      )}

      {services.length > 0 && (
        <Stack component="ul" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0, mb: 2 }}>
          {services.map((service) => {
            const chip = serviceChip(service);
            return (
              <Box
                component="li"
                key={service.name}
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                }}
              >
                <Typography variant="body1" sx={{ wordBreak: 'break-word' }}>
                  {serviceLabel(service.name)}
                </Typography>
                <Chip size="small" color={chip.color} label={chip.label} />
              </Box>
            );
          })}
        </Stack>
      )}

      {isDeploying && (
        <Alert
          severity="info"
          icon={<CircularProgress size={20} aria-hidden />}
          sx={{ mb: 2 }}
          data-testid="telemetry-services-deploying"
        >
          Deploying… this can take a few minutes the first time while the image downloads.
        </Alert>
      )}

      {succeeded && !isDeploying && (
        <Alert severity="success" sx={{ mb: 2 }} data-testid="telemetry-services-succeeded">
          The telemetry services were deployed. The connection and status below have been
          refreshed.
        </Alert>
      )}

      {failed && latest && (
        <Alert severity="error" sx={{ mb: 2 }} data-testid="telemetry-services-failed">
          <AlertTitle>Deployment failed</AlertTitle>
          <Box sx={{ wordBreak: 'break-word' }}>{latest.error ?? 'The deployment did not complete.'}</Box>
          {latest.output && (
            <>
              <Button
                size="small"
                color="inherit"
                onClick={() => setDetailsOpen((open) => !open)}
                aria-expanded={detailsOpen}
                aria-controls="telemetry-services-details"
                sx={{ mt: 1, px: 0 }}
              >
                {detailsOpen ? 'Hide details' : 'Details'}
              </Button>
              <Collapse in={detailsOpen} unmountOnExit>
                <Box
                  component="pre"
                  id="telemetry-services-details"
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.8125rem',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 320,
                    overflow: 'auto',
                    m: 0,
                    mt: 1,
                  }}
                >
                  {latest.output}
                </Box>
              </Collapse>
            </>
          )}
        </Alert>
      )}

      {deployError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {deployError}
        </Alert>
      )}

      {agentAvailable && (
        <Button
          variant={allRunning ? 'outlined' : 'contained'}
          onClick={() => void handleDeploy()}
          disabled={!canDeploy || isDeploying}
          sx={{ width: { xs: '100%', sm: 'auto' } }}
        >
          {allRunning ? 'Redeploy' : 'Deploy GreptimeDB'}
        </Button>
      )}
      {agentAvailable && !canDeploy && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Deploying needs <code>system_settings:write</code>.
        </Typography>
      )}
    </Paper>
  );
}
