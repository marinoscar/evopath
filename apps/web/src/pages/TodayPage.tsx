import { Fragment } from 'react';
import { Box, Container, Grid, Typography } from '@mui/material';
import { TodayCard } from '../components/today/TodayCard';
import { CoachHero } from '../components/today/CoachHero';
import { TODAY_CARDS, type TodayCardDef } from '../config/todayCards';
import { useAuth } from '../contexts/AuthContext';

const CARD_SIZE: Record<TodayCardDef['key'], { xs: number; md: number }> = {
  adminSetup: { xs: 12, md: 12 },
  getStarted: { xs: 12, md: 12 },
  workout: { xs: 12, md: 8 },
  readiness: { xs: 12, md: 4 },
  body: { xs: 12, md: 6 },
  gym: { xs: 12, md: 6 },
  coach: { xs: 12, md: 6 },
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

        {/* E7.8 (#248): the latest unread coach line; renders nothing otherwise. */}
        <CoachHero />

        <Grid container spacing={3}>
          {TODAY_CARDS.map((def) => {
            const { Gate } = def;
            const card = (
              <Grid size={CARD_SIZE[def.key]}>
                <TodayCard def={def} />
              </Grid>
            );
            return Gate ? <Gate key={def.key}>{card}</Gate> : <Fragment key={def.key}>{card}</Fragment>;
          })}
        </Grid>
      </Box>
    </Container>
  );
}
