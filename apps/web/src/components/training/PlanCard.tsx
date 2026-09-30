/** One plan in the list: name, goal, status, provenance, position and unseen changes. */
import { Card, CardActionArea, CardContent, Chip, Stack, Typography } from '@mui/material';
import { AutoAwesome as AiIcon, Edit as ManualIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import type { ProgramListItem } from '../../services/programs';
import type { ActivePosition } from '../../hooks/usePlans';
import { GOAL_LABEL, STATUS_COLOR, STATUS_LABEL } from './planLabels';

export interface PlanCardProps {
  plan: ProgramListItem;
  position?: ActivePosition | null;
}

export function SourceBadge({ source }: { source: ProgramListItem['source'] }) {
  return source === 'ai' ? (
    <Chip size="small" icon={<AiIcon />} label="AI-generated" color="secondary" variant="outlined" />
  ) : (
    <Chip size="small" icon={<ManualIcon />} label="Manual" variant="outlined" />
  );
}

export function PlanCard({ plan, position }: PlanCardProps) {
  const at = position && position.programId === plan.id ? position : null;
  return (
    <Card variant="outlined" component="li" sx={{ listStyle: 'none' }} data-testid="plan-card">
      <CardActionArea component={RouterLink} to={`/train/plans/${encodeURIComponent(plan.id)}`} sx={{ minHeight: 44 }}>
        <CardContent>
          <Typography variant="h6" component="h2" sx={{ overflowWrap: 'anywhere' }}>
            {plan.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {GOAL_LABEL[plan.goal] ?? plan.goal}
            {at ? ` · Week ${at.weekNumber} of ${at.totalWeeks}` : ''}
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Chip size="small" label={STATUS_LABEL[plan.status] ?? plan.status} color={STATUS_COLOR[plan.status]} />
            <SourceBadge source={plan.source} />
            {plan.unseenChangeCount > 0 && (
              <Chip
                size="small"
                color="info"
                label={`Plan adjusted (${plan.unseenChangeCount})`}
                data-testid="plan-adjusted-chip"
              />
            )}
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default PlanCard;
