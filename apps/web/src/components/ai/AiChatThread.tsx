/**
 * The playground's conversation — issue #434, epic #419.
 *
 * Assistant text is rendered as PLAIN TEXT with `white-space: pre-wrap`: the
 * web app has no Markdown dependency and the issue forbids adding a heavy one
 * for this page. Line breaks, lists and code blocks from the model therefore
 * keep their shape, just without formatting; and nothing the model says is
 * ever interpreted as HTML (React escapes it).
 *
 * The thread is a `role="log"` region: assistive technology announces new
 * messages, while `aria-busy` on a streaming message stops it reading every
 * token as it lands.
 */
import { useEffect, useRef } from 'react';
import { Box, Chip, Paper, Typography } from '@mui/material';
import type { AiUsage } from '../../services/ai';
import type { AiChatMessage } from '../../hooks/useAiChat';
import { AiErrorAlert } from './AiErrorAlert';
import { AiReasoningPanel } from './AiReasoningPanel';
import { AiStructuredOutputPanel } from './AiStructuredOutputPanel';
import { AiAttachmentChips } from './AiAttachmentChips';
import { AiHostedToolOutputs } from './AiHostedToolOutputs';

export function formatAiUsage(usage: AiUsage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
  if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
  if (usage.reasoningTokens !== undefined) parts.push(`${usage.reasoningTokens} reasoning`);
  return parts.length ? `Tokens: ${parts.join(' · ')}` : null;
}

function AssistantBody({ message }: { message: AiChatMessage }) {
  const usage = formatAiUsage(message.usage);
  const waiting = message.status === 'streaming' && message.text === '';

  return (
    <>
      {message.reasoning && (
        <AiReasoningPanel
          text={message.reasoning}
          streaming={message.status === 'streaming' && message.text === ''}
        />
      )}
      {waiting && message.reasoning ? null : waiting ? (
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          Thinking…
        </Typography>
      ) : (
        message.text && (
          <Typography
            variant="body1"
            component="div"
            data-testid="assistant-text"
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {message.text}
          </Typography>
        )
      )}
      {message.parsed !== undefined && message.parsed !== null && (
        <AiStructuredOutputPanel parsed={message.parsed} />
      )}
      {message.error && (
        <Box sx={{ mt: message.text ? 1 : 0 }}>
          <AiErrorAlert error={message.error} />
        </Box>
      )}
      <Box
        sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 1 }}
        data-testid="message-footer"
      >
        {message.status === 'stopped' && <Chip size="small" label="Stopped" />}
        {message.runId && <Chip size="small" variant="outlined" label="Background run" />}
        {usage && (
          <Typography variant="caption" color="text.secondary">
            {usage}
          </Typography>
        )}
      </Box>
    </>
  );
}

export interface AiChatThreadProps {
  messages: AiChatMessage[];
}

export function AiChatThread({ messages }: AiChatThreadProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const last = messages[messages.length - 1];

  // Follow the conversation as it grows (jsdom has no scrollIntoView).
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, last?.text, last?.reasoning]);

  return (
    <Box
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}
    >
      {messages.map((message) =>
        message.role === 'user' ? (
          <Paper
            key={message.id}
            elevation={0}
            data-testid="user-message"
            sx={{
              alignSelf: 'flex-end',
              maxWidth: { xs: '90%', sm: '80%' },
              px: 1.5,
              py: 1,
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {message.text}
            {message.attachments && message.attachments.length > 0 && (
              <Box sx={{ mt: 0.75, whiteSpace: 'normal' }}>
                <AiAttachmentChips
                  tone="contrast"
                  label="Attached files"
                  items={message.attachments.map((attachment) => ({
                    key: attachment.storageObjectId,
                    name: attachment.name,
                    size: attachment.size,
                    kind: attachment.kind,
                  }))}
                />
              </Box>
            )}
          </Paper>
        ) : (
          <Paper
            key={message.id}
            variant="outlined"
            data-testid="assistant-message"
            data-status={message.status}
            aria-busy={message.status === 'streaming'}
            sx={{ alignSelf: 'stretch', px: 1.5, py: 1, minWidth: 0 }}
          >
            <AssistantBody message={message} />
            {message.status === 'done' && <AiHostedToolOutputs output={message.output} />}
          </Paper>
        ),
      )}
      <div ref={endRef} />
    </Box>
  );
}

export default AiChatThread;
