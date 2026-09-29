/**
 * Add a gym (`/gyms/new`), E3.3. On save the list opens with the new card
 * (open it to add equipment and photos). The first gym a user creates becomes their default (the API
 * decides that).
 */
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Container, Paper, Typography } from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { createGym } from '../services/gyms';
import { GymForm } from '../components/gyms/GymForm';

export default function GymNewPage() {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('gyms:read') && hasPermission('gyms:write');

  return (
    <Container maxWidth="sm">
      <Box sx={{ py: 4 }}>
        <Button component={RouterLink} to="/gyms" startIcon={<BackIcon />} sx={{ mb: 2 }}>
          All gyms
        </Button>
        <Typography variant="h4" component="h1" gutterBottom>
          Add gym
        </Typography>
        {canWrite ? (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <GymForm
              submitLabel="Save"
              onCancel={() => navigate('/gyms')}
              onSubmit={async (input) => {
                await createGym(input);
                navigate('/gyms', { replace: true });
              }}
            />
          </Paper>
        ) : (
          <Alert severity="info">Your account cannot add gyms.</Alert>
        )}
      </Box>
    </Container>
  );
}
