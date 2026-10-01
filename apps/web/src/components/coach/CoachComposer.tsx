/**
 * The `/coach` composer (E7.8, #248): quick replies above a text field
 * (2,000 characters, the API's limit) and Send. Enter sends, Shift+Enter
 * breaks the line. Disabled, with the reason shown, while a reply streams,
 * while offline, or when chat cannot work at all (`disabledReason`).
 *
 * `prefill` replaces the draft and focuses the field (a weekly review's
 * **Plan my week**); it never sends. A new `key` applies the same text again.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { COACH_CHAT_TEXT_MAX } from '../../services/coach';
import { QuickReplies } from './QuickReplies';

export const COACH_OFFLINE_TEXT = 'You are offline. Reconnect to chat with your coach.';

export interface CoachComposerProps {
  onSend: (text: string) => void;
  busy?: boolean;
  offline?: boolean;
  /** Chat cannot be used at all (for example the coach is switched off). */
  disabledReason?: string | null;
  /** Text to put in the field, applied whenever `key` changes. */
  prefill?: CoachComposerPrefill | null;
}

export interface CoachComposerPrefill {
  text: string;
  key: number;
}

export function CoachComposer({
  onSend,
  busy = false,
  offline = false,
  disabledReason = null,
  prefill = null,
}: CoachComposerProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const prefillKey = prefill?.key ?? null;
  const prefillText = prefill?.text ?? '';

  useEffect(() => {
    if (prefillKey === null) return;
    setDraft(prefillText.slice(0, COACH_CHAT_TEXT_MAX));
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applied once per key
  }, [prefillKey]);
  const blocked = offline || Boolean(disabledReason);
  const canSend = !busy && !blocked && draft.trim().length > 0;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(draft.trim());
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const note = offline ? COACH_OFFLINE_TEXT : disabledReason;

  return (
    <Box component="form" onSubmit={submit} aria-label="Message your coach" sx={{ minWidth: 0 }}>
      <Stack spacing={1.5}>
        <QuickReplies onSelect={(text) => !busy && !blocked && onSend(text)} disabled={busy || blocked} />
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', minWidth: 0 }}>
          <TextField
            label="Message your coach"
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, COACH_CHAT_TEXT_MAX))}
            onKeyDown={onKeyDown}
            multiline
            minRows={1}
            maxRows={6}
            fullWidth
            disabled={blocked}
            inputRef={inputRef}
            helperText={`${draft.length} / ${COACH_CHAT_TEXT_MAX}`}
            slotProps={{ htmlInput: { maxLength: COACH_CHAT_TEXT_MAX } }}
            sx={{ minWidth: 0 }}
          />
          <Button
            type="submit"
            variant="contained"
            disabled={!canSend}
            aria-label="Send"
            sx={{ minHeight: 56, minWidth: 56, px: { xs: 1.5, sm: 2 } }}
          >
            <SendIcon />
          </Button>
        </Box>
        {note && (
          <Typography variant="body2" color="text.secondary" role="status">
            {note}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

export default CoachComposer;
