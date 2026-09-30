/**
 * A plan's Progress view (`/train/plans/:programId/progress`, E5.9): "is my
 * plan working?" answered with the facts the API computes. Owned by the Train
 * destination; gated on `programs:read` in `App.tsx`, the string
 * `GET /api/training/signals` enforces. Nothing here involves AI.
 */
import { Link as RouterLink, useParams } from 'react-router-dom';
import { Box, Button, Container, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { SignalsSummary } from '../components/training/SignalsSummary';

export default function PlanProgressPage() {
  const { programId } = useParams<{ programId: string }>();
  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Button
          component={RouterLink}
          to="/train"
          startIcon={<ArrowBackIcon />}
          sx={{ mb: 1, minHeight: 44 }}
        >
          Train
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          Progress
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          How your plan is going: what was planned and done, volume, lifts, effort and recovery.
        </Typography>
        <SignalsSummary key={programId} programId={programId} />
      </Box>
    </Container>
  );
}
