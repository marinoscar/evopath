/**
 * A transcription run's result — issue #445 (API #438).
 *
 * The full text with a Copy button, the language and duration the provider
 * reported, and — when the model produced them — the timestamped segments as
 * an ordered list (`[0:04–0:09] text`). Everything is rendered as text.
 */
import { useState } from 'react';
import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { Check as CheckIcon, ContentCopy as CopyIcon } from '@mui/icons-material';
import type { AiTranscriptionRunOutput } from '../../services/ai';

/** `m:ss` (or `h:mm:ss`) for a number of seconds. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export interface AiTranscriptProps {
  output: AiTranscriptionRunOutput;
}

export function AiTranscript({ output }: AiTranscriptProps) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const segments = output.segments ?? [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output.text);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <Paper variant="outlined" component="section" aria-label="Transcript" sx={{ p: 1.5, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="subtitle2" component="h2">
            Transcript
          </Typography>
          {output.language && <Chip size="small" label={`Language: ${output.language}`} />}
          {typeof output.durationSeconds === 'number' && (
            <Chip size="small" label={`Duration: ${formatTimestamp(output.durationSeconds)}`} />
          )}
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            startIcon={copied === 'copied' ? <CheckIcon /> : <CopyIcon />}
            onClick={() => void copy()}
            disabled={output.text === ''}
          >
            {copied === 'copied' ? 'Copied' : 'Copy transcript'}
          </Button>
        </Box>
        {copied === 'failed' && (
          <Typography variant="caption" color="error" role="alert">
            Could not copy — select the text and copy it instead.
          </Typography>
        )}
        <Typography
          variant="body2"
          data-testid="transcript-text"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {output.text || 'No speech was recognised.'}
        </Typography>
        {segments.length > 0 && (
          <Box component="ol" aria-label="Segments" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
            {segments.map((segment, index) => (
              <Box component="li" key={index} sx={{ display: 'flex', gap: 1.5, py: 0.25 }}>
                <Typography
                  component="span"
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontFamily: 'monospace', flexShrink: 0, pt: 0.25 }}
                >
                  <time dateTime={`PT${segment.startSeconds}S`}>{formatTimestamp(segment.startSeconds)}</time>–
                  <time dateTime={`PT${segment.endSeconds}S`}>{formatTimestamp(segment.endSeconds)}</time>
                </Typography>
                <Typography component="span" variant="body2" sx={{ wordBreak: 'break-word' }}>
                  {segment.text}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

export default AiTranscript;
