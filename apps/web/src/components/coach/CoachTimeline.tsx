/**
 * The `/coach` timeline (E7.8, #248): a labelled `log` region, oldest at the
 * top and the newest at the bottom, with the turn in progress last.
 *
 * - Its own scroll box, opened at the bottom. Scrolling to the top loads the
 *   previous page (`before` cursor); the scroll position is held across the
 *   prepend so the reader does not jump. A "Load older messages" button does
 *   the same for keyboards and assistive technology.
 * - `aria-live="polite"`: a new reply is announced once, when it completes;
 *   the streaming bubble is `aria-busy` so tokens are not read one by one.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Alert, Avatar, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { keyframes } from '@mui/material/styles';
import CheckIcon from '@mui/icons-material/Check';
import VolunteerActivismOutlinedIcon from '@mui/icons-material/VolunteerActivismOutlined';
import { Link as RouterLink } from 'react-router-dom';
import {
  coachDisplayText,
  coachToolLabel,
  type CoachFeedback,
  type CoachPersonaCard,
  type CoachTimelineItem,
} from '../../services/coach';
import type { CoachPendingTurn } from '../../hooks/useCoachChat';
import { CoachMessageBubble } from './CoachMessageBubble';
import { MarkdownText } from '../common/MarkdownText';
import { personaIcon } from './personaAvatar';

const blink = keyframes`
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
`;

/** A failed turn the server stored: the message arrived, the reply did not. */
const NO_REPLY_YET = 'no reply yet — try again';
const NO_REPLY_YET_SENTENCE = 'No reply yet — try again';

export function TypingIndicator() {
  return (
    <Box role="status" aria-label="Coach is typing" sx={{ display: 'inline-flex', gap: 0.5, py: 0.5 }}>
      {[0, 1, 2].map((i) => (
        <Box
          key={i}
          aria-hidden
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: 'text.secondary',
            animation: `${blink} 1.2s infinite`,
            animationDelay: `${i * 0.2}s`,
            '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0.6 },
          }}
        />
      ))}
    </Box>
  );
}

export interface CoachTimelineProps {
  items: CoachTimelineItem[];
  personas: CoachPersonaCard[];
  /** The caller's current persona: the fallback for a message without `personaId`. */
  persona: CoachPersonaCard | null;
  pending: CoachPendingTurn | null;
  hasMore: boolean;
  isLoadingOlder: boolean;
  olderError: string | null;
  onLoadOlder: () => void;
  highlightId?: string | null;
  autoPlayId?: string | null;
  onFeedback: (id: string, feedback: CoachFeedback | null) => void;
  onDisplayed: (message: CoachTimelineItem) => void;
  onRetry: () => void;
  onDismissFailure: () => void;
  /** A weekly review's **Plan my week** (pre-fills the composer). */
  onPlanWeek?: (prompt: string) => void;
  /** How weekly reviews' distance goals read. Default `km`. */
  distanceUnit?: 'km' | 'mi';
  /** Rendered in the box when there is nothing else (the empty state). */
  empty?: ReactNode;
  /** Speech is on for the caller: coach messages offer **Listen** (#259). */
  speechEnabled?: boolean;
  /** The API refused audio as switched off: the page hides Listen. */
  onSpeechDisabled?: () => void;
}

function PendingTurn({
  turn,
  persona,
  onRetry,
  onDismiss,
}: {
  turn: CoachPendingTurn;
  persona: CoachPersonaCard | null;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const supportive = turn.safety?.level === 'blocked';
  const Icon = supportive ? VolunteerActivismOutlinedIcon : personaIcon(persona?.avatar ?? '');
  const failure = turn.failure;
  // Stored but unanswered: the message reached the coach, the reply did not.
  const unanswered = Boolean(failure && turn.storedUserMessageId);
  const userLabel = !failure ? 'You' : unanswered ? `You, ${NO_REPLY_YET}` : 'You, not delivered';
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0 }} data-testid="coach-pending-user">
        <Paper
          elevation={0}
          aria-label={userLabel}
          sx={{
            px: 1.5,
            py: 1,
            maxWidth: { xs: '85%', sm: '70%' },
            minWidth: 0,
            bgcolor: 'primary.container',
            color: 'primary.onContainer',
            borderRadius: 3,
            borderBottomRightRadius: 4,
            opacity: failure ? 0.8 : 1,
          }}
        >
          <Typography variant="body1" component="div" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {turn.text}
          </Typography>
        </Paper>
      </Box>
      {unanswered && (
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="coach-pending-status"
          sx={{ alignSelf: 'flex-end', textAlign: 'right' }}
        >
          {NO_REPLY_YET_SENTENCE}
        </Typography>
      )}
      {failure ? (
        <Alert
          severity={failure.kind === 'disabled' || failure.kind === 'unavailable' ? 'info' : 'error'}
          data-testid="coach-chat-error"
          action={
            <Stack direction="row" spacing={0.5}>
              {failure.kind === 'disabled' ? (
                <Button component={RouterLink} to="/settings/coach" color="inherit" size="small">
                  Coach settings
                </Button>
              ) : failure.kind !== 'unavailable' ? (
                <Button color="inherit" size="small" onClick={onRetry}>
                  Retry
                </Button>
              ) : null}
              <Button color="inherit" size="small" onClick={onDismiss}>
                Dismiss
              </Button>
            </Stack>
          }
        >
          {failure.message}
        </Alert>
      ) : (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', minWidth: 0 }}>
          <Avatar
            aria-hidden
            sx={{
              width: 32,
              height: 32,
              mt: 0.5,
              bgcolor: supportive ? 'info.main' : 'primary.container',
              color: supportive ? 'info.contrastText' : 'primary.onContainer',
            }}
          >
            <Icon fontSize="small" />
          </Avatar>
          <Paper
            variant="outlined"
            aria-busy="true"
            aria-label={`${supportive ? 'Support' : (persona?.name ?? 'Coach')} is replying`}
            data-testid="coach-streaming"
            data-kind={supportive ? 'supportive' : 'chat'}
            sx={{
              p: 1.5,
              maxWidth: { xs: 'calc(100% - 40px)', sm: '80%' },
              minWidth: 0,
              borderRadius: 3,
              borderTopLeftRadius: 4,
              ...(supportive ? { borderColor: 'info.main', borderLeftWidth: 4 } : {}),
            }}
          >
            <Stack spacing={1}>
              {turn.tools.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                  {turn.tools.map((tool, index) => (
                    <Chip
                      key={`${tool.name}-${index}`}
                      size="small"
                      variant="outlined"
                      icon={tool.status === 'ok' ? <CheckIcon /> : undefined}
                      label={coachToolLabel(tool.name)}
                    />
                  ))}
                </Box>
              )}
              {turn.reply ? (
                <MarkdownText data-testid="coach-streaming-body">{coachDisplayText(turn.reply)}</MarkdownText>
              ) : (
                <TypingIndicator />
              )}
            </Stack>
          </Paper>
        </Box>
      )}
    </>
  );
}

export function CoachTimeline({
  items,
  personas,
  persona,
  pending,
  hasMore,
  isLoadingOlder,
  olderError,
  onLoadOlder,
  highlightId = null,
  autoPlayId = null,
  onFeedback,
  onDisplayed,
  onRetry,
  onDismissFailure,
  onPlanWeek,
  distanceUnit,
  empty,
  speechEnabled = false,
  onSpeechDisabled,
}: CoachTimelineProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const firstId = items[0]?.id ?? null;
  const lastId = items[items.length - 1]?.id ?? null;
  const previous = useRef<{ firstId: string | null; lastId: string | null; height: number }>({
    firstId: null,
    lastId: null,
    height: 0,
  });

  // Hold the reader's place when older messages are prepended; follow the
  // bottom when a new message or the streaming reply grows the end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const before = previous.current;
    if (before.firstId && firstId !== before.firstId && lastId === before.lastId) {
      el.scrollTop += el.scrollHeight - before.height;
    } else if (!highlightId || lastId !== before.lastId) {
      el.scrollTop = el.scrollHeight;
    }
    previous.current = { firstId, lastId, height: el.scrollHeight };
  }, [firstId, lastId, pending?.reply, pending?.status, highlightId]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    previous.current.height = el.scrollHeight;
    if (el.scrollTop < 48 && hasMore && !isLoadingOlder && !olderError) onLoadOlder();
  };

  const personaFor = (message: CoachTimelineItem) =>
    (message.personaId && personas.find((p) => p.id === message.personaId)) || persona;

  return (
    <Box
      ref={scroller}
      role="log"
      aria-label="Coach conversation"
      aria-live="polite"
      aria-relevant="additions"
      onScroll={onScroll}
      data-testid="coach-timeline"
      sx={{
        height: 'clamp(280px, 55vh, 680px)',
        overflowY: 'auto',
        overflowX: 'hidden',
        px: { xs: 0.5, sm: 1 },
        py: 1,
        minWidth: 0,
      }}
    >
      <Stack spacing={1.5} sx={{ minWidth: 0 }}>
        {(hasMore || isLoadingOlder || olderError) && (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            {olderError ? (
              <Alert
                severity="error"
                action={
                  <Button color="inherit" size="small" onClick={onLoadOlder}>
                    Retry
                  </Button>
                }
              >
                {olderError}
              </Alert>
            ) : (
              <Button size="small" onClick={onLoadOlder} disabled={isLoadingOlder}>
                {isLoadingOlder ? 'Loading…' : 'Load older messages'}
              </Button>
            )}
          </Box>
        )}
        {items.length === 0 && !pending && empty}
        {items.map((message) => (
          <CoachMessageBubble
            key={message.id}
            message={message}
            persona={personaFor(message)}
            highlighted={message.id === highlightId}
            autoPlay={message.id === autoPlayId}
            onFeedback={message.role === 'coach' ? onFeedback : undefined}
            onDisplayed={onDisplayed}
            onPlanWeek={onPlanWeek}
            distanceUnit={distanceUnit}
            speechEnabled={speechEnabled && message.role === 'coach'}
            onSpeechDisabled={onSpeechDisabled}
          />
        ))}
        {pending && <PendingTurn turn={pending} persona={persona} onRetry={onRetry} onDismiss={onDismissFailure} />}
      </Stack>
    </Box>
  );
}

export default CoachTimeline;
