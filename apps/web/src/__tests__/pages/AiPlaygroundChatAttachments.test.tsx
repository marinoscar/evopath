/**
 * `/ai` Chat — file and image attachments (issue #445; API #441).
 *
 * The attach buttons follow the selected model's capabilities AND input
 * modalities; chosen files are chips that can be removed; oversize or
 * unreadable files block sending; sent attachments show on the user message;
 * and every failure (upload, 404/403 on the stored input, AI codes) reads as
 * something a user can act on. Only the network is faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  aiErrorBody,
  mockAiPublicConfigEnabled,
  mockPlaygroundChatModel,
  mockPlaygroundFileModel,
  mockPlaygroundReasoningModel,
} from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';

const MODELS = [mockPlaygroundFileModel, mockPlaygroundReasoningModel, mockPlaygroundChatModel];

function fileOf(name: string, type: string, size = 64): File {
  const file = new File([new Uint8Array(Math.min(size, 64))], name, { type });
  if (size > 64) Object.defineProperty(file, 'size', { value: size });
  return file;
}

function fileList(...files: File[]): FileList {
  const list = { length: files.length, item: (index: number) => files[index] ?? null } as unknown as FileList;
  files.forEach((file, index) => Object.defineProperty(list, index, { value: file, enumerable: true }));
  return list;
}

async function renderChat(label = 'GPT-5') {
  const user = userEvent.setup();
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
  const select = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(select).toHaveTextContent(label));
  return user;
}

async function pickModel(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Model' }));
  await user.click(screen.getByRole('option', { name: new RegExp(`^${name}`) }));
}

function attach(label: 'Attach image' | 'Attach file', ...files: File[]) {
  fireEvent.change(screen.getByLabelText(label), { target: { files: fileList(...files) } });
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), text);
  await user.click(screen.getByRole('button', { name: /^(Send|Start run)$/ }));
}

beforeEach(() => {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: MODELS })));
});

describe('AiPlaygroundPage — chat attachments', () => {
  it('offers only the attachments the selected model can read', async () => {
    const user = await renderChat();
    expect(screen.getByLabelText('Attach image')).toBeInTheDocument();
    expect(screen.getByLabelText('Attach file')).toBeInTheDocument();

    await pickModel(user, 'GPT-5 mini'); // vision_input only
    expect(screen.getByLabelText('Attach image')).toBeInTheDocument();
    expect(screen.queryByLabelText('Attach file')).not.toBeInTheDocument();

    await pickModel(user, 'GPT-4.1 mini'); // neither
    expect(screen.queryByLabelText('Attach image')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Attach file')).not.toBeInTheDocument();
  });

  it('lists chosen files as removable chips', async () => {
    const user = await renderChat();
    attach('Attach image', fileOf('photo.png', 'image/png'));
    attach('Attach file', fileOf('report.pdf', 'application/pdf'));

    const chips = screen.getByRole('list', { name: 'Attachments to send' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(2);
    expect(within(chips).getByText(/photo\.png/)).toBeInTheDocument();

    await user.click(within(chips).getByRole('button', { name: 'Remove photo.png' }));
    expect(within(screen.getByRole('list', { name: 'Attachments to send' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText(/photo\.png/)).not.toBeInTheDocument();
  });

  it('blocks an oversize image or file before anything is uploaded', async () => {
    let uploads = 0;
    server.use(http.post('*/api/storage/objects', () => {
      uploads += 1;
      return HttpResponse.json({ data: {} }, { status: 201 });
    }));
    const user = await renderChat();

    attach('Attach image', fileOf('huge.png', 'image/png', 20 * 1024 * 1024 + 1));
    attach('Attach file', fileOf('huge.pdf', 'application/pdf', 50 * 1024 * 1024 + 1));
    const problems = screen.getByRole('alert');
    expect(problems).toHaveTextContent('huge.png: Images must be 20.0 MB or smaller');
    expect(problems).toHaveTextContent('huge.pdf: Files must be 50.0 MB or smaller');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(uploads).toBe(0);
  });

  it('flags an attachment the newly selected model cannot read', async () => {
    const user = await renderChat();
    attach('Attach file', fileOf('report.pdf', 'application/pdf'));
    await pickModel(user, 'GPT-5 mini');

    expect(screen.getByRole('alert')).toHaveTextContent("report.pdf: This model can't read files");
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'summarise');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('uploads, sends and shows the attachments on the sent message', async () => {
    const user = await renderChat();
    attach('Attach image', fileOf('photo.png', 'image/png'));
    await send(user, 'What is in this picture?');

    const sent = await screen.findByTestId('user-message');
    expect(sent).toHaveTextContent('What is in this picture?');
    expect(within(sent).getByRole('list', { name: 'Attached files' })).toHaveTextContent('photo.png');
    expect(await screen.findByText('Hello! How can I help?')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Attachments to send' })).not.toBeInTheDocument();
  });

  it('keeps the prompt and chips when the upload fails for lack of storage', async () => {
    server.use(
      http.post('*/api/storage/objects', () =>
        HttpResponse.json(
          { code: 'SERVICE_UNAVAILABLE', message: 'Storage is not configured', details: { reason: 'storage_not_configured' } },
          { status: 503 },
        ),
      ),
    );
    const user = await renderChat();
    attach('Attach file', fileOf('report.pdf', 'application/pdf'));
    await send(user, 'Summarise');

    expect(await screen.findByText("File storage isn't available")).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Summarise');
    expect(screen.getByRole('list', { name: 'Attachments to send' })).toHaveTextContent('report.pdf');
    expect(screen.queryByTestId('user-message')).not.toBeInTheDocument();
  });

  it('explains a 404 on an attached file', async () => {
    server.use(
      http.post('*/api/ai/responses/stream', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'Storage object not found' }, { status: 404 }),
      ),
    );
    const user = await renderChat();
    attach('Attach file', fileOf('report.pdf', 'application/pdf'));
    await send(user, 'Summarise');

    expect(await screen.findByText(/An attached file could not be found/)).toBeInTheDocument();
  });

  it('explains a 403 on an attached file', async () => {
    server.use(
      http.post('*/api/ai/responses/stream', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'Forbidden' }, { status: 403 }),
      ),
    );
    const user = await renderChat();
    attach('Attach file', fileOf('report.pdf', 'application/pdf'));
    await send(user, 'Summarise');

    expect(await screen.findByText('You do not have access to one of the attached files.')).toBeInTheDocument();
  });

  it.each([
    ['AI_CAPABILITY_UNSUPPORTED', "This model can't do that"],
    ['AI_INVALID_REQUEST', 'The request was invalid'],
    ['AI_STORAGE_UNAVAILABLE', "File storage isn't available"],
  ])('renders %s from the API with its shared copy', async (reason, title) => {
    server.use(
      http.post('*/api/ai/responses/stream', () =>
        HttpResponse.json(aiErrorBody(reason, 'Refused'), { status: reason === 'AI_STORAGE_UNAVAILABLE' ? 503 : 400 }),
      ),
    );
    const user = await renderChat();
    attach('Attach image', fileOf('photo.png', 'image/png'));
    await send(user, 'Describe');

    expect(await screen.findByText(title)).toBeInTheDocument();
  });
});
