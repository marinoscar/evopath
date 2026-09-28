/**
 * `/ai` — the Playground's Transcribe mode (issue #445; API #438).
 *
 * Real page, hooks and services; only the network is faked (MSW).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  aiErrorBody,
  mockAiPublicConfigEnabled,
  mockAiTranscriptionRunOutput,
  mockMediaRun,
  mockPlaygroundModels,
  mockPlaygroundTranscriptionModel,
} from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';
import { AI_RUN_POLL_INTERVAL_MS } from '../../hooks/useAiRun';

function fileList(...files: File[]): FileList {
  const list = { length: files.length, item: (index: number) => files[index] ?? null } as unknown as FileList;
  files.forEach((file, index) => Object.defineProperty(list, index, { value: file, enumerable: true }));
  return list;
}

function recording(name = 'memo.m4a', type = 'audio/mp4', size = 64): File {
  const file = new File([new Uint8Array(64)], name, { type });
  if (size !== 64) Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function renderTranscribe() {
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
  const modes = await screen.findByRole('group', { name: 'Playground mode' });
  await user.click(within(modes).getByRole('button', { name: 'Transcribe' }));
  const panel = screen.getByTestId('playground-mode-transcribe');
  await waitFor(() => expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent('Whisper'));
  return { user, panel };
}

function choose(panel: HTMLElement, file: File) {
  fireEvent.change(within(panel).getByLabelText('Recording'), { target: { files: fileList(file) } });
}

async function advancePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AI_RUN_POLL_INTERVAL_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(
    http.get('*/api/ai/models', () =>
      HttpResponse.json({ data: [...mockPlaygroundModels, mockPlaygroundTranscriptionModel] }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AiPlaygroundPage — Transcribe mode', () => {
  it('is disabled when no usable model can transcribe', async () => {
    server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: mockPlaygroundModels })));
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
    expect(await screen.findByRole('button', { name: 'Transcribe' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('refuses a non-audio or oversize file before uploading', async () => {
    const { panel } = await renderTranscribe();
    const submit = within(panel).getByRole('button', { name: 'Transcribe' });
    expect(submit).toBeDisabled();

    choose(panel, recording('notes.pdf', 'application/pdf'));
    expect(within(panel).getByText('Choose an audio file (or an MP4/WebM video)')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    choose(panel, recording('long.mp3', 'audio/mpeg', 25 * 1024 * 1024 + 1));
    expect(within(panel).getByText('Recordings must be 25 MB or smaller')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    choose(panel, recording('clip.webm', 'video/webm'));
    expect(submit).toBeEnabled();
  });

  it('uploads, polls the run and shows the transcript with timestamped segments', async () => {
    const { user, panel } = await renderTranscribe();
    choose(panel, recording());
    await user.click(within(panel).getByRole('button', { name: 'Transcribe' }));

    const card = await within(panel).findByRole('region', { name: 'Transcription run' }, { timeout: 3000 });
    expect(within(card).getByText('memo.m4a')).toBeInTheDocument();
    await advancePoll();
    await waitFor(() => expect(within(card).getByTestId('run-status')).toHaveTextContent('Succeeded'));

    const transcript = within(panel).getByRole('region', { name: 'Transcript' });
    expect(within(transcript).getByTestId('transcript-text')).toHaveTextContent(mockAiTranscriptionRunOutput.text);
    expect(transcript).toHaveTextContent('Language: english');
    expect(transcript).toHaveTextContent('Duration: 1:15');
    const segments = within(transcript).getAllByRole('listitem');
    expect(segments).toHaveLength(2);
    expect(segments[1]).toHaveTextContent('1:04–1:15Today we talk about lighthouses.');
  });

  it('copies the transcript', async () => {
    const { user, panel } = await renderTranscribe();
    // user-event installs its own clipboard on setup; spy on it.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    choose(panel, recording());
    await user.click(within(panel).getByRole('button', { name: 'Transcribe' }));
    await within(panel).findByRole('region', { name: 'Transcription run' }, { timeout: 3000 });
    await advancePoll();

    await user.click(await within(panel).findByRole('button', { name: 'Copy transcript' }));
    expect(writeText).toHaveBeenCalledWith(mockAiTranscriptionRunOutput.text);
    expect(within(panel).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('renders a failed run through the shared copy', async () => {
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) =>
        HttpResponse.json({
          data: { ...mockMediaRun(String(params.id), null, 'failed'), errorCode: 'AI_INVALID_REQUEST', errorMessage: 'Not audio' },
        }),
      ),
    );
    const { user, panel } = await renderTranscribe();
    choose(panel, recording());
    await user.click(within(panel).getByRole('button', { name: 'Transcribe' }));
    await within(panel).findByRole('region', { name: 'Transcription run' }, { timeout: 3000 });
    await advancePoll();

    expect(await within(panel).findByText('The request was invalid')).toBeInTheDocument();
    expect(within(panel).queryByRole('region', { name: 'Transcript' })).not.toBeInTheDocument();
  });

  it('shows a refused start with its AI copy', async () => {
    server.use(
      http.post('*/api/ai/audio/transcriptions', () =>
        HttpResponse.json(aiErrorBody('AI_CAPABILITY_UNSUPPORTED', 'No'), { status: 400 }),
      ),
    );
    const { user, panel } = await renderTranscribe();
    choose(panel, recording());
    await user.click(within(panel).getByRole('button', { name: 'Transcribe' }));
    expect(await within(panel).findByText("This model can't do that", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('validates the language code', async () => {
    const { user, panel } = await renderTranscribe();
    choose(panel, recording());
    await user.type(within(panel).getByRole('textbox', { name: 'Language' }), 'e1');
    expect(within(panel).getByText('A two-letter ISO-639-1 code, such as "en"')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Transcribe' })).toBeDisabled();
  });
});
