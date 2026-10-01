import { useEffect, useRef } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { AuthBrandLayout } from './AuthBrandLayout';
import { SIGN_IN_ERROR_CONTENT, type SignInErrorCode } from './signInErrorContent';

interface SignInErrorViewProps {
  code: SignInErrorCode;
  /** Restart Google sign-in showing the account chooser. */
  onSignInWithDifferentAccount: () => void;
  /** Restart Google sign-in as usual. */
  onTryAgain: () => void;
}

/**
 * Wraps each hyphenated compound ("invite-only", "sign-in") in a nowrap span so
 * the headline can wrap between words but never inside one. The text is
 * unchanged (no Unicode hyphen), so the heading's accessible name is the same.
 */
function keepCompoundsTogether(text: string) {
  return text.split(/(\S+-\S+)/).map((part, index) =>
    index % 2 === 1 ? (
      <Box key={index} component="span" sx={{ whiteSpace: 'nowrap' }}>
        {part}
      </Box>
    ) : (
      part
    ),
  );
}

/**
 * Full-page screen for a failed sign-in (#273), in the same identity as
 * `LoginPage`: the shared `AuthBrandLayout` (brand-teal panel with the sun glow,
 * name and tagline beside the message at `md` and up; the compact brand header
 * over one card below `md`), with the message in the content panel.
 *
 * Refusals the person can act on (not invited, access paused, cancelled) use the
 * calm `info`/`warning` palette colours; only real faults use `error`. The coral
 * `secondary` is for effort and training, so it never appears here. Everything
 * is a theme token, so light and dark both work.
 *
 * The copy comes from `signInErrorContent.ts`; nothing from the URL is rendered.
 */
export function SignInErrorView({
  code,
  onSignInWithDifferentAccount,
  onTryAgain,
}: SignInErrorViewProps) {
  const theme = useTheme();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { severity, Icon, headline, explanation, nextSteps, primaryAction } =
    SIGN_IN_ERROR_CONTENT[code];
  const accent = theme.palette[severity].main;

  // Move focus to the heading so a screen reader announces the outcome and
  // keyboard users start at the top of the content.
  useEffect(() => {
    headingRef.current?.focus();
  }, [code]);

  return (
    <AuthBrandLayout>
      <Stack spacing={3} sx={{ alignItems: 'center', textAlign: 'center' }}>
        <Box
          aria-hidden
          sx={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: accent,
            backgroundColor: alpha(accent, 0.12),
            border: 2,
            borderColor: accent,
          }}
        >
          <Icon sx={{ fontSize: 36 }} />
        </Box>

        <Box role={severity === 'error' ? 'alert' : 'status'}>
          <Typography
            ref={headingRef}
            tabIndex={-1}
            variant="h4"
            component="h1"
            sx={{ fontWeight: 'bold', outline: 'none', textWrap: 'balance' }}
          >
            {keepCompoundsTogether(headline)}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1.5 }}>
            {explanation}
          </Typography>
        </Box>

        <Stack component="ul" spacing={1} sx={{ m: 0, p: 0, listStyle: 'none', width: '100%' }}>
          {nextSteps.map((step) => (
            <Typography key={step} component="li" variant="body2">
              {step}
            </Typography>
          ))}
        </Stack>

        <Stack spacing={1.5} sx={{ width: '100%' }}>
          {primaryAction === 'different-account' && (
            <Button
              fullWidth
              size="large"
              variant="contained"
              onClick={onSignInWithDifferentAccount}
            >
              Sign in with a different account
            </Button>
          )}
          {primaryAction === 'try-again' && (
            <Button fullWidth size="large" variant="contained" onClick={onTryAgain}>
              Try again
            </Button>
          )}
          <Button
            fullWidth
            size="large"
            variant={primaryAction === 'none' ? 'contained' : 'text'}
            component={RouterLink}
            to="/login"
          >
            Back to sign in
          </Button>
        </Stack>
      </Stack>
    </AuthBrandLayout>
  );
}
