/**
 * The administrator's setup guide (`/admin/settings/setup`) — issue #203.
 *
 * A registry card (`Setup guide`, `ADMIN_SECTIONS` → General) gated on
 * `system_settings:read`, the permission under which `GET /api/onboarding`
 * returns its `admin` block. Every step's status is derived by the API from
 * the Doctor's checks and the allowlist; this page never decides one.
 *
 * "Re-check" re-reads with `refresh=true`, which the API forwards to the
 * Doctor so every probe runs again. The Doctor itself is one link away for
 * the full picture.
 *
 * Below the checklist, the Activation section (#212) shows how recent
 * sign-ups reach their first workout (`GET /api/admin/onboarding/metrics`,
 * the same `system_settings:read`).
 */
import { Link as RouterLink, Navigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import { APP_NAME } from '@app/shared';
import { usePermissions } from '../../hooks/usePermissions';
import { useOnboarding } from '../../hooks/useOnboarding';
import { OnboardingChecklist } from '../../components/onboarding/OnboardingChecklist';
import { ActivationMetrics } from '../../components/onboarding/ActivationMetrics';

export const PAGE_TITLE = 'Setup guide';
export const DOCTOR_PATH = '/admin/settings/doctor';

export default function SetupGuidePage() {
  const { hasPermission } = usePermissions();
  const { state, isLoading, isRefreshing, error, refresh } = useOnboarding();

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. After every hook so hook order never changes.
  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  const admin = state?.admin ?? null;

  return (
    <Container maxWidth="md">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          What must be configured before people can use {APP_NAME}, and the optional features you
          can turn on after. Each step is checked against the live configuration.
        </Typography>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1, sm: 2 }}
          sx={{ mb: 3, alignItems: { xs: 'stretch', sm: 'center' } }}
        >
          <Button
            variant="contained"
            onClick={() => void refresh({ refresh: true })}
            disabled={isLoading || isRefreshing}
            startIcon={isRefreshing ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
            sx={{ minHeight: 44 }}
          >
            {isRefreshing ? 'Checking…' : 'Re-check'}
          </Button>
          <Button
            component={RouterLink}
            to={DOCTOR_PATH}
            startIcon={<HealthAndSafetyOutlinedIcon />}
            sx={{ minHeight: 44 }}
          >
            Open the Doctor
          </Button>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {admin?.requiredDone && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Everything required is set up. People can start using {APP_NAME}.
          </Alert>
        )}

        <Card variant="outlined" aria-busy={isLoading || isRefreshing}>
          <CardContent>
            {isLoading ? (
              <Stack spacing={1} data-testid="setup-guide-loading" aria-label="Loading setup steps">
                <Skeleton variant="rounded" height={24} width="40%" />
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} variant="rounded" height={48} />
                ))}
              </Stack>
            ) : admin ? (
              <OnboardingChecklist
                steps={admin.steps}
                completed={admin.completed}
                total={admin.total}
                label="Setup"
                grouped
              />
            ) : (
              !error && (
                <Typography color="text.secondary">
                  The setup steps are not available right now.
                </Typography>
              )
            )}
          </CardContent>
        </Card>

        {/* #212: a section of this page, not a card or tab of its own. */}
        <ActivationMetrics />
      </Box>
    </Container>
  );
}
