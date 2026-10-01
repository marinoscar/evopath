/**
 * One message on the `/coach` timeline (E7.8, #248; docs/specs/ai-coach.md
 * §2.13). User turns sit on the right; coach messages on the left beside the
 * persona's avatar, in a variant chosen by `kind`:
 *
 * - `nudge`, `chat`, `comeback`, `kickoff`, `system`: a plain bubble.
 * - `celebration`: the accent card.
 * - `weekly_review`: `WeeklyReviewCard` when `data` is the version-1 contract
 *   (`parseWeeklyReviewData`), with **Plan my week** wired to `onPlanWeek`;
 *   otherwise the defensive rendering (any stat present, the body as fallback).
 * - `photo_prompt`: the body plus **Take photo** (`/health/progress-photos?add=1`).
 * - A safety reply (`data.safety` of `distress` or `symptom`): the supportive
 *   style, no persona, no thumbs.
 *
 * Audio plays through `AiSpeechPlayer` only when `audioStatus` is `ready`;
 * `pending`, `failed` and `none` render text only, without a word about it.
 * Text is rendered as text (React escapes it), never as HTML.
 */
import { useEffect, useRef } from 'react';
import { Avatar, Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import EmojiEventsOutlinedIcon from '@mui/icons-material/EmojiEventsOutlined';
import InsightsIcon from '@mui/icons-material/Insights';
import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import VolunteerActivismOutlinedIcon from '@mui/icons-material/VolunteerActivismOutlined';
import { Link as RouterLink } from 'react-router-dom';
import { AiSpeechPlayer } from '../ai/AiSpeechPlayer';
import {
  coachDisplayText,
  coachMessageData,
  parseWeeklyReviewData,
  type CoachFeedback,
  type CoachPersonaCard,
  type CoachTimelineItem,
} from '../../services/coach';
import { personaIcon } from './personaAvatar';
import { WeeklyReviewCard } from './WeeklyReviewCard';

export const COACH_TAKE_PHOTO_PATH = '/health/progress-photos?add=1';
/** Screens whose reply is the fixed supportive text (no model, no persona). */
const SUPPORTIVE_SCREENS = new Set(['distress', 'symptom']);
/** How much of a bubble must be on screen before it counts as displayed. */
const DISPLAYED_RATIO = 0.5;

export interface CoachMessageBubbleProps {
  message: CoachTimelineItem;
  persona: CoachPersonaCard | null;
  highlighted?: boolean;
  autoPlay?: boolean;
  onFeedback?: (id: string, feedback: CoachFeedback | null) => void;
  /**
   * Called once when the message has been displayed: at least half of it
   * visible (IntersectionObserver), or at once when it is the `highlighted`
   * deep-link target. Never called where IntersectionObserver is unavailable,
   * except for the highlighted message.
   */
  onDisplayed?: (message: CoachTimelineItem) => void;
  /** A weekly review's **Plan my week**: pre-fill the composer with this prompt. */
  onPlanWeek?: (prompt: string) => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function isSupportiveReply(message: CoachTimelineItem): boolean {
  const { safety } = coachMessageData(message.data);
  return message.role === 'coach' && safety !== null && SUPPORTIVE_SCREENS.has(safety);
}

function Body({ text }: { text: string }) {
  if (!text) return null;
  return (
    <Typography variant="body1" component="div" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {coachDisplayText(text)}
    </Typography>
  );
}

function FeedbackControls({
  message,
  onFeedback,
}: {
  message: CoachTimelineItem;
  onFeedback: (id: string, feedback: CoachFeedback | null) => void;
}) {
  const up = message.feedback === 'up';
  const down = message.feedback === 'down';
  return (
    <Box role="group" aria-label="Rate this message" sx={{ display: 'flex', gap: 0.5 }}>
      <Tooltip title="Helpful">
        <IconButton
          size="small"
          aria-label="Helpful"
          aria-pressed={up}
          onClick={() => onFeedback(message.id, up ? null : 'up')}
          color={up ? 'primary' : 'default'}
        >
          {up ? <ThumbUpIcon fontSize="small" /> : <ThumbUpOutlinedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Not helpful">
        <IconButton
          size="small"
          aria-label="Not helpful"
          aria-pressed={down}
          onClick={() => onFeedback(message.id, down ? null : 'down')}
          color={down ? 'primary' : 'default'}
        >
          {down ? <ThumbDownIcon fontSize="small" /> : <ThumbDownOutlinedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

function WeeklyReviewContent({ message }: { message: CoachTimelineItem }) {
  const data = coachMessageData(message.data);
  return (
    <Stack spacing={1}>
      {data.headline && (
        <Typography variant="subtitle1" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
          {data.headline}
        </Typography>
      )}
      {data.adherence && (
        <Typography variant="body2" data-testid="coach-review-adherence">
          {data.adherence.done} of {data.adherence.planned} sessions done
        </Typography>
      )}
      {data.wins.length > 0 && (
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Wins
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {data.wins.map((win) => (
              <Typography component="li" variant="body2" key={win} sx={{ overflowWrap: 'anywhere' }}>
                {win}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
      {data.focus && (
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          <Box component="span" sx={{ fontWeight: 600 }}>
            Next week:{' '}
          </Box>
          {data.focus}
        </Typography>
      )}
      <Body text={message.body} />
    </Stack>
  );
}

export function CoachMessageBubble({
  message,
  persona,
  highlighted = false,
  autoPlay = false,
  onFeedback,
  onDisplayed,
  onPlanWeek,
}: CoachMessageBubbleProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reported = useRef(false);
  const latest = useRef({ message, onDisplayed });
  useEffect(() => {
    latest.current = { message, onDisplayed };
  }, [message, onDisplayed]);

  // "Displayed" means actually seen: at least half the bubble on screen
  // (IntersectionObserver), once per message. The deep-linked message
  // (`highlighted`) was opened explicitly, so it counts at once. Without
  // IntersectionObserver nothing else is reported: never mark a message
  // opened that the reader may not have seen.
  const hasOnDisplayed = Boolean(onDisplayed);
  useEffect(() => {
    if (reported.current || !hasOnDisplayed) return;
    const report = () => {
      if (reported.current) return;
      reported.current = true;
      latest.current.onDisplayed?.(latest.current.message);
    };
    if (highlighted) {
      report();
      return;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= DISPLAYED_RATIO)) {
          observer.disconnect();
          report();
        }
      },
      { threshold: DISPLAYED_RATIO },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [message.id, highlighted, hasOnDisplayed]);

  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    ref.current.focus({ preventScroll: true });
  }, [highlighted]);

  const time = formatTime(message.createdAt);

  if (message.role === 'user') {
    return (
      <Box
        ref={ref}
        tabIndex={highlighted ? -1 : undefined}
        data-message-id={message.id}
        sx={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0 }}
      >
        <Paper
          elevation={0}
          aria-label={`You${time ? `, ${time}` : ''}`}
          sx={{
            px: 1.5,
            py: 1,
            maxWidth: { xs: '85%', sm: '70%' },
            minWidth: 0,
            bgcolor: 'primary.container',
            color: 'primary.onContainer',
            borderRadius: 3,
            borderBottomRightRadius: 4,
          }}
        >
          <Body text={message.body} />
        </Paper>
      </Box>
    );
  }

  const data = coachMessageData(message.data);
  const supportive = isSupportiveReply(message);
  const Icon = supportive ? VolunteerActivismOutlinedIcon : personaIcon(persona?.avatar ?? '');
  const speaker = supportive ? 'Support' : (persona?.name ?? 'Coach');
  const kind = supportive ? 'supportive' : message.kind;
  const accent =
    kind === 'celebration'
      ? { bgcolor: 'secondary.container', color: 'secondary.onContainer', borderColor: 'secondary.main' }
      : kind === 'supportive'
        ? { bgcolor: 'background.paper', borderColor: 'info.main', borderLeftWidth: 4 }
        : kind === 'weekly_review'
          ? { bgcolor: 'background.paper', borderColor: 'primary.main' }
          : { bgcolor: 'background.paper' };
  const KindIcon =
    kind === 'celebration' ? EmojiEventsOutlinedIcon : kind === 'weekly_review' ? InsightsIcon : null;
  const review = kind === 'weekly_review' ? parseWeeklyReviewData(message.data) : null;
  // The review card renders its headline (= title) as its own heading.
  const labelTitle = Boolean(message.title) && message.kind !== 'chat';
  const showTitle = labelTitle && !review;
  const audioReady = message.audioStatus === 'ready' && Boolean(message.audioStorageObjectId);

  return (
    <Box
      ref={ref}
      tabIndex={highlighted ? -1 : undefined}
      data-message-id={message.id}
      data-kind={kind}
      sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', minWidth: 0 }}
    >
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
        component="article"
        aria-label={`${speaker}${labelTitle ? `: ${message.title}` : ''}${time ? `, ${time}` : ''}`}
        sx={{
          p: 1.5,
          flex: '0 1 auto',
          maxWidth: { xs: 'calc(100% - 40px)', sm: '80%' },
          minWidth: 0,
          borderRadius: 3,
          borderTopLeftRadius: 4,
          ...accent,
          ...(highlighted ? { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } : {}),
        }}
      >
        <Stack spacing={1} sx={{ minWidth: 0 }}>
          <Typography variant="caption" color={kind === 'celebration' ? 'inherit' : 'text.secondary'}>
            {speaker}
            {time ? ` · ${time}` : ''}
          </Typography>
          {(showTitle || (KindIcon && !review)) && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              {KindIcon && <KindIcon fontSize="small" aria-hidden />}
              {showTitle && (
                <Typography variant="subtitle2" component="p" sx={{ overflowWrap: 'anywhere' }}>
                  {message.title}
                </Typography>
              )}
            </Box>
          )}
          {review ? (
            <WeeklyReviewCard review={review} onPlanWeek={onPlanWeek} />
          ) : kind === 'weekly_review' ? (
            <WeeklyReviewContent message={message} />
          ) : (
            <Body text={message.body} />
          )}
          {data.safety === 'pain' && (
            <Typography variant="caption" color="text.secondary">
              Careful mode: no advice to train through pain.
            </Typography>
          )}
          {audioReady && (
            <AiSpeechPlayer
              output={{ storageObjectId: message.audioStorageObjectId as string, voice: message.voice ?? 'default' }}
              autoPlay={autoPlay}
            />
          )}
          {(message.kind === 'photo_prompt' || data.links.length > 0) && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {message.kind === 'photo_prompt' && (
                <Button
                  component={RouterLink}
                  to={COACH_TAKE_PHOTO_PATH}
                  variant="contained"
                  size="small"
                  startIcon={<PhotoCameraOutlinedIcon />}
                  sx={{ minHeight: 40 }}
                >
                  Take photo
                </Button>
              )}
              {data.links.map((link) => (
                <Button
                  key={`${link.href}-${link.label}`}
                  component={RouterLink}
                  to={link.href}
                  variant="outlined"
                  size="small"
                  sx={{ minHeight: 40 }}
                >
                  {link.label}
                </Button>
              ))}
            </Box>
          )}
          {onFeedback && !supportive && <FeedbackControls message={message} onFeedback={onFeedback} />}
        </Stack>
      </Paper>
    </Box>
  );
}

export default CoachMessageBubble;
