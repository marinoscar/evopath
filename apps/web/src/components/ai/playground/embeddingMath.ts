/**
 * Embeddings mode arithmetic — issue #445 (API: #440).
 *
 * Pure functions, so the page stays presentational and the maths is unit
 * tested on its own. Cosine similarity is computed in the browser from the
 * vectors the API returned: it is a display of the result, not business
 * logic, and needs no second call.
 */

/** Non-blank lines of `text`, trimmed — one embedding input each. */
export function parseEmbeddingInputs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Cosine similarity of two equal-length vectors; `0` when either has no magnitude. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** The full pairwise matrix (symmetric, 1 on the diagonal for non-zero vectors). */
export function similarityMatrix(vectors: readonly (readonly number[])[]): number[][] {
  return vectors.map((row, i) => vectors.map((column, j) => (i === j && row.some((v) => v !== 0) ? 1 : cosineSimilarity(row, column))));
}
