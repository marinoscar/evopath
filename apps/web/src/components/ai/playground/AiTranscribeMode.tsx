/**
 * The Playground's Transcribe mode — issue #445 (API: #438,
 * docs/specs/ai-platform.md §2.13).
 *
 * Choose a recording (any `audio/*`, or MP4/WebM video, at most 25 MiB —
 * checked here before anything is uploaded), upload it through the storage
 * API and wait for it to be `ready`, then `POST /ai/audio/transcriptions`
 * with its `storageObjectId`. The run is polled by the shared `useAiRun` and
 * shown in the shared `AiRunCard`; a succeeded run's transcript renders in
 * `AiTranscript` (segments with timestamps when the model produced them).
 *
 * Transcription is always asynchronous, whatever `allowBackgroundRuns` says.
 */
import { useState, type FormEvent } from 'react';
import { Alert, Box, Button, Divider, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import { GraphicEq as TranscribeIcon, UploadFile as UploadFileIcon } from '@mui/icons-material';
import {
  AI_TRANSCRIPTION_INPUT_ACCEPT,
  AI_TRANSCRIPTION_MAX_BYTES,
  AI_TRANSCRIPTION_PROMPT_MAX_CHARS,
  createAiTranscriptionRun,
  isAiTranscriptionRunOutput,
  type AiTranscriptionRequest,
  type UsableAiModel,
} from '../../../services/ai';
import { uploadStorageObjectAndWait, type WaitForReadyOptions } from '../../../services/storage';
import { toAiErrorInfo, type AiErrorInfo } from '../../../services/aiErrors';
import { useAiRun } from '../../../hooks/useAiRun';
import { useIsMounted } from '../../../hooks/useIsMounted';
import { AiModelSelect } from '../AiModelSelect';
import { AiRunCard } from '../AiRunCard';
import { AiErrorAlert } from '../AiErrorAlert';
import { AiTranscript } from '../AiTranscript';
import { AiPlaygroundPanels } from './AiPlaygroundPanels';
import { AiFilePicker } from './AiFilePicker';
import { usePlaygroundModel } from './usePlaygroundModel';

const LANGUAGE_CODE = /^[a-z]{2}$/i;

/** Why `file` cannot be transcribed, or `null` when it can (mirrors the API's resolver). */
export function audioFileProblem(file: File): string | null {
  const type = file.type.split(';')[0].trim().toLowerCase();
  const allowed = (type.startsWith('audio/') && type.length > 'audio/'.length) || type === 'video/mp4' || type === 'video/webm';
  if (!allowed) return 'Choose an audio file (or an MP4/WebM video)';
  if (file.size > AI_TRANSCRIPTION_MAX_BYTES) return 'Recordings must be 25 MB or smaller';
  return null;
}

export interface AiTranscribeModeProps {
  /** The usable models declaring `audio_transcription`. */
  models: UsableAiModel[];
  preferredModel?: { provider: string; modelId: string } | null;
  ready?: boolean;
  runPollIntervalMs?: number;
  uploadWaitOptions?: WaitForReadyOptions;
}

export function AiTranscribeMode({
  models,
  preferredModel,
  ready = true,
  runPollIntervalMs,
  uploadWaitOptions,
}: AiTranscribeModeProps) {
  const { modelKey, setModelKey, selected } = usePlaygroundModel(models, preferredModel, ready);
  const run = useAiRun(runPollIntervalMs !== undefined ? { intervalMs: runPollIntervalMs } : {});
  const isMounted = useIsMounted();

  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState('');
  const [prompt, setPrompt] = useState('');
  const [timestamps, setTimestamps] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<AiErrorInfo | null>(null);
  // The name of the recording the shown run is transcribing.
  const [runLabel, setRunLabel] = useState('');

  const fileError = file ? audioFileProblem(file) : null;
  const languageInvalid = language.trim() !== '' && !LANGUAGE_CODE.test(language.trim());
  const promptTooLong = prompt.length > AI_TRANSCRIPTION_PROMPT_MAX_CHARS;
  const busy = isUploading || run.isActive;
  const canSubmit = !!selected && !busy && file !== null && fileError === null && !languageInvalid && !promptTooLong;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit || !selected || !file) return;
    setUploadError(null);
    run.clear();
    setRunLabel(file.name);
    setIsUploading(true);
    let storageObjectId: string;
    try {
      storageObjectId = (await uploadStorageObjectAndWait(file, uploadWaitOptions)).id;
    } catch (err) {
      if (isMounted()) {
        setUploadError(toAiErrorInfo(err, 'Could not upload the recording'));
        setIsUploading(false);
      }
      return;
    }
    if (!isMounted()) return;
    setIsUploading(false);

    const request: AiTranscriptionRequest = { provider: selected.provider, model: selected.modelId, storageObjectId };
    if (language.trim()) request.language = language.trim().toLowerCase();
    if (prompt.trim()) request.prompt = prompt.trim();
    if (timestamps) request.timestampGranularities = ['segment'];
    void run.startWith(() => createAiTranscriptionRun(request));
  };

  if (!selected) return null;

  const settings = (
    <Stack spacing={2}>
      <AiModelSelect
        models={models}
        value={modelKey}
        onChange={setModelKey}
        disabled={busy}
        capability="audio_transcription"
      />
      <TextField
        size="small"
        label="Language"
        placeholder="en"
        value={language}
        onChange={(event) => setLanguage(event.target.value)}
        error={languageInvalid}
        helperText={languageInvalid ? 'A two-letter ISO-639-1 code, such as "en"' : 'Optional; blank detects it'}
        slotProps={{ htmlInput: { maxLength: 2 } }}
      />
      <TextField
        size="small"
        label="Vocabulary hint"
        placeholder="Names or jargon to expect"
        multiline
        minRows={2}
        maxRows={6}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        error={promptTooLong}
        helperText={promptTooLong ? `At most ${AI_TRANSCRIPTION_PROMPT_MAX_CHARS.toLocaleString()} characters` : 'Optional'}
      />
      <FormControlLabel
        control={<Switch checked={timestamps} onChange={(event) => setTimestamps(event.target.checked)} />}
        label="Timestamps"
      />
    </Stack>
  );

  const output = run.run?.status === 'succeeded' && isAiTranscriptionRunOutput(run.run.output) ? run.run.output : null;
  const showCard = runLabel !== '' && !isUploading && (run.isActive || run.run || run.error);

  return (
    <AiPlaygroundPanels settings={settings} label="Transcribe">
      {!showCard && !output && !uploadError && !isUploading && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
          Choose a recording to transcribe.
        </Typography>
      )}

      {isUploading && (
        <Alert severity="info" icon={<UploadFileIcon />}>
          Uploading…
        </Alert>
      )}

      {uploadError && <AiErrorAlert error={uploadError} onClose={() => setUploadError(null)} />}

      {showCard && (
        <AiRunCard
          title="Transcription run"
          successMessage={null}
          prompt={runLabel}
          run={run.run}
          error={run.error}
          stale={run.stale}
          isStarting={run.isStarting}
          isCancelling={run.isCancelling}
          onCancel={() => void run.cancel()}
          onDismiss={() => {
            run.clear();
            setRunLabel('');
          }}
        />
      )}

      {output && <AiTranscript output={output} />}

      <Divider />

      <Box
        component="form"
        onSubmit={(event) => void submit(event)}
        sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
      >
        <AiFilePicker
          label="Recording"
          accept={AI_TRANSCRIPTION_INPUT_ACCEPT}
          file={file}
          error={fileError}
          disabled={busy}
          onChange={setFile}
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="submit" variant="contained" endIcon={<TranscribeIcon />} disabled={!canSubmit}>
            Transcribe
          </Button>
        </Box>
      </Box>
    </AiPlaygroundPanels>
  );
}

export default AiTranscribeMode;
