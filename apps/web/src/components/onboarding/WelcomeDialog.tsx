/**
 * The one-time welcome — issue #203.
 *
 * Shown once, while `onboarding.welcomeSeenAt` is null, by the single mount in
 * `Layout`. Two variants, chosen by what the API returned rather than by a
 * role check in the browser:
 *
 *   - `state.admin` non-null (the caller holds `system_settings:read`): "you
 *     are the administrator" and a way into the setup guide;
 *   - otherwise: a greeting, an OPTIONAL goal question, and "Get started".
 *
 * Every way out marks the welcome seen — "Start setup", "Get started",
 * "Later", Escape and a backdrop click — so it never comes back on its own.
 * "Getting started" in the user menu is the way to see it again.
 *
 * Full-screen below `sm` (the shell's compact boundary), no transition when
 * the user prefers reduced motion.
 */
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { APP_NAME } from '@app/shared';
import { useAuth } from '../../contexts/AuthContext';
import { useOnboarding } from '../../hooks/useOnboarding';
import type { OnboardingGoal } from '../../types';

export const SETUP_GUIDE_PATH = '/admin/settings/setup';

export const GOAL_OPTIONS: ReadonlyArray<{ value: OnboardingGoal; label: string }> = [
  { value: 'strength', label: 'Strength' },
  { value: 'hypertrophy', label: 'Build muscle' },
  { value: 'fat_loss', label: 'Lose fat' },
  { value: 'endurance', label: 'Endurance' },
  { value: 'general', label: 'General health' },
];

export function WelcomeDialog() {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { state, markWelcomeSeen } = useOnboarding();
  const [goal, setGoal] = useState<OnboardingGoal | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const goalLabelId = useId();

  const open = state !== null && state.welcomeSeenAt === null;
  if (!open) return null;

  const isAdmin = state.admin !== null;
  const firstName = user?.displayName?.trim().split(/\s+/)[0] ?? '';

  const later = () => {
    void markWelcomeSeen();
  };

  const startSetup = () => {
    void markWelcomeSeen();
    navigate(SETUP_GUIDE_PATH);
  };

  const getStarted = () => {
    void markWelcomeSeen(goal ?? undefined);
    navigate('/');
  };

  return (
    <Dialog
      open
      onClose={later}
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      transitionDuration={reduceMotion ? 0 : undefined}
      data-testid="welcome-dialog"
    >
      <DialogTitle id={titleId}>
        {isAdmin ? `Welcome to ${APP_NAME}` : firstName ? `Welcome, ${firstName}` : `Welcome to ${APP_NAME}`}
      </DialogTitle>
      <DialogContent>
        {isAdmin ? (
          <>
            <Typography id={descriptionId} sx={{ mb: 2 }}>
              You're the administrator of {APP_NAME}. A few things must be configured before people can
              use the app: object storage, email delivery and who is allowed to sign in.
            </Typography>
            <Typography color="text.secondary">
              The setup guide lists each one, checks it for you, and links to where it is done.
              {state.admin && state.admin.total > 0
                ? ` ${state.admin.completed} of ${state.admin.total} done so far.`
                : ''}
            </Typography>
          </>
        ) : (
          <>
            <Typography id={descriptionId} sx={{ mb: 3 }}>
              {APP_NAME} helps you log workouts, track your health and build a training plan. A short
              checklist on your Today page will walk you through the first steps.
            </Typography>
            <Typography id={goalLabelId} component="h3" variant="subtitle1" sx={{ mb: 1 }}>
              What is your main goal? <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>(optional)</Box>
            </Typography>
            <ToggleButtonGroup
              exclusive
              value={goal}
              onChange={(_event, value: OnboardingGoal | null) => setGoal(value)}
              aria-labelledby={goalLabelId}
              color="primary"
              sx={{ flexWrap: 'wrap', gap: 1, '& .MuiToggleButtonGroup-grouped': { border: 1, borderColor: 'divider', borderRadius: '16px !important', m: 0 } }}
            >
              {GOAL_OPTIONS.map((option) => (
                <ToggleButton key={option.value} value={option.value} sx={{ textTransform: 'none', minHeight: 40, px: 2 }}>
                  {option.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={later} sx={{ minHeight: 44 }}>
          Later
        </Button>
        {isAdmin ? (
          <Button variant="contained" onClick={startSetup} sx={{ minHeight: 44 }}>
            Start setup
          </Button>
        ) : (
          <Button variant="contained" onClick={getStarted} sx={{ minHeight: 44 }}>
            Get started
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default WelcomeDialog;
