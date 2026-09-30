/**
 * Plans (`/train/plans`), E5.6. The caller's training plans and the two ways
 * to make one: **Create with AI** (the intake wizard; offered only with AI
 * on, `ai:use` and every required agent ready, else disabled with the reason
 * and where to fix it) and **Build manually** (a blank plan, opened in the
 * editor; needs no AI). `programs:read` reaches the page; `programs:write`
 * offers the create actions. The API enforces both.
 */
import { useState } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  Link,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import { AutoAwesome as AiIcon, Add as AddIcon, ArrowBack as BackIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { usePlans } from '../../hooks/usePlans';
import { useTrainingAvailability } from '../../hooks/useTrainingAvailability';
import { PlanCard } from '../../components/training/PlanCard';

export const PLANS_AI_OFF_NOTICE = 'Creating a plan with AI is not available right now. You can still build one yourself.';

export default function PlansPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('programs:write');
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice ?? null;
  const { plans, active, isLoading, error, refresh, createBlank } = usePlans();
  const availability = useTrainingAvailability();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const aiBlocker = availability.blocker('create');
  const aiReady = availability.canRun('create');

  const buildManually = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const program = await createBlank();
      navigate(`/train/plans/${encodeURIComponent(program.id)}`, { state: { edit: true } });
    } catch (err) {
      setCreateError(err instanceof Error && err.message ? err.message : 'Could not create the plan');
      setCreating(false);
    }
  };

  const actions = canWrite && (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
      {/* Hidden (not disabled) when AI is off or the role lacks ai:use:
          nothing the user can do here would make it work. */}
      {availability.aiVisible && (
        <Button
          variant="contained"
          startIcon={<AiIcon />}
          component={RouterLink}
          to="/train/plans/new"
          disabled={!aiReady}
          sx={{ minHeight: 44 }}
          aria-describedby={aiBlocker ? 'create-ai-blocker' : undefined}
        >
          Create with AI
        </Button>
      )}
      <Button
        variant={availability.aiVisible ? 'outlined' : 'contained'}
        startIcon={<AddIcon />}
        onClick={() => void buildManually()}
        disabled={creating}
        sx={{ minHeight: 44 }}
      >
        Build manually
      </Button>
    </Stack>
  );

  let body;
  if (isLoading && plans.length === 0) {
    body = (
      <Stack spacing={1} data-testid="plans-skeleton">
        {[0, 1].map((i) => (
          <Skeleton key={i} variant="rounded" height={96} />
        ))}
      </Stack>
    );
  } else if (error) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  } else if (plans.length === 0) {
    body = (
      <Box sx={{ py: 2 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          No plans yet
        </Typography>
        <Typography color="text.secondary">
          {availability.aiVisible
            ? 'Create with AI: answer a few questions and watch the agents research, draft and review a plan you can edit. Or build one yourself, week by week.'
            : 'Build a plan yourself: add weeks, workouts and exercises, then activate it with a start date.'}
        </Typography>
      </Box>
    );
  } else {
    body = (
      <Stack component="ul" spacing={1.5} sx={{ p: 0, m: 0 }} aria-label="Your plans">
        {plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} position={active} />
        ))}
      </Stack>
    );
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Button component={RouterLink} to="/train" startIcon={<BackIcon />} size="small" sx={{ mb: 1 }}>
          Train
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          Plans
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Your training plans. Every change makes a new version you can look back at and restore.
        </Typography>

        {notice && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {notice}
          </Alert>
        )}
        {createError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setCreateError(null)}>
            {createError}
          </Alert>
        )}

        {actions}
        {canWrite && availability.aiVisible && aiBlocker && (
          <Alert severity="warning" id="create-ai-blocker" sx={{ mb: 2 }}>
            {aiBlocker.message}{' '}
            {aiBlocker.fix && (
              <Link component={RouterLink} to={aiBlocker.fix.to}>
                {aiBlocker.fix.label}
              </Link>
            )}
          </Alert>
        )}

        {body}
      </Box>
    </Container>
  );
}
