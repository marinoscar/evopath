/**
 * `/ai` Image mode — the WIRE contract (issue #445 against #437's API).
 *
 * What the playground puts on the wire for `POST /api/ai/images`,
 * `POST /api/ai/images/edits`, the storage upload that precedes an edit, the
 * readiness read, the run poll and the signed-URL download. Only the network
 * is faked. Bodies are compared with `toEqual`: the API's DTOs are
 * `.strict()`, so an extra key is a 400, not a no-op.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  mockAiImageRun,
  mockAiImageRunOutput,
  mockPlaygroundAllModeModels,
  mockStorageObject,
} from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AI_RUN_POLL_INTERVAL_MS } from '../../hooks/useAiRun';
import { api } from '../../services/api';
import { readMultipartFile } from '../utils/multipart';

interface Captured {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

function capture(): Captured[] {
  const captured: Captured[] = [];
  const record = async (request: Request, body?: unknown) => {
    captured.push({ method: request.method, path: new URL(request.url).pathname, headers: request.headers, body });
  };
  server.use(
    http.post('*/api/ai/images', async ({ request }) => {
      await record(request, await request.json());
      return HttpResponse.json({ data: { runId: 'run_img_1', jobId: 'job-1' } }, { status: 202 });
    }),
    http.post('*/api/ai/images/edits', async ({ request }) => {
      await record(request, await request.json());
      return HttpResponse.json({ data: { runId: 'run_img_edit_1', jobId: 'job-2' } }, { status: 202 });
    }),
    http.post('*/api/storage/objects', async ({ request }) => {
      const file = await readMultipartFile(request);
      // jsdom's FormData reaches MSW with the file renamed `blob`, so the type identifies it.
      await record(request, { field: 'file', type: file.type });
      const id = file.type === 'image/png' ? '55555555-5555-4555-8555-555555555555' : '44444444-4444-4444-8444-444444444444';
      return HttpResponse.json({ data: mockStorageObject({ id, name: file.filename }) }, { status: 201 });
    }),
    http.get('*/api/storage/objects/:id', async ({ request, params }) => {
      await record(request);
      return HttpResponse.json({ data: mockStorageObject({ id: String(params.id), status: 'ready' }) });
    }),
    http.get('*/api/storage/objects/:id/download', async ({ request, params }) => {
      await record(request);
      return HttpResponse.json({ data: { url: `https://storage.example.test/${String(params.id)}`, expiresIn: 300 } });
    }),
    http.get('*/api/ai/runs/:id', async ({ request, params }) => {
      await record(request);
      return HttpResponse.json({ data: { ...mockAiImageRun, id: String(params.id) } });
    }),
  );
  return captured;
}

async function renderImageMode() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<AiPlaygroundPage />, { wrapperOptions: { route: '/ai', aiEnabled: true } });
  await user.click(await screen.findByRole('button', { name: 'Image' }));
  const panel = screen.getByTestId('playground-mode-image');
  await waitFor(() => expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent('GPT Image 1'));
  return { user, panel };
}

async function choose(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, label: string, option: string) {
  await user.click(within(panel).getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: mockPlaygroundAllModeModels })));
  api.setAccessToken('access-token-1');
});

afterEach(() => {
  api.setAccessToken(null);
  vi.useRealTimers();
});

describe('AiPlaygroundPage Image mode — wire', () => {
  it('POSTs a minimal generation: only provider, model and prompt when options are left at their defaults', async () => {
    const captured = capture();
    const { user, panel } = await renderImageMode();

    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), '  A red kite  ');
    await user.click(within(panel).getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(captured.some((c) => c.path === '/api/ai/images')).toBe(true));
    const post = captured.find((c) => c.path === '/api/ai/images')!;
    expect(post.method).toBe('POST');
    expect(post.headers.get('authorization')).toBe('Bearer access-token-1');
    expect(post.body).toEqual({ provider: 'openai', model: 'gpt-image-1', prompt: 'A red kite' });
  });

  it('sends size, quality and n when chosen, then polls the run and fetches one signed URL per image', async () => {
    const captured = capture();
    const { user, panel } = await renderImageMode();

    await choose(user, panel, 'Size', '1536 × 1024');
    await choose(user, panel, 'Quality', 'High');
    await choose(user, panel, 'Number of images', '2');
    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'Two kites');
    await user.click(within(panel).getByRole('button', { name: 'Generate images' }));

    await waitFor(() => expect(captured.some((c) => c.path === '/api/ai/images')).toBe(true));
    expect(captured.find((c) => c.path === '/api/ai/images')!.body).toEqual({
      provider: 'openai',
      model: 'gpt-image-1',
      prompt: 'Two kites',
      size: '1536x1024',
      quality: 'high',
      n: 2,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(within(panel).getAllByRole('img')).toHaveLength(2));

    const paths = captured.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('GET /api/ai/runs/run_img_1');
    for (const id of mockAiImageRunOutput.storageObjectIds) {
      expect(paths).toContain(`GET /api/storage/objects/${id}/download`);
    }
  });

  it('edit: uploads source and mask as multipart "file", waits for ready, then POSTs their ids', async () => {
    const captured = capture();
    const { user, panel } = await renderImageMode();

    await user.click(within(panel).getByRole('switch', { name: 'Edit an image' }));
    await user.upload(within(panel).getByLabelText('Source image'), new File(['jpg'], 'photo.jpg', { type: 'image/jpeg' }));
    await user.upload(within(panel).getByLabelText('Mask'), new File(['png'], 'mask.png', { type: 'image/png' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Prompt' }), 'Add a boat');
    await user.click(within(panel).getByRole('button', { name: 'Edit image' }));

    await waitFor(() => expect(captured.some((c) => c.path === '/api/ai/images/edits')).toBe(true), { timeout: 5000 });

    const uploads = captured.filter((c) => c.method === 'POST' && c.path === '/api/storage/objects');
    expect(uploads.map((c) => c.body)).toEqual(
      expect.arrayContaining([
        { field: 'file', type: 'image/jpeg' },
        { field: 'file', type: 'image/png' },
      ]),
    );
    // Neither upload is ready on arrival, so each is read back before the edit is sent.
    const reads = captured.filter((c) => c.method === 'GET' && /^\/api\/storage\/objects\/[^/]+$/.test(c.path));
    expect(reads.map((c) => c.path).sort()).toEqual([
      '/api/storage/objects/44444444-4444-4444-8444-444444444444',
      '/api/storage/objects/55555555-5555-4555-8555-555555555555',
    ]);
    const editIndex = captured.findIndex((c) => c.path === '/api/ai/images/edits');
    expect(captured.indexOf(reads[reads.length - 1])).toBeLessThan(editIndex);

    expect(captured[editIndex].body).toEqual({
      provider: 'openai',
      model: 'gpt-image-1',
      prompt: 'Add a boat',
      imageStorageObjectIds: ['44444444-4444-4444-8444-444444444444'],
      maskStorageObjectId: '55555555-5555-4555-8555-555555555555',
    });
  });
});
