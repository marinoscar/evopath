/**
 * The Playground's Image mode — issue #445 (API: #437).
 *
 * Generate: prompt + size/quality/count → `POST /ai/images`. Edit (only when
 * the selected model declares `image_edit`): the same plus a source image and
 * an optional PNG mask, uploaded first through the storage API
 * (`services/storage.ts`) and named by `storageObjectId` →
 * `POST /ai/images/edits`. Either answers 202 `{ runId }`; the run is polled
 * by the shared `useAiRun` and shown in the shared `AiRunCard`, and a
 * succeeded run's storage objects are shown by `AiImageGallery`.
 *
 * Image runs are ALWAYS asynchronous (whatever `allowBackgroundRuns` says),
 * so there is no streaming path here.
 */
import { useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Image as ImageIcon, UploadFile as UploadFileIcon } from '@mui/icons-material';
import {
  AI_IMAGE_INPUT_MAX_BYTES,
  AI_IMAGE_INPUT_MIME_TYPES,
  AI_IMAGE_MASK_MIME_TYPES,
  AI_IMAGE_PROMPT_MAX_CHARS,
  AI_IMAGE_QUALITIES,
  AI_IMAGES_MAX_N,
  createAiImageEditRun,
  createAiImageRun,
  isAiImageRunOutput,
  type AiImageGenerateRequest,
  type UsableAiModel,
} from '../../../services/ai';
import { uploadStorageObjectAndWait, type WaitForReadyOptions } from '../../../services/storage';
import { toAiErrorInfo, type AiErrorInfo } from '../../../services/aiErrors';
import { useAiRun } from '../../../hooks/useAiRun';
import { useIsMounted } from '../../../hooks/useIsMounted';
import { AiModelSelect, hasAiCapability } from '../AiModelSelect';
import { AiRunCard } from '../AiRunCard';
import { AiErrorAlert } from '../AiErrorAlert';
import { AiImageGallery } from '../AiImageGallery';
import { AiPlaygroundPanels } from './AiPlaygroundPanels';
import { usePlaygroundModel } from './usePlaygroundModel';
import { AiFilePicker } from './AiFilePicker';

/** Common sizes; `''` leaves the choice to the provider. Not a per-model list — the provider validates. */
export const AI_IMAGE_SIZE_OPTIONS = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;

type Quality = (typeof AI_IMAGE_QUALITIES)[number];

export interface AiImageModeProps {
  /** The usable models declaring `image_generation`. */
  models: UsableAiModel[];
  preferredModel?: { provider: string; modelId: string } | null;
  ready?: boolean;
  /** Poll interval override for the run (tests). */
  runPollIntervalMs?: number;
  /** Upload readiness polling override (tests). */
  uploadWaitOptions?: WaitForReadyOptions;
}

type Phase = 'idle' | 'uploading';

/** Why `file` cannot be sent as the source (or mask), or `null` when it can. */
export function aiImageFileProblem(file: File, kind: 'source' | 'mask'): string | null {
  const allowed: readonly string[] = kind === 'mask' ? AI_IMAGE_MASK_MIME_TYPES : AI_IMAGE_INPUT_MIME_TYPES;
  if (!allowed.includes(file.type)) {
    return kind === 'mask' ? 'The mask must be a PNG image' : 'Choose a PNG, JPEG or WebP image';
  }
  if (file.size > AI_IMAGE_INPUT_MAX_BYTES) return 'Images must be 25 MB or smaller';
  return null;
}

export function AiImageMode({ models, preferredModel, ready = true, runPollIntervalMs, uploadWaitOptions }: AiImageModeProps) {
  const { modelKey, setModelKey, selected } = usePlaygroundModel(models, preferredModel, ready);
  const run = useAiRun(runPollIntervalMs !== undefined ? { intervalMs: runPollIntervalMs } : {});
  const isMounted = useIsMounted();

  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('');
  const [quality, setQuality] = useState<Quality | ''>('');
  const [count, setCount] = useState(1);
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState<File | null>(null);
  const [mask, setMask] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [uploadError, setUploadError] = useState<AiErrorInfo | null>(null);
  // The prompt of the shown run — its card's text and its images' alt text.
  const [runPrompt, setRunPrompt] = useState('');

  const canEdit = hasAiCapability(selected, 'image_edit');
  const editOn = canEdit && editing;
  const sourceError = source ? aiImageFileProblem(source, 'source') : null;
  const maskError = mask ? aiImageFileProblem(mask, 'mask') : null;
  const busy = phase === 'uploading' || run.isActive;
  const promptTooLong = prompt.length > AI_IMAGE_PROMPT_MAX_CHARS;
  const canSubmit =
    !!selected &&
    !busy &&
    prompt.trim() !== '' &&
    !promptTooLong &&
    (!editOn || (source !== null && sourceError === null && maskError === null));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit || !selected) return;
    const text = prompt.trim();
    const request: AiImageGenerateRequest = { provider: selected.provider, model: selected.modelId, prompt: text };
    if (size) request.size = size;
    if (quality) request.quality = quality;
    if (count !== 1) request.n = count;

    setUploadError(null);
    run.clear();
    setRunPrompt(text);

    if (!editOn) {
      void run.startWith(() => createAiImageRun(request));
      return;
    }

    setPhase('uploading');
    let imageId: string;
    let maskId: string | undefined;
    try {
      const [image, maskObject] = await Promise.all([
        uploadStorageObjectAndWait(source!, uploadWaitOptions),
        mask ? uploadStorageObjectAndWait(mask, uploadWaitOptions) : Promise.resolve(null),
      ]);
      imageId = image.id;
      maskId = maskObject?.id;
    } catch (err) {
      if (isMounted()) {
        setUploadError(toAiErrorInfo(err, 'Could not upload the image'));
        setPhase('idle');
      }
      return;
    }
    if (!isMounted()) return;
    setPhase('idle');
    void run.startWith(() =>
      createAiImageEditRun({
        ...request,
        imageStorageObjectIds: [imageId],
        ...(maskId ? { maskStorageObjectId: maskId } : {}),
      }),
    );
  };

  if (!selected) return null;

  const settings = (
    <Stack spacing={2}>
      <AiModelSelect
        models={models}
        value={modelKey}
        onChange={setModelKey}
        disabled={busy}
        capability="image_generation"
      />
      <TextField select size="small" label="Size" value={size} onChange={(event) => setSize(event.target.value)}>
        <MenuItem value="">Model default</MenuItem>
        {AI_IMAGE_SIZE_OPTIONS.map((option) => (
          <MenuItem key={option} value={option}>
            {option === 'auto' ? 'Auto' : option.replace('x', ' × ')}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        size="small"
        label="Quality"
        value={quality}
        onChange={(event) => setQuality(event.target.value as Quality | '')}
      >
        <MenuItem value="">Model default</MenuItem>
        {AI_IMAGE_QUALITIES.map((option) => (
          <MenuItem key={option} value={option}>
            {option.charAt(0).toUpperCase() + option.slice(1)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        size="small"
        label="Number of images"
        value={String(count)}
        onChange={(event) => setCount(Number(event.target.value))}
      >
        {Array.from({ length: AI_IMAGES_MAX_N }, (_unused, index) => index + 1).map((n) => (
          <MenuItem key={n} value={String(n)}>
            {n}
          </MenuItem>
        ))}
      </TextField>
      {canEdit && (
        <FormControlLabel
          control={<Switch checked={editing} onChange={(event) => setEditing(event.target.checked)} />}
          label="Edit an image"
        />
      )}
    </Stack>
  );

  const output = run.run?.status === 'succeeded' && isAiImageRunOutput(run.run.output) ? run.run.output : null;
  const showCard = runPrompt !== '' && (phase === 'uploading' || run.isActive || run.run || run.error);

  return (
    <AiPlaygroundPanels settings={settings} label="Image">
      {!showCard && !output && !uploadError && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
          Describe the image you want{editOn ? ' and choose the image to edit' : ''}.
        </Typography>
      )}

      {phase === 'uploading' && (
        <Alert severity="info" icon={<UploadFileIcon />}>
          Uploading…
        </Alert>
      )}

      {uploadError && <AiErrorAlert error={uploadError} onClose={() => setUploadError(null)} />}

      {showCard && phase !== 'uploading' && (
        <AiRunCard
          title="Image run"
          successMessage={null}
          prompt={runPrompt}
          run={run.run}
          error={run.error}
          stale={run.stale}
          isStarting={run.isStarting}
          isCancelling={run.isCancelling}
          onCancel={() => void run.cancel()}
          onDismiss={() => {
            run.clear();
            setRunPrompt('');
          }}
        />
      )}

      {output && <AiImageGallery output={output} prompt={runPrompt} />}

      <Divider />

      <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {editOn && (
          <Stack spacing={1}>
            <AiFilePicker
              label="Source image"
              accept={AI_IMAGE_INPUT_MIME_TYPES}
              file={source}
              error={sourceError}
              disabled={busy}
              onChange={setSource}
            />
            <AiFilePicker
              label="Mask"
              accept={AI_IMAGE_MASK_MIME_TYPES}
              file={mask}
              error={maskError}
              disabled={busy}
              onChange={setMask}
            />
            <Typography variant="caption" color="text.secondary">
              Optional mask: a PNG whose transparent areas mark what may change.
            </Typography>
          </Stack>
        )}
        <TextField
          label="Prompt"
          placeholder={editOn ? 'Describe the change…' : 'Describe the image…'}
          multiline
          minRows={2}
          maxRows={8}
          fullWidth
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          error={promptTooLong}
          helperText={promptTooLong ? `At most ${AI_IMAGE_PROMPT_MAX_CHARS.toLocaleString()} characters` : undefined}
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="submit" variant="contained" endIcon={<ImageIcon />} disabled={!canSubmit}>
            {editOn ? 'Edit image' : count > 1 ? 'Generate images' : 'Generate image'}
          </Button>
        </Box>
      </Box>
    </AiPlaygroundPanels>
  );
}

export default AiImageMode;
