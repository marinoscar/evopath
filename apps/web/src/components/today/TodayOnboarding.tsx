/**
 * The two onboarding cards at the top of Today — issue #203.
 *
 *   `adminSetup`  — for a caller the API returned an `admin` block to (it holds
 *                   `system_settings:read`), until every REQUIRED step is done:
 *                   "Setup N of M" and the next thing to do. The card's link
 *                   goes to the full guide.
 *   `getStarted`  — the user checklist, until every step is done or the user
 *                   dismisses it ("Getting started" in the user menu brings it
 *                   back).
 *
 * Each card's `Gate` renders nothing when the card does not apply, so the page
 * gets no empty grid cell. Both read the shell's shared onboarding state; with
 * no `OnboardingProvider` above them they render nothing.
 *
 * Neither card is positioned: they sit in the page's normal flow, so the
 * shell's `<main>` bottom padding keeps them clear of the phone bottom bar.
 */
import type { ReactNode } from 'react';
import { Box, Button, LinearProgress, Typography } from '@mui/material';
import { useOnboarding } from '../../hooks/useOnboarding';
import { OnboardingChecklist } from '../onboarding/OnboardingChecklist';

export function AdminSetupGate({ children }: { children: ReactNode }) {
  const { state } = useOnboarding();
  if (!state?.admin || state.admin.requiredDone) return null;
  return <>{children}</>;
}

export function GetStartedGate({ children }: { children: ReactNode }) {
  const { state } = useOnboarding();
  if (!state || state.checklistDismissedAt) return null;
  const { completed, total } = state.user;
  if (total === 0 || completed >= total) return null;
  return <>{children}</>;
}

export function TodayAdminSetup() {
  const { state } = useOnboarding();
  const admin = state?.admin;
  if (!admin) return null;

  const progressText = `Setup ${admin.completed} of ${admin.total}`;
  const percent = admin.total > 0 ? Math.round((admin.completed / admin.total) * 100) : 0;
  const next = admin.steps.find((step) => step.group === 'required' && step.status === 'todo');

  return (
    <Box>
      <Typography color="text.secondary" sx={{ mb: 1.5 }}>
        A few things must be configured before people can use the app.
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }} data-testid="admin-setup-progress">
        {progressText}
      </Typography>
      <LinearProgress
        variant="determinate"
        value={percent}
        aria-label="Setup progress"
        aria-valuetext={`${admin.completed} of ${admin.total} done`}
        sx={{ mb: 1.5, height: 6, borderRadius: 3 }}
      />
      {next && (
        <Typography variant="body2" color="text.secondary">
          Next: {next.label}
        </Typography>
      )}
    </Box>
  );
}

export function TodayGetStarted() {
  const { state, dismissChecklist } = useOnboarding();
  if (!state) return null;

  return (
    <Box>
      <OnboardingChecklist
        steps={state.user.steps}
        completed={state.user.completed}
        total={state.user.total}
        label="Getting started"
      />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="small" color="inherit" onClick={() => void dismissChecklist()} sx={{ minHeight: 44 }}>
          Dismiss checklist
        </Button>
      </Box>
    </Box>
  );
}
