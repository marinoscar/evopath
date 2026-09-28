/**
 * What `POST /api/ai/embeddings` returned, made readable — issue #445
 * (API: #440).
 *
 * A summary (count, dimensions, model, tokens), each vector's first
 * {@link AI_EMBEDDING_PREVIEW_VALUES} values, and — for at most
 * {@link AI_EMBEDDING_SIMILARITY_MAX_INPUTS} inputs — the cosine similarity
 * matrix. Both are real `<table>`s with a caption and scoped header cells, so
 * a screen reader announces the row and column of every number.
 */
import { useMemo } from 'react';
import {
  Box,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { AiEmbeddingsResponse } from '../../services/ai';
import { similarityMatrix } from './playground/embeddingMath';

/** Values shown per vector. */
export const AI_EMBEDDING_PREVIEW_VALUES = 8;
/** The largest batch the similarity matrix is drawn for (10 × 10). */
export const AI_EMBEDDING_SIMILARITY_MAX_INPUTS = 10;

export interface AiEmbeddingsResultProps {
  /** The inputs, in the order they were sent. */
  inputs: string[];
  result: AiEmbeddingsResponse;
}

const captionSx = { captionSide: 'top', px: 0, pt: 0, color: 'text.primary', typography: 'subtitle2' } as const;

function truncate(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function AiEmbeddingsResult({ inputs, result }: AiEmbeddingsResultProps) {
  const { vectors, dimensions } = result;
  const showMatrix = vectors.length >= 2 && vectors.length <= AI_EMBEDDING_SIMILARITY_MAX_INPUTS;
  const matrix = useMemo(() => (showMatrix ? similarityMatrix(vectors) : []), [showMatrix, vectors]);

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }} data-testid="embeddings-result">
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }} aria-label="Embeddings summary" role="group">
        <Chip size="small" label={`${vectors.length} ${vectors.length === 1 ? 'vector' : 'vectors'}`} />
        <Chip size="small" label={`${dimensions} dimensions`} />
        <Chip size="small" variant="outlined" label={result.model} />
        {result.usage.inputTokens !== undefined && (
          <Chip size="small" variant="outlined" label={`${result.usage.inputTokens} input tokens`} />
        )}
      </Box>

      <TableContainer sx={{ maxWidth: '100%', overflowX: 'auto' }}>
        <Table size="small" aria-label="Vectors">
          <Box component="caption" sx={captionSx}>
            Vectors — first {AI_EMBEDDING_PREVIEW_VALUES} of {dimensions} values
          </Box>
          <TableHead>
            <TableRow>
              <TableCell component="th" scope="col">#</TableCell>
              <TableCell component="th" scope="col">Input</TableCell>
              <TableCell component="th" scope="col">Values</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {vectors.map((vector, index) => (
              <TableRow key={index}>
                <TableCell component="th" scope="row">{index + 1}</TableCell>
                <TableCell sx={{ maxWidth: 220, wordBreak: 'break-word' }} title={inputs[index]}>
                  {truncate(inputs[index] ?? '')}
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                  [{vector.slice(0, AI_EMBEDDING_PREVIEW_VALUES).map((value) => value.toFixed(4)).join(', ')}
                  {vector.length > AI_EMBEDDING_PREVIEW_VALUES ? ', …' : ''}]
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {showMatrix && (
        <TableContainer sx={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Table size="small" aria-label="Cosine similarity">
            <Box component="caption" sx={captionSx}>
              Cosine similarity (1 = same direction, 0 = unrelated)
            </Box>
            <TableHead>
              <TableRow>
                <TableCell component="th" scope="col">
                  <Box component="span" sx={visuallyHidden}>Input</Box>
                </TableCell>
                {inputs.map((input, index) => (
                  <TableCell key={index} component="th" scope="col" align="right" title={input}>
                    {index + 1}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {matrix.map((row, i) => (
                <TableRow key={i}>
                  <TableCell component="th" scope="row" title={inputs[i]} sx={{ whiteSpace: 'nowrap' }}>
                    {i + 1}. {truncate(inputs[i] ?? '', 24)}
                  </TableCell>
                  {row.map((value, j) => (
                    <TableCell
                      key={j}
                      align="right"
                      sx={{
                        fontFamily: 'monospace',
                        fontSize: '0.8125rem',
                        // Shade by similarity; the number itself carries the meaning.
                        bgcolor: (theme) =>
                          `color-mix(in srgb, ${theme.palette.primary.main} ${Math.round(Math.max(0, value) * 35)}%, transparent)`,
                      }}
                    >
                      {value.toFixed(3)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {vectors.length > AI_EMBEDDING_SIMILARITY_MAX_INPUTS && (
        <Typography variant="body2" color="text.secondary">
          The similarity matrix is shown for up to {AI_EMBEDDING_SIMILARITY_MAX_INPUTS} inputs.
        </Typography>
      )}
    </Stack>
  );
}

const visuallyHidden = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: 1,
  margin: -1,
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: 1,
} as const;

export default AiEmbeddingsResult;
