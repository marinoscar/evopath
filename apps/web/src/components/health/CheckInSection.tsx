/**
 * The Health page's "Daily check-in" section, issue #56 (E2.4): today's four
 * scores (or "Not done today"), a Check in / Edit button, and the last
 * {@link RECENT_CHECK_IN_DAYS} days as a compact list.
 *
 * "Today" is the server's day in the profile time zone (`GET /today`). The
 * dialog saves to the day it was opened for, so a check-in answered across
 * midnight still lands on the day it was about.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Box, Button, Card, CardContent, Skeleton, Typography } from '@mui/material';
import { HEALTH_DATA_UNAVAILABLE, type CheckInInput } from '../../services/health';
import { useCheckIn } from '../../hooks/useCheckIn';
import { useCheckInHistory } from '../../hooks/useCheckInHistory';
import { useMeasurementCatalog } from '../../hooks/useMeasurementCatalog';
import { formatDayLabel } from '../../utils/localDates';
import { CheckInDialog } from './CheckInDialog';
import { CheckInSummary, checkInFieldDefs, checkInScoresText } from './CheckInSummary';
import { LogMeasurementButton } from './LogMeasurementButton';

export const RECENT_CHECK_IN_DAYS = 14;

export function CheckInSection({ canWrite }: { canWrite: boolean }) {
  const today = useCheckIn();
  const history = useCheckInHistory(RECENT_CHECK_IN_DAYS);
  const { catalog } = useMeasurementCatalog();
  const defs = useMemo(() => checkInFieldDefs(catalog), [catalog]);
  // `date` outlives `open` so the dialog (and its "Check-in saved" snackbar)
  // stays mounted after it closes.
  const [dialog, setDialog] = useState<{ open: boolean; date: string | null }>({ open: false, date: null });
  const dialogDate = dialog.date;

  const forbidden = today.forbidden || history.forbidden;
  const headingId = 'health-check-in-heading';

  const dialogCheckIn =
    dialogDate === null
      ? null
      : dialogDate === today.date
        ? today.checkIn
        : (history.items.find((item) => item.date === dialogDate) ?? null);

  const onSave = async (date: string, input: CheckInInput) => {
    const saved = await today.save(date, input);
    void history.refresh();
    return saved;
  };
  const onDelete = async (date: string) => {
    await today.remove(date);
    void history.refresh();
  };
  const onConflict = () => {
    void today.refresh();
    void history.refresh();
  };

  let summary: ReactNode;
  if (forbidden) {
    summary = <Typography color="text.secondary">{HEALTH_DATA_UNAVAILABLE}</Typography>;
  } else if (today.isLoading && today.date === null) {
    summary = <Skeleton width="60%" data-testid="check-in-skeleton" />;
  } else if (today.error) {
    summary = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">Could not load today&apos;s check-in.</Typography>
        <Button size="small" onClick={() => void today.refresh()}>
          Retry
        </Button>
      </Box>
    );
  } else if (today.checkIn) {
    summary = <CheckInSummary checkIn={today.checkIn} defs={defs} />;
  } else {
    summary = <Typography color="text.secondary">Not done today</Typography>;
  }

  const recent = history.items;

  return (
    <Box component="section" aria-labelledby={headingId}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <Typography id={headingId} variant="h5" component="h2" sx={{ flexGrow: 1 }}>
          Daily check-in
        </Typography>
        {!forbidden && today.date && (
          <LogMeasurementButton
            variant={today.checkIn ? 'outlined' : 'contained'}
            canLog={canWrite}
            onClick={() => setDialog({ open: true, date: today.date })}
          >
            {today.checkIn ? 'Edit check-in' : 'Check in'}
          </LogMeasurementButton>
        )}
      </Box>

      <Card variant="outlined">
        <CardContent>{summary}</CardContent>
      </Card>

      {!forbidden && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle1" component="h3" sx={{ mb: 0.5 }}>
            Recent check-ins
          </Typography>
          {history.isLoading && recent.length === 0 ? (
            <Skeleton width="80%" />
          ) : history.error ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="body2" color="text.secondary">
                Could not load your recent check-ins.
              </Typography>
              <Button size="small" onClick={() => void history.refresh()}>
                Retry
              </Button>
            </Box>
          ) : recent.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No check-ins in the last {RECENT_CHECK_IN_DAYS} days.
            </Typography>
          ) : (
            <Box component="ul" aria-label="Recent check-ins" sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {recent.map((item) => (
                <Box
                  component="li"
                  key={item.date}
                  sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    columnGap: 2,
                    py: 0.75,
                    borderBottom: 1,
                    borderColor: 'divider',
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 96 }}>
                    {formatDayLabel(item.date, today.date)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    {checkInScoresText(item, defs)}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}

      {dialogDate && (
        <CheckInDialog
          open={dialog.open}
          date={dialogDate}
          checkIn={dialogCheckIn}
          onClose={() => setDialog((prev) => ({ ...prev, open: false }))}
          onSave={onSave}
          onDelete={onDelete}
          onConflict={onConflict}
        />
      )}
    </Box>
  );
}

export default CheckInSection;
