/**
 * `/ai` Chat attachments — the WIRE contract (issue #445 against #441).
 *
 * The streamed turn and the background run both send one user message whose
 * content is the text then an `image`/`file` part per attachment, named by
 * `storageObjectId` (never a URL, never bytes). Compared with `toEqual`: the
 * API's part schemas are `.strict()`.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { mockAiResponse, mockPlaygroundFileModel, mockStorageObject, toSseBody } from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { api } from '../../services/api';
import { readMultipartFile } from '../utils/multipart';

const IMAGE_ID = '66666666-6666-4666-8666-666666666666';
const FILE_ID = '77777777-7777-4777-8777-777777777777';

function fileList(...files: File[]): FileList {
  const list = { length: files.length, item: (index: number) => files[index] ?? null } as unknown as FileList;
  files.forEach((file, index) => Object.defineProperty(list, index, { value: file, enumerable: true }));
  return list;
}

function capture() {
  const bodies: Record<string, unknown[]> = { stream: [], runs: [], uploads: [] };
  server.use(
    http.post('*/api/storage/objects', async ({ request }) => {
      const file = await readMultipartFile(request);
      bodies.uploads.push(file.type);
      const id = file.type.startsWith('image/') ? IMAGE_ID : FILE_ID;
      return HttpResponse.json({ data: mockStorageObject({ id, mimeType: file.type }) }, { status: 201 });
    }),
    http.post('*/api/ai/responses/stream', async ({ request }) => {
      bodies.stream.push(await request.json());
      return new HttpResponse(
        toSseBody([
          { type: 'response.created', id: mockAiResponse.id },
          { type: 'response.completed', response: mockAiResponse },
        ]),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }),
    http.post('*/api/ai/runs', async ({ request }) => {
      bodies.runs.push(await request.json());
      return HttpResponse.json({ data: { runId: 'run_att_1', jobId: 'job_att_1' } }, { status: 202 });
    }),
  );
  return bodies;
}

async function renderChat() {
  const user = userEvent.setup();
  render(<AiPlaygroundPage />, { wrapperOptions: { route: '/ai', aiEnabled: true } });
  const select = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(select).toHaveTextContent('GPT-5'));
  fireEvent.change(screen.getByLabelText('Attach image'), {
    target: { files: fileList(new File(['p'], 'photo.png', { type: 'image/png' })) },
  });
  fireEvent.change(screen.getByLabelText('Attach file'), {
    target: { files: fileList(new File(['d'], 'report.pdf', { type: 'application/pdf' })) },
  });
  return user;
}

const EXPECTED_INPUT = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'text', text: 'Compare them' },
      { type: 'image', storageObjectId: IMAGE_ID },
      { type: 'file', storageObjectId: FILE_ID, filename: 'report.pdf' },
    ],
  },
];

beforeEach(() => {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: [mockPlaygroundFileModel] })));
  api.setAccessToken('access-token-1');
});

afterEach(() => {
  api.setAccessToken(null);
  vi.useRealTimers();
});

describe('AiPlaygroundPage chat attachments — wire', () => {
  it('uploads each file, then streams one user message naming them by storageObjectId', async () => {
    const bodies = capture();
    const user = await renderChat();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Compare them');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(bodies.stream).toHaveLength(1));
    expect(bodies.uploads.sort()).toEqual(['application/pdf', 'image/png']);
    expect(bodies.stream[0]).toEqual({ provider: 'openai', model: 'gpt-5', input: EXPECTED_INPUT });
  });

  it('sends the same content parts on a background run', async () => {
    const bodies = capture();
    const user = await renderChat();

    await user.click(screen.getByRole('switch', { name: 'Run in background' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Compare them');
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => expect(bodies.runs).toHaveLength(1));
    expect(bodies.runs[0]).toEqual({ provider: 'openai', model: 'gpt-5', input: EXPECTED_INPUT });
    expect(bodies.stream).toHaveLength(0);
  });
});
