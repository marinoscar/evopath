/**
 * The Playground's Speech mode — issue #445 (API: #439,
 * docs/specs/ai-platform.md §2.14).
 *
 * Text (1–4096 characters, with a live counter), a voice from the selected
 * model's own `capabilities.voices`, an output format and optional style
 * instructions → `POST /ai/audio/speech`. The run is polled by the shared
 * `useAiRun`; a succeeded run's audio plays in `AiSpeechPlayer`, which always
 * shows the "AI-generated audio" disclosure.
 *
 * VOICES FOLLOW THE MODEL. A model that lists no voices gets no voice field
 * and the request omits `voice` — the API then uses the model's first. No
 * voice name is hard-coded here.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Box, Button, Divider, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { RecordVoiceOver as SpeakIcon } from '@mui/icons-material';
import {
  AI_SPEECH_FORMATS,
  AI_SPEECH_INPUT_MAX_CHARS,
  createAiSpeechRun,
  isAiSpeechRunOutput,
  type AiSpeechFormat,
  type AiSpeechRequest,
  type UsableAiModel,
} from '../../../services/ai';
import { useAiRun } from '../../../hooks/useAiRun';
import { AiModelSelect } from '../AiModelSelect';
import { AiRunCard } from '../AiRunCard';
import { AiSpeechPlayer } from '../AiSpeechPlayer';
import { AiPlaygroundPanels } from './AiPlaygroundPanels';
import { usePlaygroundModel } from './usePlaygroundModel';

export interface AiSpeechModeProps {
  /** The usable models declaring `audio_speech`. */
  models: UsableAiModel[];
  preferredModel?: { provider: string; modelId: string } | null;
  ready?: boolean;
  runPollIntervalMs?: number;
}

export function AiSpeechMode({ models, preferredModel, ready = true, runPollIntervalMs }: AiSpeechModeProps) {
  const { modelKey, setModelKey, selected } = usePlaygroundModel(models, preferredModel, ready);
  const run = useAiRun(runPollIntervalMs !== undefined ? { intervalMs: runPollIntervalMs } : {});

  const voices = selected?.capabilities.voices ?? [];
  const [voice, setVoice] = useState('');
  const [format, setFormat] = useState<AiSpeechFormat>('mp3');
  const [instructions, setInstructions] = useState('');
  const [text, setText] = useState('');
  const [runText, setRunText] = useState('');

  // Keep the voice one the selected model speaks: its first, until the user picks another.
  useEffect(() => {
    if (voices.length === 0) {
      if (voice !== '') setVoice('');
    } else if (!voices.includes(voice)) {
      setVoice(voices[0]);
    }
  }, [voices, voice]);

  const length = text.length;
  const tooLong = length > AI_SPEECH_INPUT_MAX_CHARS;
  const busy = run.isActive;
  const canSubmit = !!selected && !busy && text.trim() !== '' && !tooLong;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit || !selected) return;
    const request: AiSpeechRequest = { provider: selected.provider, model: selected.modelId, input: text, format };
    if (voice) request.voice = voice;
    if (instructions.trim()) request.instructions = instructions.trim();
    setRunText(text);
    void run.startWith(() => createAiSpeechRun(request));
  };

  if (!selected) return null;

  const settings = (
    <Stack spacing={2}>
      <AiModelSelect models={models} value={modelKey} onChange={setModelKey} disabled={busy} capability="audio_speech" />
      {voices.length > 0 && (
        <TextField select size="small" label="Voice" value={voice} onChange={(event) => setVoice(event.target.value)}>
          {voices.map((name) => (
            <MenuItem key={name} value={name}>
              {name}
            </MenuItem>
          ))}
        </TextField>
      )}
      <TextField
        select
        size="small"
        label="Format"
        value={format}
        onChange={(event) => setFormat(event.target.value as AiSpeechFormat)}
      >
        {AI_SPEECH_FORMATS.map((option) => (
          <MenuItem key={option} value={option}>
            {option.toUpperCase()}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        label="Style instructions"
        placeholder="Calm and slow"
        multiline
        minRows={2}
        maxRows={6}
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        helperText="Optional; not every model supports it"
      />
    </Stack>
  );

  const output = run.run?.status === 'succeeded' && isAiSpeechRunOutput(run.run.output) ? run.run.output : null;
  const showCard = runText !== '' && (run.isActive || run.run || run.error);

  return (
    <AiPlaygroundPanels settings={settings} label="Speech">
      {!showCard && !output && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
          Enter text to hear it spoken. The audio is AI-generated and labelled as such.
        </Typography>
      )}

      {showCard && (
        <AiRunCard
          title="Speech run"
          successMessage={null}
          prompt={runText}
          run={run.run}
          error={run.error}
          stale={run.stale}
          isStarting={run.isStarting}
          isCancelling={run.isCancelling}
          onCancel={() => void run.cancel()}
          onDismiss={() => {
            run.clear();
            setRunText('');
          }}
        />
      )}

      {output && <AiSpeechPlayer output={output} />}

      <Divider />

      <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <TextField
          label="Text to speak"
          multiline
          minRows={3}
          maxRows={10}
          fullWidth
          value={text}
          onChange={(event) => setText(event.target.value)}
          error={tooLong}
          helperText={
            <span aria-live="polite">
              {length.toLocaleString()} / {AI_SPEECH_INPUT_MAX_CHARS.toLocaleString()} characters
              {tooLong ? ' — shorten the text or split it into several runs' : ''}
            </span>
          }
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="submit" variant="contained" endIcon={<SpeakIcon />} disabled={!canSubmit}>
            Generate speech
          </Button>
        </Box>
      </Box>
    </AiPlaygroundPanels>
  );
}

export default AiSpeechMode;
