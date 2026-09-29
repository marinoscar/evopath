import { Box, Button, Card, CardActions, CardContent, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { ComingInChip } from '../common/ComingInChip';
import type { TodayCardDef } from '../../config/todayCards';

interface TodayCardProps {
  def: TodayCardDef;
}

export function TodayCard({ def }: TodayCardProps) {
  const { Icon, Content } = def;
  const headingId = `today-card-${def.key}`;

  return (
    <Card
      component="section"
      variant="outlined"
      aria-labelledby={headingId}
      data-testid={`today-card-${def.key}`}
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <CardContent sx={{ flexGrow: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Icon color="primary" aria-hidden />
          <Typography id={headingId} variant="h6" component="h2">
            {def.title}
          </Typography>
        </Box>
        {Content ? (
          <Content />
        ) : (
          <>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              {def.description}
            </Typography>
            <ComingInChip area={def.area} />
          </>
        )}
      </CardContent>
      <CardActions>
        <Button component={RouterLink} to={def.to}>
          {def.linkLabel}
        </Button>
      </CardActions>
    </Card>
  );
}

export default TodayCard;
