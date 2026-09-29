/**
 * Settings → Health Profile (`/settings/health-profile`), issue #47 (E2.1).
 *
 * The same frame as `UserSettingsSection` (container, `h1`, description,
 * persistent fetch-error `Alert`, a 3 s success and a 5 s error snackbar),
 * copied rather than reused: that wrapper owns `useUserSettings` and the
 * `/api/user-settings` document, and the health profile is its own resource
 * behind `/api/health-profile`. Mounting the wrapper here would fire a request
 * this page never reads and gate the form behind it.
 *
 * Reachability is gated outside this file: the route wraps it in
 * `RequirePermission('health_data:read')`, the exact string the API's `GET`
 * enforces and the card in `config/userSettingsSections.tsx` declares. Writes
 * are gated inside the form on `health_data:write`, never by a second card.
 */

import { useState } from 'react';
import { Alert, Box, Container, Snackbar, Typography } from '@mui/material';
import { useHealthProfile } from '../hooks/useHealthProfile';
import { usePermissions } from '../hooks/usePermissions';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { HealthProfileSettings } from '../components/settings/HealthProfileSettings';

export default function UserHealthProfilePage() {
  const { profile, isLoading, error, isSaving, save, refresh } = useHealthProfile();
  const { hasPermission } = usePermissions();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  if (isLoading && !profile) {
    return <LoadingSpinner />;
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Health Profile
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Date of birth, sex at birth, height, units and time zone, used to interpret your
          measurements.
        </Typography>

        {/* The FETCH error: inline and permanent, and the form is not shown
            without a loaded profile. */}
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {profile && !error && (
          <HealthProfileSettings
            profile={profile}
            canWrite={hasPermission('health_data:write')}
            isSaving={isSaving}
            onSave={save}
            onSaved={() => setSuccessMessage('Health profile saved')}
            onError={setLocalError}
            onReload={() => void refresh()}
          />
        )}

        <Snackbar
          open={!!successMessage}
          autoHideDuration={3000}
          onClose={() => setSuccessMessage(null)}
          message={successMessage}
        />

        <Snackbar open={!!localError} autoHideDuration={5000} onClose={() => setLocalError(null)}>
          <Alert severity="error" onClose={() => setLocalError(null)}>
            {localError}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  );
}
