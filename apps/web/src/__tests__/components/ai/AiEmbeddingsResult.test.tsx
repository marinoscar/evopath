/**
 * Embeddings mode's maths and result view — issue #445.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import {
  cosineSimilarity,
  parseEmbeddingInputs,
  similarityMatrix,
} from '../../../components/ai/playground/embeddingMath';
import { AiEmbeddingsResult } from '../../../components/ai/AiEmbeddingsResult';
import type { AiEmbeddingsResponse } from '../../../services/ai';

describe('embeddingMath', () => {
  it('parses one trimmed input per non-blank line (LF or CRLF)', () => {
    expect(parseEmbeddingInputs(' a \r\n\n  \nb\n')).toEqual(['a', 'b']);
    expect(parseEmbeddingInputs('')).toEqual([]);
  });

  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('builds a symmetric matrix with 1 on the diagonal', () => {
    const matrix = similarityMatrix([
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(matrix[0][0]).toBe(1);
    expect(matrix[0][1]).toBeCloseTo(Math.SQRT1_2);
    expect(matrix[1][0]).toBeCloseTo(matrix[0][1]);
    expect(matrix[0][2]).toBeCloseTo(0);
  });
});

describe('AiEmbeddingsResult', () => {
  const result: AiEmbeddingsResponse = {
    provider: 'acme',
    model: 'embed-x',
    dimensions: 10,
    vectors: [
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0.123456],
      [0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
    usage: { inputTokens: 6 },
  };

  it('summarises and previews the first 8 values', () => {
    render(<AiEmbeddingsResult inputs={['alpha', 'beta']} result={result} />);

    const summary = screen.getByRole('group', { name: 'Embeddings summary' });
    expect(summary).toHaveTextContent('2 vectors');
    expect(summary).toHaveTextContent('10 dimensions');
    expect(summary).toHaveTextContent('embed-x');
    expect(summary).toHaveTextContent('6 input tokens');

    const table = screen.getByRole('table', { name: 'Vectors' });
    expect(within(table).getByText('Vectors — first 8 of 10 values')).toBeInTheDocument();
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('[1.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, …]');
    expect(row).not.toHaveTextContent('0.1235');
  });

  it('labels every matrix cell by row and column header', () => {
    render(<AiEmbeddingsResult inputs={['alpha', 'beta']} result={result} />);

    const matrix = screen.getByRole('table', { name: 'Cosine similarity' });
    const columnHeaders = within(matrix).getAllByRole('columnheader');
    expect(columnHeaders.map((header) => header.textContent)).toEqual(['Input', '1', '2']);
    for (const header of columnHeaders.slice(1)) expect(header).toHaveAttribute('scope', 'col');
    const rowHeaders = within(matrix).getAllByRole('rowheader');
    expect(rowHeaders.map((header) => header.textContent)).toEqual(['1. alpha', '2. beta']);
    for (const header of rowHeaders) expect(header).toHaveAttribute('scope', 'row');
    expect(within(matrix).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      '1.000',
      '0.000',
      '0.000',
      '1.000',
    ]);
  });

  it('has no matrix for a single input', () => {
    render(<AiEmbeddingsResult inputs={['alpha']} result={{ ...result, vectors: [result.vectors[0]] }} />);
    expect(screen.getByRole('group', { name: 'Embeddings summary' })).toHaveTextContent('1 vector');
    expect(screen.queryByRole('table', { name: 'Cosine similarity' })).not.toBeInTheDocument();
  });
});
