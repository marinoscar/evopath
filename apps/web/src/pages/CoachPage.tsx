/**
 * `/coach` — the AI Coach timeline (E7.8, #248; docs/specs/ai-coach.md §2.13).
 *
 * A messaging-style page: the header (`GET /api/coach/state` plus the chosen
 * persona), the timeline (`GET /api/coach/messages`, newest at the bottom,
 * older pages on scroll up) and the composer, which streams one chat turn at a
 * time from `POST /api/coach/chat/stream`.
 *
 * The route is gated on `ai:use` and AI being on (`App.tsx`); the API decides
 * everything else. Nothing here calls a model: the browser posts text and
 * renders what the server streams back.
 *
 * DEEP LINK. `?m=<id>` (a push notification's target) scrolls to and
 * highlights that message, paging back a few pages if it is not in the first;
 * `&autoplay=1` also starts its audio, which the browser may refuse (a Play
 * button then stands in). A message with no audio yet is requested on demand
 * (#259) when speech is on: the push's "Hear Coach" was the reader's request.
 *
 * LISTEN (#259). Speech is on when the caller's audio toggle and the
 * deployment's policy both allow it (`coachSpeechEnabled`), read once here
 * with the settings; Listen stays hidden while that is unknown, and for the
 * rest of the visit once the API answers that audio is switched off. `m` is used only when it is shaped like a message id
 * and only ever matched against the caller's own timeline.
 *
 * START OVER (#323). The conversation menu above the timeline posts
 * `POST /api/coach/chat/clear` after a confirmation dialog, then empties the
 * timeline and re-reads it (the empty state shows). Disabled while a turn
 * streams. A soft clear: the server keeps every row.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Card, CardActions, CardContent, Container, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { CoachHeader } from '../components/coach/CoachHeader';
import { CoachTimeline } from '../components/coach/CoachTimeline';
import { CoachComposer, type CoachComposerPrefill } from '../components/coach/CoachComposer';
import { CoachStartOverMenu } from '../components/coach/CoachStartOverMenu';
import { useCoachSettings } from '../hooks/useCoachSettings';
import { useCoachState } from '../hooks/useCoachState';
import { useCoachTimeline } from '../hooks/useCoachTimeline';
import { useCoachChat } from '../hooks/useCoachChat';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useDistanceUnit } from '../hooks/useDistanceUnit';
import {
  clearCoachChat,
  coachErrorOf,
  coachSpeechEnabled,
  isCoachMessageId,
  type CoachTimelineItem,
} from '../services/coach';

/** How many older pages a deep link may load while looking for its message. */
const DEEP_LINK_MAX_PAGES = 5;

function CoachEmptyState() {
  return (
    <Card variant="outlined" data-testid="coach-empty">
      <CardContent>
        <Typography variant="h6" component="h2" gutterBottom>
          Meet your coach
        </Typography>
        <Typography color="text.secondary">
          Your coach keeps you on track: a nudge when a session slips, a cheer when you hit your target, and a
          weekly review. Ask anything below, or pick the personality that motivates you.
        </Typography>
      </CardContent>
      <CardActions sx={{ px: 2, pb: 2 }}>
        <Button component={RouterLink} to="/settings/coach" variant="outlined" sx={{ minHeight: 44 }}>
          Choose your coach
        </Button>
      </CardActions>
    </Card>
  );
}

export default function CoachPage() {
  const [params] = useSearchParams();
  const rawTarget = params.get('m');
  const targetId = isCoachMessageId(rawTarget) ? rawTarget : null;
  const autoPlayId = targetId && params.get('autoplay') === '1' ? targetId : null;

  const { personas, view } = useCoachSettings();
  const persona = useMemo(
    () => personas.find((p) => p.id === view?.settings.personaId) ?? null,
    [personas, view?.settings.personaId],
  );
  const [speechRefused, setSpeechRefused] = useState(false);
  const speechEnabled = coachSpeechEnabled(view) && !speechRefused;
  const onSpeechDisabled = useCallback(() => setSpeechRefused(true), []);
  const coachState = useCoachState();
  const timeline = useCoachTimeline();
  const online = useOnlineStatus();
  const { append, markOpened, loadOlder, findStoredUserTurn, reset } = timeline;
  const refreshState = coachState.refresh;

  const onComplete = useCallback(
    (items: CoachTimelineItem[], done: { pausedUntil: string | null }) => {
      append(items);
      // `pause_coach` changed the header's state; re-read it rather than patch it.
      if (done.pausedUntil) void refreshState();
    },
    [append, refreshState],
  );
  const chat = useCoachChat({ personaId: persona?.id ?? null, onComplete, findStoredTurn: findStoredUserTurn });

  const dismissTurn = chat.dismiss;
  const onStartOver = useCallback(async () => {
    try {
      await clearCoachChat();
    } catch (err) {
      throw new Error(coachErrorOf(err, 'Could not start over. Please try again.').message);
    }
    // A failed turn still on screen belongs to the old conversation.
    dismissTurn();
    await reset();
    void refreshState();
  }, [dismissTurn, reset, refreshState]);

  // A weekly review's Plan my week: put its prompt in the composer (not sent).
  const [prefill, setPrefill] = useState<CoachComposerPrefill | null>(null);
  const onPlanWeek = useCallback((text: string) => setPrefill((prev) => ({ text, key: (prev?.key ?? 0) + 1 })), []);
  // Weekly reviews' distance goals read in the Health Profile's unit.
  const distanceUnit = useDistanceUnit();

  const onDisplayed = useCallback(
    (message: CoachTimelineItem) => {
      if (message.role === 'coach' && !message.openedAt) markOpened(message.id);
    },
    [markOpened],
  );

  // Deep link: page back until the message is loaded, a few pages at most.
  const targetLoaded = targetId !== null && timeline.items.some((item) => item.id === targetId);
  const [deepLinkPages, setDeepLinkPages] = useState(0);
  useEffect(() => {
    if (!targetId || targetLoaded || timeline.isLoading || !timeline.hasMore) return;
    if (timeline.isLoadingOlder || timeline.olderError || deepLinkPages >= DEEP_LINK_MAX_PAGES) return;
    setDeepLinkPages((n) => n + 1);
    void loadOlder();
  }, [
    targetId,
    targetLoaded,
    timeline.isLoading,
    timeline.hasMore,
    timeline.isLoadingOlder,
    timeline.olderError,
    deepLinkPages,
    loadOlder,
  ]);

  return (
    <Container maxWidth="md" sx={{ px: { xs: 1.5, sm: 3 } }}>
      <Box sx={{ py: { xs: 2, sm: 3 }, minWidth: 0 }}>
        <CoachHeader persona={persona} state={coachState.state} />

        {timeline.error && (
          <Alert
            severity="error"
            sx={{ mb: 2 }}
            action={
              <Button color="inherit" size="small" onClick={() => void timeline.reload()}>
                Retry
              </Button>
            }
          >
            {timeline.error}
          </Alert>
        )}

        <Stack direction="row" sx={{ mb: 0.5, justifyContent: 'flex-end' }}>
          <CoachStartOverMenu disabled={chat.isStreaming || timeline.isLoading} onConfirm={onStartOver} />
        </Stack>

        <Paper variant="outlined" sx={{ mb: 2, minWidth: 0, overflow: 'hidden' }}>
          {timeline.isLoading ? (
            <Stack spacing={1.5} sx={{ p: 2 }} aria-label="Loading messages" role="status">
              <Skeleton variant="rounded" height={56} width="70%" />
              <Skeleton variant="rounded" height={40} width="50%" sx={{ alignSelf: 'flex-end' }} />
              <Skeleton variant="rounded" height={72} width="75%" />
            </Stack>
          ) : (
            <CoachTimeline
              items={timeline.items}
              personas={personas}
              persona={persona}
              pending={chat.pending}
              hasMore={timeline.hasMore}
              isLoadingOlder={timeline.isLoadingOlder}
              olderError={timeline.olderError}
              onLoadOlder={() => void loadOlder()}
              highlightId={targetLoaded ? targetId : null}
              autoPlayId={targetLoaded ? autoPlayId : null}
              onFeedback={(id, feedback) => void timeline.setFeedback(id, feedback)}
              onDisplayed={onDisplayed}
              onRetry={chat.retry}
              onDismissFailure={chat.dismiss}
              onPlanWeek={onPlanWeek}
              distanceUnit={distanceUnit}
              empty={timeline.error ? null : <CoachEmptyState />}
              speechEnabled={speechEnabled}
              onSpeechDisabled={onSpeechDisabled}
            />
          )}
        </Paper>

        <CoachComposer onSend={chat.send} busy={chat.isStreaming} offline={!online} prefill={prefill} />
      </Box>
    </Container>
  );
}
