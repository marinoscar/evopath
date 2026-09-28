/**
 * `AiImageGallery` and Image mode's file checks — issue #445.
 *
 * The gallery shows each image an image run created from a signed URL, with
 * the prompt as its alt text and a Download link; `aiImageFileProblem` is the
 * client-side mirror of the edit route's input rules.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { mockAiImageRunOutput, mockSignedUrl } from '../../mocks/fixtures/ai';
import { AiImageGallery, aiImageAltText } from '../../../components/ai/AiImageGallery';
import { aiImageFileProblem } from '../../../components/ai/playground/AiImageMode';

describe('aiImageAltText', () => {
  it('is the prompt, numbered when there are several images', () => {
    expect(aiImageAltText('A red kite', 0, 1)).toBe('A red kite');
    expect(aiImageAltText('A red kite', 1, 3)).toBe('A red kite (image 2 of 3)');
    expect(aiImageAltText('   ', 0, 1)).toBe('AI-generated image');
  });
});

describe('AiImageGallery', () => {
  it('shows every image from its signed URL with the prompt as alt text and a download link', async () => {
    render(<AiImageGallery output={mockAiImageRunOutput} prompt="A lighthouse" />);

    const list = screen.getByRole('list', { name: 'Generated images' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const images = await within(list).findAllByRole('img');
    expect(images.map((image) => image.getAttribute('alt'))).toEqual([
      'A lighthouse (image 1 of 2)',
      'A lighthouse (image 2 of 2)',
    ]);
    expect(images[1]).toHaveAttribute('src', mockSignedUrl(mockAiImageRunOutput.images[1].storageObjectId));

    const download = within(list).getByRole('link', { name: 'Download image 2' });
    expect(download).toHaveAttribute('href', mockSignedUrl(mockAiImageRunOutput.images[1].storageObjectId));
    expect(download).toHaveAttribute('download', 'ai-image-2.png');
    expect(download).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(list).getByText('Revised prompt: A watercolour lighthouse at dusk, soft light')).toBeInTheDocument();
  });

  it('shows an error in place of an image whose download URL cannot be had', async () => {
    server.use(
      http.get('*/api/storage/objects/:id/download', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'Object not found' }, { status: 404 }),
      ),
    );
    render(
      <AiImageGallery
        output={{ ...mockAiImageRunOutput, images: [mockAiImageRunOutput.images[0]] }}
        prompt="A lighthouse"
      />,
    );

    expect(await screen.findByText('Object not found')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('says so when the run returned no images', () => {
    render(<AiImageGallery output={{ ...mockAiImageRunOutput, images: [], storageObjectIds: [] }} prompt="x" />);
    expect(screen.getByText('The run finished without returning any images.')).toBeInTheDocument();
  });
});

describe('aiImageFileProblem', () => {
  const file = (type: string, size = 10) => new File([new Uint8Array(size)], 'f', { type });

  it('accepts PNG, JPEG and WebP sources, and only PNG masks', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(aiImageFileProblem(file(type), 'source')).toBeNull();
    }
    expect(aiImageFileProblem(file('image/gif'), 'source')).toBe('Choose a PNG, JPEG or WebP image');
    expect(aiImageFileProblem(file('image/png'), 'mask')).toBeNull();
    expect(aiImageFileProblem(file('image/jpeg'), 'mask')).toBe('The mask must be a PNG image');
  });

  it('refuses a file over 25 MiB', () => {
    const big = file('image/png');
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 + 1 });
    expect(aiImageFileProblem(big, 'source')).toBe('Images must be 25 MB or smaller');
  });
});
