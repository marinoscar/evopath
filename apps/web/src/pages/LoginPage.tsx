import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Alert, Box, Typography, Stack, Divider } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { OAuthButton } from '../components/auth/OAuthButton';
import { AuthBrandLayout } from '../components/auth/AuthBrandLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

interface LocationState {
  from?: { pathname: string; search: string };
}

/**
 * The sign-in page: the sign-in panel inside `AuthBrandLayout`, which owns the
 * split brand layout (brand panel at `md` and up, compact brand header below),
 * the colour rules and the accessibility notes.
 */
export default function LoginPage() {
  const { isAuthenticated, isLoading, providers, login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Get the return URL from location state (set by ProtectedRoute)
  const state = location.state as LocationState | null;
  const returnUrl = state?.from
    ? `${state.from.pathname}${state.from.search || ''}`
    : '/';

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate(returnUrl, { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate, returnUrl]);

  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <AuthBrandLayout>
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold' }}>
          Welcome
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Sign in to continue
        </Typography>
      </Box>

      {/* Issue #295: the server refused to refresh a signed-in session. */}
      {sessionExpired && (
        <Alert severity="info" sx={{ mb: 3 }} data-testid="session-expired-notice">
          Your session expired. Please sign in again.
        </Alert>
      )}

      <Divider sx={{ mb: 3 }}>
        <Typography variant="body2" color="text.secondary">
          Sign in with
        </Typography>
      </Divider>

      {/* OAuth Providers */}
      <Stack spacing={2}>
        {providers.length > 0 ? (
          providers.map((provider) => (
            <OAuthButton
              key={provider.name}
              provider={provider.name}
              onClick={() => login(provider.name)}
            />
          ))
        ) : (
          <Typography color="text.secondary" sx={{ textAlign: 'center' }}>
            No authentication providers configured
          </Typography>
        )}
      </Stack>

      {/* Footer */}
      <Box sx={{ mt: 4, textAlign: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </Typography>
      </Box>
    </AuthBrandLayout>
  );
}
