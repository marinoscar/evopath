/**
 * The Playground's Embeddings mode — issue #445 (API: #440).
 *
 * One input per line (at most {@link AI_EMBEDDINGS_MAX_INPUTS}) →
 * `POST /ai/embeddings`, synchronously → `AiEmbeddingsResult`. Blank lines
 * are ignored. `dimensions` is optional: only some models can shorten their
 * vectors, and the API answers `AI_INVALID_REQUEST` for one that cannot —
 * rendered, like every failure, through the shared `AiErrorAlert`.
 */
import { useRef, useState, type FormEvent } from 'react';
import { Box, Button, CircularProgress, Divider, Stack, TextField, Typography } from '@mui/material';
import { Hub as HubIcon } from '@mui/icons-material';
import {
  AI_EMBEDDINGS_MAX_INPUTS,
  createAiEmbeddings,
  type AiEmbeddingsRequest,
  type AiEmbeddingsResponse,
  type UsableAiModel,
} from '../../../services/ai';
import { toAiErrorInfo, type AiErrorInfo } from '../../../services/aiErrors';
import { useIsMounted } from '../../../hooks/useIsMounted';
import { AiModelSelect } from '../AiModelSelect';
import { AiErrorAlert } from '../AiErrorAlert';
import { AiEmbeddingsResult } from '../AiEmbeddingsResult';
import { AiPlaygroundPanels } from './AiPlaygroundPanels';
import { usePlaygroundModel } from './usePlaygroundModel';
import { parseEmbeddingInputs } from './embeddingMath';

export interface AiEmbeddingsModeProps {
  /** The usable models declaring `embeddings`. */
  models: UsableAiModel[];
  preferredModel?: { provider: string; modelId: string } | null;
  ready?: boolean;
}

/** `undefined` when blank, `null` when not a positive whole number. */
function parseDimensions(value: string): number | undefined | null {
  if (value.trim() === '') return undefined;
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

export function AiEmbeddingsMode({ models, preferredModel, ready = true }: AiEmbeddingsModeProps) {
  const { modelKey, setModelKey, selected } = usePlaygroundModel(models, preferredModel, ready);
  const isMounted = useIsMounted();
  const [text, setText] = useState('');
  const [dimensionsText, setDimensionsText] = useState('');
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [error, setError] = useState<AiErrorInfo | null>(null);
  const [result, setResult] = useState<{ inputs: string[]; response: AiEmbeddingsResponse } | null>(null);
  // Only the latest request may land: an older answer never overwrites a newer one.
  const requestSeq = useRef(0);

  const inputs = parseEmbeddingInputs(text);
  const tooMany = inputs.length > AI_EMBEDDINGS_MAX_INPUTS;
  const dimensions = parseDimensions(dimensionsText);
  const canSubmit = !!selected && !isEmbedding && inputs.length > 0 && !tooMany && dimensions !== null;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit || !selected) return;
    const request: AiEmbeddingsRequest = { provider: selected.provider, model: selected.modelId, input: inputs };
    if (typeof dimensions === 'number') request.dimensions = dimensions;

    const seq = ++requestSeq.current;
    setIsEmbedding(true);
    setError(null);
    try {
      const response = await createAiEmbeddings(request);
      if (isMounted() && seq === requestSeq.current) setResult({ inputs, response });
    } catch (err) {
      if (isMounted() && seq === requestSeq.current) {
        setError(toAiErrorInfo(err, 'Could not create embeddings'));
        setResult(null);
      }
    } finally {
      if (isMounted() && seq === requestSeq.current) setIsEmbedding(false);
    }
  };

  if (!selected) return null;

  const settings = (
    <Stack spacing={2}>
      <AiModelSelect
        models={models}
        value={modelKey}
        onChange={setModelKey}
        disabled={isEmbedding}
        capability="embeddings"
      />
      <TextField
        label="Dimensions"
        size="small"
        value={dimensionsText}
        onChange={(event) => setDimensionsText(event.target.value)}
        error={dimensions === null}
        helperText={
          dimensions === null
            ? 'Enter a whole number of at least 1'
            : "Blank uses the model's full length; only some models can shorten vectors"
        }
        slotProps={{ htmlInput: { inputMode: 'numeric' } }}
      />
    </Stack>
  );

  return (
    <AiPlaygroundPanels settings={settings} label="Embeddings">
      {error && <AiErrorAlert error={error} onClose={() => setError(null)} />}

      {result ? (
        <AiEmbeddingsResult inputs={result.inputs} result={result.response} />
      ) : (
        !error && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
            Enter one text per line to see its vector and how similar the texts are.
          </Typography>
        )
      )}

      <Divider />

      <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <TextField
          label="Inputs"
          placeholder={'The cat sat on the mat\nA feline rested on the rug\nQuarterly revenue grew 4%'}
          multiline
          minRows={4}
          maxRows={14}
          fullWidth
          value={text}
          onChange={(event) => setText(event.target.value)}
          error={tooMany}
          helperText={
            tooMany
              ? `At most ${AI_EMBEDDINGS_MAX_INPUTS} inputs — remove ${inputs.length - AI_EMBEDDINGS_MAX_INPUTS}`
              : `One input per line · ${inputs.length} / ${AI_EMBEDDINGS_MAX_INPUTS}`
          }
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSubmit}
            endIcon={isEmbedding ? <CircularProgress size={16} color="inherit" aria-hidden /> : <HubIcon />}
          >
            {isEmbedding ? 'Embedding…' : 'Embed'}
          </Button>
        </Box>
      </Box>
    </AiPlaygroundPanels>
  );
}

export default AiEmbeddingsMode;
