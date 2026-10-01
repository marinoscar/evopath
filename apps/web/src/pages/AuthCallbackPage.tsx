import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Typography, CircularProgress } from '@mui/material';
import { api } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { SignInErrorView } from '../components/auth/SignInErrorView';
import {
  DEFAULT_SIGN_IN_ERROR_CODE,
  resolveSignInErrorCode,
  type SignInErrorCode,
} from '../components/auth/signInErrorContent';

export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser, login } = useAuth();
  // Only ever a known code: the `?error=` value is never rendered (#273).
  const [errorCode, setErrorCode] = useState<SignInErrorCode | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      const token = searchParams.get('token');
      const errorParam = searchParams.get('error');

      if (errorParam) {
        setErrorCode(resolveSignInErrorCode(errorParam));
        return;
      }

      if (!token) {
        setErrorCode(DEFAULT_SIGN_IN_ERROR_CODE);
        return;
      }

      try {
        // Store the access token
        api.setAccessToken(token);

        // Fetch user data
        await refreshUser();

        // Get return URL and clear it
        const returnUrl = sessionStorage.getItem('auth_return_url') || '/';
        sessionStorage.removeItem('auth_return_url');

        // Navigate to return URL
        navigate(returnUrl, { replace: true });
      } catch (err) {
        setErrorCode(DEFAULT_SIGN_IN_ERROR_CODE);
        api.setAccessToken(null);
      }
    };

    handleCallback();
  }, [searchParams, navigate, refreshUser]);

  if (errorCode) {
    return (
      <SignInErrorView
        code={errorCode}
        onSignInWithDifferentAccount={() => login('google', { selectAccount: true })}
        onTryAgain={() => login('google')}
      />
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 2,
      }}
    >
      <CircularProgress />
      <Typography>Completing authentication...</Typography>
    </Box>
  );
}
