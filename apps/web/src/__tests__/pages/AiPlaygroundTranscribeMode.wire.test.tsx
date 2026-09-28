/**
 * `/ai` Transcribe mode — the WIRE contract (issue #445 against #438).
 *
 * The recording is uploaded as multipart `file`, read back until `ready`, and
 * only then named by `storageObjectId` in `POST /api/ai/audio/transcriptions`
 * (`.strict()` — compared with `toEqual`).
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { RECORDING_OBJECT_ID, mockPlaygroundTranscriptionModel, mockStorageObject } from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { api } from '../../services/api';
import { readMultipartFile } from '../utils/multipart';

function fileList(...files: File[]): FileList {
  const list = { length: files.length, item: (index: number) => files[index] ?? null } as unknown as FileList;
  files.forEach((file, index) => Object.defineProperty(list, index, { value: file, enumerable: true }));
  return list;
}

function capture() {
  const calls: { method: string; path: string; body?: unknown; auth?: string | null }[] = [];
  server.use(
    http.post('*/api/storage/objects', async ({ request }) => {
      const file = await readMultipartFile(request);
      calls.push({ method: 'POST', path: '/api/storage/objects', body: { type: file.type } });
      return HttpResponse.json({ data: mockStorageObject({ id: RECORDING_OBJECT_ID, mimeType: file.type }) }, { status: 201 });
    }),
    http.get('*/api/storage/objects/:id', ({ params }) => {
      calls.push({ method: 'GET', path: `/api/storage/objects/${String(params.id)}` });
      return HttpResponse.json({ data: mockStorageObject({ id: String(params.id), status: 'ready' }) });
    }),
    http.post('*/api/ai/audio/transcriptions', async ({ request }) => {
      calls.push({
        method: 'POST',
        path: '/api/ai/audio/transcriptions',
        body: await request.json(),
        auth: request.headers.get('authorization'),
      });
      return HttpResponse.json({ data: { runId: 'run_transcribe_9', jobId: 'job_9' } }, { status: 202 });
    }),
  );
  return calls;
}

async function renderTranscribe() {
  const user = userEvent.setup();
  render(<AiPlaygroundPage />, { wrapperOptions: { route: '/ai', aiEnabled: true } });
  const modes = await screen.findByRole('group', { name: 'Playground mode' });
  await user.click(within(modes).getByRole('button', { name: 'Transcribe' }));
  const panel = screen.getByTestId('playground-mode-transcribe');
  await waitFor(() => expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent('Whisper'));
  fireEvent.change(within(panel).getByLabelText('Recording'), {
    target: { files: fileList(new File(['a'], 'memo.mp3', { type: 'audio/mpeg' })) },
  });
  return { user, panel };
}

beforeEach(() => {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: [mockPlaygroundTranscriptionModel] })));
  api.setAccessToken('access-token-1');
});

afterEach(() => {
  api.setAccessToken(null);
});

describe('AiPlaygroundPage Transcribe mode — wire', () => {
  it('uploads, waits for ready, then POSTs the storage object id with segment timestamps by default', async () => {
    const calls = capture();
    const { user, panel } = await renderTranscribe();
    await user.click(within(panel).getByRole('button', { name: 'Transcribe' }));

    await waitFor(() => expect(calls.some((c) => c.path === '/api/ai/audio/transcriptions')).toBe(true), {
      timeout: 3000,
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/storage/objects',
      `GET /api/storage/objects/${RECORDING_OBJECT_ID}`,
      'POST /api/ai/audio/transcriptions',
    ]);
    expect(calls[0].body).toEqual({ type: 'audio/mpeg' });
    const post = calls[2];
    expect(post.auth).toBe('Bearer access-token-1');
    expect(post.body).toEqual({
      provider: 'openai',
      model: 'whisper-1',
      storageObjectId: RECORDING_OBJECT_ID,
      timestampGranularities: ['segment'],
    });
  });

  it('sends language and prompt when given, and no timestamps when switched off', async () => {
    const calls = capture();
    const { user, panel } = await renderTranscribe();
    await user.type(within(panel).getByRole('textbox', { name: 'Language' }), 'EN');
    await user.type(within(panel).getByRole('textbox', { name: 'Vocabulary hint' }), 'Pharos, Alexandria');
    await user.click(within(panel).getByRole('switch', { name: 'Timestamps' }));
    await user.click(within(panel).getByRole('button', { name: 'Transcribe' }));

    await waitFor(() => expect(calls.some((c) => c.path === '/api/ai/audio/transcriptions')).toBe(true), {
      timeout: 3000,
    });
    expect(calls.find((c) => c.path === '/api/ai/audio/transcriptions')!.body).toEqual({
      provider: 'openai',
      model: 'whisper-1',
      storageObjectId: RECORDING_OBJECT_ID,
      language: 'en',
      prompt: 'Pharos, Alexandria',
    });
  });
});
