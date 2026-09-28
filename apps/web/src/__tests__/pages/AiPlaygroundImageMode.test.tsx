/**
 * `/ai` — the Playground's Image mode (issue #445; API #437).
 *
 * Real page, hooks and services; only the network is faked (MSW). What
 * renders: the capability-driven model list, the edit controls only for an
 * `image_edit` model, the run card while the run is polled, the gallery of
 * signed-URL images with the prompt as alt text, and every failure through
 * the shared AI error copy.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  aiErrorBody,
  mockAiImageRun,
  mockAiImageRunOutput,
  mockAiPublicConfigEnabled,
  mockPlaygroundAllModeModels,
  mockPlaygroundImageGenerateOnlyModel,
  mockSignedUrl,
} from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';
import { AI_RUN_POLL_INTERVAL_MS } from '../../hooks/useAiRun';
import type { AiRunStatus } from '../../services/ai';

async function renderImageMode() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const aiValue: UseAiConfigReturn = {
    config: mockAiPublicConfigEnabled,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <AiConfigContext.Provider value={aiValue}>
      <AiPlaygroundPage />
    </AiConfigContext.Provider>,
    { wrapperOptions: { route: '/ai', aiEnabled: true } },
  );
  await user.click(await screen.findByRole('button', { name: 'Image' }));
  const panel = screen.getByTestId('playground-mode-image');
  const select = within(panel).getByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(select).toHaveTextContent('GPT Image 1'));
  return { user, panel };
}

function scriptImageRun(statuses: AiRunStatus[], extra: Record<string, unknown> = {}) {
  const reads: string[] = [];
  server.use(
    http.get('*/api/ai/runs/:id', ({ params }) => {
      reads.push(String(params.id));
      const status = statuses[Math.min(reads.length - 1, statuses.length - 1)];
      return HttpResponse.json({
        data: {
          ...mockAiImageRun,
          id: String(params.id),
          status,
          output: status === 'succeeded' ? mockAiImageRunOutput : null,
          ...(status === 'failed' ? extra : {}),
        },
      });
    }),
  );
  return reads;
}

/** A minimal `FileList` — `accept` only filters the picker, so a test can still hand over anything. */
function fileList(...files: File[]): FileList {
  const list = { length: files.length, item: (index: number) => files[index] ?? null } as unknown as FileList;
  files.forEach((file, index) => Object.defineProperty(list, index, { value: file, enumerable: true }));
  return list;
}

async function advancePoll(times = 1) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: mockPlaygroundAllModeModels })));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AiPlaygroundPage — Image mode', () => {
  it('lists only image-generation models', async () => {
    const { user, panel } = await renderImageMode();

    await user.click(within(panel).getByRole('combobox', { name: 'Model' }));
    const options = screen.getAllByRole('option').map((option) => option.textContent ?? '');
    expect(options.some((text) => text.includes('GPT Image 1'))).toBe(true);
    expect(options.some((text) => text.includes('DALL·E 3'))).toBe(true);
    expect(options.some((text) => text.includes('GPT-5 mini'))).toBe(false);
  });

  it('generates: polls the run and shows the images with the prompt as alt text', async () => {
    const reads = scriptImageRun(['running', 'succeeded']);
    const { user, panel } = await renderImageMode();

    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'A lighthouse at dusk');
    await user.click(within(panel).getByRole('button', { name: 'Generate image' }));

    const card = await within(panel).findByRole('region', { name: 'Image run' });
    expect(within(card).getByText('A lighthouse at dusk')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Generate image' })).toBeDisabled();

    await advancePoll();
    await waitFor(() => expect(within(card).getByTestId('run-status')).toHaveTextContent('Running'));
    await advancePoll();
    await waitFor(() => expect(within(card).getByTestId('run-status')).toHaveTextContent('Succeeded'));

    const gallery = within(panel).getByRole('list', { name: 'Generated images' });
    const images = await within(gallery).findAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('alt', 'A lighthouse at dusk (image 1 of 2)');
    expect(images[0]).toHaveAttribute('src', mockSignedUrl(mockAiImageRunOutput.images[0].storageObjectId));
    expect(images[1]).toHaveAttribute('alt', 'A lighthouse at dusk (image 2 of 2)');
    expect(within(gallery).getByText(/Revised prompt: A watercolour lighthouse/)).toBeInTheDocument();
    expect(within(gallery).getByRole('link', { name: 'Download image 1' })).toHaveAttribute(
      'href',
      mockSignedUrl(mockAiImageRunOutput.images[0].storageObjectId),
    );
    expect(reads).toHaveLength(2);
  });

  it('offers editing only for a model with image_edit', async () => {
    const { user, panel } = await renderImageMode();
    expect(within(panel).getByRole('switch', { name: 'Edit an image' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: new RegExp(mockPlaygroundImageGenerateOnlyModel.displayName!) }));
    expect(within(panel).queryByRole('switch', { name: 'Edit an image' })).not.toBeInTheDocument();
  });

  it('edit: requires a source image and rejects an unsupported file type', async () => {
    const { user, panel } = await renderImageMode();
    await user.click(within(panel).getByRole('switch', { name: 'Edit an image' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'Add a boat');

    const submit = within(panel).getByRole('button', { name: 'Edit image' });
    expect(submit).toBeDisabled();

    const gif = new File(['gif'], 'anim.gif', { type: 'image/gif' });
    fireEvent.change(within(panel).getByLabelText('Source image'), { target: { files: fileList(gif) } });
    expect(within(panel).getByText('Choose a PNG, JPEG or WebP image')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    const jpeg = new File(['jpeg'], 'mask.jpg', { type: 'image/jpeg' });
    await user.upload(within(panel).getByLabelText('Source image'), new File(['png'], 'photo.png', { type: 'image/png' }));
    fireEvent.change(within(panel).getByLabelText('Mask'), { target: { files: fileList(jpeg) } });
    expect(within(panel).getByText('The mask must be a PNG image')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.click(within(panel).getByRole('button', { name: 'Remove mask' }));
    expect(submit).toBeEnabled();
  });

  it('edit: uploads the source, waits for it, then shows the edited images', async () => {
    scriptImageRun(['succeeded']);
    const { user, panel } = await renderImageMode();
    await user.click(within(panel).getByRole('switch', { name: 'Edit an image' }));
    await user.upload(within(panel).getByLabelText('Source image'), new File(['png'], 'photo.png', { type: 'image/png' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'Add a boat');
    await user.click(within(panel).getByRole('button', { name: 'Edit image' }));

    const card = await within(panel).findByRole('region', { name: 'Image run' }, { timeout: 3000 });
    await advancePoll();
    await waitFor(() => expect(within(card).getByTestId('run-status')).toHaveTextContent('Succeeded'));
    expect(await within(panel).findAllByRole('img')).toHaveLength(2);
  });

  it('shows a refused start with the specific AI error copy', async () => {
    server.use(
      http.post('*/api/ai/images', () =>
        HttpResponse.json(aiErrorBody('AI_KEY_REQUIRED', 'Add a key'), { status: 403 }),
      ),
    );
    const { user, panel } = await renderImageMode();
    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'A cat');
    await user.click(within(panel).getByRole('button', { name: 'Generate image' }));

    expect(await within(panel).findByText('Add your API key')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Add API key' })).toHaveAttribute('href', '/settings/ai');
  });

  it('renders a run that failed for lack of storage through the shared copy', async () => {
    scriptImageRun(['failed'], {
      errorCode: 'AI_STORAGE_UNAVAILABLE',
      errorMessage: 'Object storage is not configured',
    });
    const { user, panel } = await renderImageMode();
    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'A cat');
    await user.click(within(panel).getByRole('button', { name: 'Generate image' }));

    const card = await within(panel).findByRole('region', { name: 'Image run' });
    await advancePoll();
    expect(await within(card).findByText("File storage isn't available")).toBeInTheDocument();
    expect(within(panel).queryByRole('list', { name: 'Generated images' })).not.toBeInTheDocument();
  });

  it('maps a storage-not-configured upload refusal to AI_STORAGE_UNAVAILABLE', async () => {
    server.use(
      http.post('*/api/storage/objects', () =>
        HttpResponse.json(
          { code: 'SERVICE_UNAVAILABLE', message: 'Storage is not configured', details: { reason: 'storage_not_configured' } },
          { status: 503 },
        ),
      ),
    );
    const { user, panel } = await renderImageMode();
    await user.click(within(panel).getByRole('switch', { name: 'Edit an image' }));
    await user.upload(within(panel).getByLabelText('Source image'), new File(['png'], 'photo.png', { type: 'image/png' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'Add a boat');
    await user.click(within(panel).getByRole('button', { name: 'Edit image' }));

    expect(await within(panel).findByText("File storage isn't available")).toBeInTheDocument();
    expect(within(panel).queryByRole('region', { name: 'Image run' })).not.toBeInTheDocument();
  });

  it('keeps an image run on screen across a switch to Chat and back', async () => {
    scriptImageRun(['succeeded']);
    const { user, panel } = await renderImageMode();
    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'A lighthouse');
    await user.click(within(panel).getByRole('button', { name: 'Generate image' }));
    await advancePoll();
    await within(panel).findAllByRole('img');

    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Image' }));
    expect(within(screen.getByTestId('playground-mode-image')).getAllByRole('img')).toHaveLength(2);
  });
});
