import { Box, Container, Grid, Typography } from '@mui/material';
import { TodayCard } from '../components/today/TodayCard';
import { TODAY_CARDS, type TodayCardDef } from '../config/todayCards';
import { useAuth } from '../contexts/AuthContext';

const CARD_SIZE: Record<TodayCardDef['key'], { xs: number; md: number }> = {
  workout: { xs: 12, md: 8 },
  readiness: { xs: 12, md: 4 },
  body: { xs: 12, md: 6 },
  gym: { xs: 12, md: 6 },
};

export default function TodayPage() {
  const { user } = useAuth();

  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
  const firstName = user?.displayName?.trim().split(/\s+/)[0] ?? '';
  const subtitle = firstName ? `${date} · Hello, ${firstName}` : date;

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Today
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {subtitle}
        </Typography>

        <Grid container spacing={3}>
          {TODAY_CARDS.map((def) => (
            <Grid key={def.key} size={CARD_SIZE[def.key]}>
              <TodayCard def={def} />
            </Grid>
          ))}
        </Grid>
      </Box>
    </Container>
  );
}
