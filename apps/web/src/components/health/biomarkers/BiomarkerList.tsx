/**
 * The biomarker summary, H5 (#189): one card per analyte with at least one
 * result, grouped by panel (lipids, glycemic, CBC and so on). Each card shows
 * the latest value with its unit and the lab's flag, the previous value, the
 * change (an arrow plus the delta, both from the API) and the date of the
 * last test, and links to the analyte's detail page.
 *
 * The arrow's direction is not a judgement: up is not "worse". The flag chip
 * is the lab's own reading of the value; colour only repeats its text.
 */
import { Link as RouterLink } from 'react-router-dom';
import { Box, Card, CardActionArea, CardContent, Stack, Typography } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import type { BiomarkerSummaryItem } from '../../../services/biomarkers';
import { LAB_PANEL_LABELS } from '../../../services/labReport';
import { deltaDirection, formatDelta, formatLabValue, groupSummaryByPanel } from '../../../utils/biomarkers';
import { withUnit } from '../../../utils/measurementUnits';
import { LabFlagChip } from '../LabResultValue';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const BIOMARKERS_TITLE = 'Biomarkers';

/** Read by screen readers only: the arrow is decorative. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

const DIRECTION_WORD = { up: 'up', down: 'down', flat: 'unchanged' } as const;

export function biomarkerPath(analyteKey: string): string {
  return `/health/biomarkers/${encodeURIComponent(analyteKey)}`;
}

export interface BiomarkerCardProps {
  item: BiomarkerSummaryItem;
  /** The analyte's display decimals from the catalog. */
  decimals?: number;
}

export function BiomarkerCard({ item, decimals }: BiomarkerCardProps) {
  const latest = withUnit(formatLabValue(item.latest.value, decimals), item.unit);
  const direction = deltaDirection(item.delta, decimals);
  const delta = formatDelta(item.delta, decimals);
  const Arrow = direction === 'up' ? ArrowUpwardIcon : direction === 'down' ? ArrowDownwardIcon : TrendingFlatIcon;
  const headingId = `biomarker-${item.analyteKey}`;

  return (
    <Card variant="outlined" component="article" aria-labelledby={headingId} data-testid="biomarker-card" sx={{ height: '100%' }}>
      <CardActionArea
        component={RouterLink}
        to={biomarkerPath(item.analyteKey)}
        sx={{ height: '100%', alignItems: 'stretch' }}
      >
        <CardContent>
          <Typography id={headingId} variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
            {item.label}
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 0.5 }}>
            <Typography variant="h5" component="p" data-testid="biomarker-latest">
              {latest}
            </Typography>
            <LabFlagChip flag={item.latest.flag} />
          </Box>
          <Stack spacing={0.25} sx={{ mt: 1 }}>
            {item.previous ? (
              <Typography variant="body2" color="text.secondary" data-testid="biomarker-previous">
                Previous {withUnit(formatLabValue(item.previous.value, decimals), item.unit)} on{' '}
                {formatDate(item.previous.measuredAt)}
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary" data-testid="biomarker-previous">
                First result
              </Typography>
            )}
            {direction && delta && (
              <Box
                data-testid="biomarker-change"
                sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}
              >
                <Arrow fontSize="small" aria-hidden="true" />
                <Typography variant="body2" component="span">
                  <Box component="span" sx={visuallyHidden}>
                    {`Change ${DIRECTION_WORD[direction]}: `}
                  </Box>
                  {direction === 'flat' ? delta : withUnit(delta, item.unit)}
                </Typography>
              </Box>
            )}
            <Typography variant="body2" color="text.secondary" data-testid="biomarker-last-test">
              Last test {formatDate(item.latest.measuredAt)}
              {item.count > 1 ? ` · ${item.count} results` : ''}
            </Typography>
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export interface BiomarkerListProps {
  items: readonly BiomarkerSummaryItem[];
  /** analyteKey → display decimals (catalog). */
  decimals?: ReadonlyMap<string, number>;
}

export function BiomarkerList({ items, decimals }: BiomarkerListProps) {
  return (
    <Stack spacing={4}>
      {groupSummaryByPanel(items).map((group) => {
        const headingId = `biomarker-panel-${group.panel}`;
        return (
          <Box component="section" key={group.panel} aria-labelledby={headingId} data-testid="biomarker-panel">
            <Typography id={headingId} variant="h6" component="h2" sx={{ mb: 1.5 }}>
              {LAB_PANEL_LABELS[group.panel]}
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gap: 2,
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' },
              }}
            >
              {group.items.map((item) => (
                <BiomarkerCard key={item.analyteKey} item={item} decimals={decimals?.get(item.analyteKey)} />
              ))}
            </Box>
          </Box>
        );
      })}
    </Stack>
  );
}

export default BiomarkerList;
