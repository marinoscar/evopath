/**
 * One critic round: the eight rubric dimensions as a table (score 1 to 5, a
 * bar with a text alternative), the verdict, the blockers and the summary.
 */
import {
  Box,
  Card,
  CardContent,
  Chip,
  List,
  ListItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { CRITIC_DIMENSIONS, type CriticDimension, type RunCriticRound } from '../../utils/reduceRunEvents';

export const DIMENSION_LABEL: Record<CriticDimension, string> = {
  goal_fit: 'Goal fit',
  equipment_feasibility: 'Equipment',
  volume_intensity: 'Volume and intensity',
  recovery: 'Recovery',
  injury_handling: 'Injury handling',
  progression: 'Progression',
  adherence_realism: 'Realistic to follow',
  evidence_alignment: 'Evidence',
};

const VERDICT: Record<RunCriticRound['verdict'], { label: string; color: 'success' | 'warning' | 'default' }> = {
  approve: { label: 'Approved', color: 'success' },
  revise: { label: 'Asked for changes', color: 'warning' },
  skipped: { label: 'Skipped', color: 'default' },
};

export function CriticScorecard({ round }: { round: RunCriticRound }) {
  const titleId = `critic-round-${round.round}`;
  return (
    <Card variant="outlined" data-testid="critic-scorecard">
      <CardContent>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography id={titleId} variant="subtitle1" component="h3">
            Round {round.round}
          </Typography>
          <Chip size="small" label={VERDICT[round.verdict].label} color={VERDICT[round.verdict].color} />
        </Stack>
        {round.scores && (
          <Table size="small" aria-labelledby={titleId}>
            <TableHead>
              <TableRow>
                <TableCell>Dimension</TableCell>
                <TableCell>Score</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {CRITIC_DIMENSIONS.map((dimension) => {
                const score = round.scores?.[dimension];
                return (
                  <TableRow key={dimension}>
                    <TableCell component="th" scope="row" sx={{ width: '45%' }}>
                      {DIMENSION_LABEL[dimension]}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Box
                          aria-hidden
                          sx={{ flex: 1, maxWidth: 160, height: 8, borderRadius: 4, bgcolor: 'action.hover', overflow: 'hidden' }}
                        >
                          <Box
                            sx={{
                              width: `${((score ?? 0) / 5) * 100}%`,
                              height: '100%',
                              bgcolor: score !== undefined && score <= 2 ? 'warning.main' : 'primary.main',
                            }}
                          />
                        </Box>
                        <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
                          {score !== undefined ? `${score} of 5` : 'Not scored'}
                        </Typography>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {round.blockers.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="subtitle2" component="h4">
              Must fix
            </Typography>
            <List dense disablePadding aria-label={`Blockers in round ${round.round}`}>
              {round.blockers.map((blocker, i) => (
                <ListItem key={i} disableGutters sx={{ py: 0.25 }}>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {DIMENSION_LABEL[blocker.dimension as CriticDimension] ?? blocker.dimension}: {blocker.issue}
                  </Typography>
                </ListItem>
              ))}
            </List>
          </Box>
        )}
        {round.summary && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
            {round.summary}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export default CriticScorecard;
