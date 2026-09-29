import { Box, Container, Grid, Paper, Typography } from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';
import type { RoadmapArea } from '../../config/roadmap';
import { ComingInChip } from './ComingInChip';
import { EmptyState } from './EmptyState';

export interface PlaceholderSection {
  title: string;
  description: string;
  Icon: SvgIconComponent;
}

interface PlaceholderPageProps {
  /** The page h1, e.g. "Train". */
  title: string;
  /** One sentence: what this area is for. */
  subtitle: string;
  /** Drives the "Coming in E<n>" chip. */
  area: RoadmapArea;
  /** The target layout, 2-4 items. */
  sections: PlaceholderSection[];
  note?: string;
}

export function PlaceholderPage({ title, subtitle, area, sections, note }: PlaceholderPageProps) {
  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom sx={{ overflowWrap: 'anywhere' }}>
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2, overflowWrap: 'anywhere' }}>
          {subtitle}
        </Typography>
        <Box sx={{ mb: 3 }}>
          <ComingInChip area={area} />
        </Box>
        {sections.length > 0 && (
          <Grid container spacing={2}>
            {sections.map((section) => (
              <Grid key={section.title} size={{ xs: 12, sm: 6, md: 4 }} sx={{ minWidth: 0 }}>
                <Paper variant="outlined" sx={{ borderStyle: 'dashed', height: '100%' }}>
                  <EmptyState
                    Icon={section.Icon}
                    title={section.title}
                    description={section.description}
                  />
                </Paper>
              </Grid>
            ))}
          </Grid>
        )}
        {note && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
            {note}
          </Typography>
        )}
      </Box>
    </Container>
  );
}

export default PlaceholderPage;
