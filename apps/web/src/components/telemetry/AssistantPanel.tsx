/**
 * The Telemetry Explorer's assistant conversation — issue #537, epic #528;
 * the troubleshooting agent — issue #571.
 *
 * A local renderer rather than `AiChatThread`: that thread renders the
 * playground's `AiChatMessage` (text deltas, reasoning, hosted-tool output),
 * while a telemetry turn is an investigation (TOOL STEPS, with the model's
 * interim thoughts) plus one structured answer: an analysed report, or on an
 * older API `{ sql, explanation }`. The look follows `AiChatThread` — user
 * bubbles on the right, outlined assistant cards, a `role="log"` region, plain
 * text only (nothing the model says is interpreted as HTML).
 *
 * "New chat" (issue #574) sits in the top row beside the model caption, so the
 * desktop drawer and the phone dialog share it; it calls `onNewChat` (the
 * hook's `clear()`, which aborts any in-flight turn) and empties the input.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, TextField, Typography } from '@mui/material';
import StopIcon from '@mui/icons-material/Stop';
import SendIcon from '@mui/icons-material/Send';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import {
  ASSISTANT_QUESTION_MAX,
  type AssistantMessage,
  type AssistantReplyMessage,
} from '../../hooks/useTelemetryAssistant';
import { AssistantTimeline } from './AssistantTimeline';
import { LegacyAnswer, ReportCard } from './AssistantReport';

export const ASSISTANT_EXAMPLE_PROMPTS = [
  'Are there any errors in the last hour?',
  'Why is the API slow?',
  'Is telemetry being ingested correctly?',
] as const;

function Reply({
  message,
  onInsert,
  onInsertAndRun,
}: {
  message: AssistantReplyMessage;
  onInsert: (sql: string) => void;
  onInsertAndRun: (sql: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const hasAnswer = message.answer !== null;

  // When the report lands, bring its top into view (not the bottom of a long
  // report) — on a phone the summary is what matters first.
  useEffect(() => {
    if (hasAnswer) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [hasAnswer]);

  const answer = message.answer;
  return (
    <Paper
      ref={ref}
      variant="outlined"
      data-testid="assistant-reply"
      data-status={message.status}
      aria-busy={message.status === 'streaming'}
      sx={{ px: 1.5, py: 1, minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <AssistantTimeline
        steps={message.steps}
        isInvestigating={message.status === 'streaming' && !answer}
        collapsible={hasAnswer}
      />
      {answer && (
        <Box sx={{ mt: message.steps.length > 0 ? 0.5 : 0 }}>
          {answer.report ? (
            <ReportCard report={answer.report} onInsert={onInsert} onInsertAndRun={onInsertAndRun} />
          ) : (
            <LegacyAnswer answer={answer} onInsert={onInsert} onInsertAndRun={onInsertAndRun} />
          )}
        </Box>
      )}
      {message.error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {message.error.message}
          {message.error.code && (
            <Typography variant="caption" component="div">
              {message.error.code}
            </Typography>
          )}
        </Alert>
      )}
      {message.status === 'stopped' && <Chip size="small" label="Stopped" sx={{ mt: 1 }} />}
    </Paper>
  );
}

function EmptyState({ disabled, onAsk }: { disabled: boolean; onAsk: (question: string) => void }) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        Describe a problem or ask a question. The assistant investigates on its own — it checks the
        app&apos;s configuration, overall health, errors and traces by running read-only queries —
        and reports what it found, the likely cause and what to do next.
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1.5 }}>
        {ASSISTANT_EXAMPLE_PROMPTS.map((prompt) => (
          <Chip
            key={prompt}
            label={prompt}
            variant="outlined"
            clickable
            disabled={disabled}
            onClick={() => onAsk(prompt)}
            sx={{ maxWidth: '100%', height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', py: 0.5 } }}
          />
        ))}
      </Stack>
    </Box>
  );
}

export interface AssistantPanelProps {
  messages: AssistantMessage[];
  isStreaming: boolean;
  onAsk: (question: string) => void;
  onStop: () => void;
  onInsert: (sql: string) => void;
  onInsertAndRun: (sql: string) => void;
  /** e.g. `openai · gpt-5-mini`, when the viewer may read the settings. */
  modelCaption?: string | null;
  /** Starts over: aborts any in-flight turn and forgets the conversation (#574). */
  onNewChat?: () => void;
  /**
   * Prefills the question box — NOT sent; the reader edits it and presses Ask
   * (#579, the dashboard's "Ask assistant"). Read when the panel mounts: a
   * caller that prefills again gives the panel a new `key`.
   */
  initialQuestion?: string;
}

export function AssistantPanel({
  messages,
  isStreaming,
  onAsk,
  onStop,
  onInsert,
  onInsertAndRun,
  modelCaption,
  onNewChat,
  initialQuestion,
}: AssistantPanelProps) {
  const [question, setQuestion] = useState(() => (initialQuestion ?? '').slice(0, ASSISTANT_QUESTION_MAX));
  const endRef = useRef<HTMLDivElement | null>(null);
  const last = messages[messages.length - 1];

  // Follow the investigation as it streams; once a reply has its answer, that
  // reply scrolls its own top into view instead.
  useEffect(() => {
    if (last?.role === 'assistant' && last.answer) return;
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, last]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!question.trim() || isStreaming) return;
    onAsk(question);
    setQuestion('');
  };

  const showNewChat = Boolean(onNewChat) && messages.length > 0;
  const newChat = () => {
    setQuestion('');
    onNewChat?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {(modelCaption || showNewChat) && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, minWidth: 0 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            title={modelCaption ?? undefined}
            sx={{ flex: 1, minWidth: 0 }}
            data-testid={modelCaption ? 'assistant-model' : undefined}
          >
            {modelCaption}
          </Typography>
          {showNewChat && (
            <Button
              size="small"
              onClick={newChat}
              startIcon={<AddCommentOutlinedIcon />}
              aria-label="Start a new chat"
              data-testid="assistant-new-chat"
              sx={{ flexShrink: 0 }}
            >
              New chat
            </Button>
          )}
        </Box>
      )}
      <Box
        role="log"
        aria-label="Assistant conversation"
        aria-live="polite"
        sx={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
          minHeight: 0,
          minWidth: 0,
          pb: 1,
        }}
      >
        {messages.length === 0 && <EmptyState disabled={isStreaming} onAsk={onAsk} />}
        {messages.map((message) =>
          message.role === 'user' ? (
            <Paper
              key={message.id}
              elevation={0}
              data-testid="assistant-question"
              sx={{
                alignSelf: 'flex-end',
                maxWidth: '90%',
                px: 1.5,
                py: 1,
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {message.text}
            </Paper>
          ) : (
            <Reply
              key={message.id}
              message={message}
              onInsert={onInsert}
              onInsertAndRun={onInsertAndRun}
            />
          ),
        )}
        <div ref={endRef} />
      </Box>
      <Box component="form" onSubmit={submit} sx={{ pt: 1, display: 'flex', gap: 1, alignItems: 'flex-end' }}>
        <TextField
          fullWidth
          multiline
          maxRows={6}
          autoFocus={Boolean(initialQuestion)}
          size="small"
          placeholder="Describe a problem or ask a question…"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          slotProps={{ htmlInput: { 'aria-label': 'Ask the assistant', maxLength: ASSISTANT_QUESTION_MAX } }}
        />
        {isStreaming ? (
          <Button variant="outlined" color="inherit" onClick={onStop} startIcon={<StopIcon />}>
            Stop
          </Button>
        ) : (
          <Button type="submit" variant="contained" disabled={!question.trim()} startIcon={<SendIcon />}>
            Ask
          </Button>
        )}
      </Box>
    </Box>
  );
}
