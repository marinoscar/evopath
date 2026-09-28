/**
 * `/ai` — the Playground's Speech mode (issue #445; API #439).
 *
 * Voices come from the model's capabilities; the text has a 4096-character
 * counter; the result plays in a labelled player that always discloses the
 * audio is AI-generated. Only the network is faked.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  SPEECH_OBJECT_ID,
  aiErrorBody,
  mockAiPublicConfigEnabled,
  mockMediaRun,
  mockPlaygroundModels,
  mockPlaygroundSpeechModel,
  mockSignedUrl,
} from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';
import { AI_RUN_POLL_INTERVAL_MS } from '../../hooks/useAiRun';
import type { UsableAiModel } from '../../services/ai';

const NO_VOICES_MODEL: UsableAiModel = {
  ...mockPlaygroundSpeechModel,
  modelId: 'tts-plain',
  displayName: 'Plain TTS',
  capabilities: { ...mockPlaygroundSpeechModel.capabilities, voices: undefined },
};

async function renderSpeech() {
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
  await user.click(within(modes).getByRole('button', { name: 'Speech' }));
  const panel = screen.getByTestId('playground-mode-speech');
  await waitFor(() =>
    expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent('GPT-4o mini TTS'),
  );
  return { user, panel };
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
      HttpResponse.json({ data: [...mockPlaygroundModels, mockPlaygroundSpeechModel, NO_VOICES_MODEL] }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AiPlaygroundPage — Speech mode', () => {
  it("offers the selected model's own voices, and none for a model that lists none", async () => {
    const { user, panel } = await renderSpeech();
    const voice = within(panel).getByRole('combobox', { name: 'Voice' });
    expect(voice).toHaveTextContent('alloy');
    await user.click(voice);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['alloy', 'coral', 'verse']);
    await user.keyboard('{Escape}');

    await user.click(within(panel).getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: /Plain TTS/ }));
    expect(within(panel).queryByRole('combobox', { name: 'Voice' })).not.toBeInTheDocument();
  });

  it('counts characters and blocks text over 4096', async () => {
    const { user, panel } = await renderSpeech();
    const textbox = within(panel).getByRole('textbox', { name: 'Text to speak' });
    await user.type(textbox, 'Hello there');
    expect(within(panel).getByText('11 / 4,096 characters')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Generate speech' })).toBeEnabled();

    fireEvent.change(textbox, { target: { value: 'x'.repeat(4097) } });
    expect(within(panel).getByText(/4,097 \/ 4,096 characters — shorten the text/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Generate speech' })).toBeDisabled();
  });

  it('polls the run and plays the audio, labelled as AI-generated, with a download link', async () => {
    const { user, panel } = await renderSpeech();
    await user.type(within(panel).getByRole('textbox', { name: 'Text to speak' }), 'Hello there');
    await user.click(within(panel).getByRole('button', { name: 'Generate speech' }));

    const card = await within(panel).findByRole('region', { name: 'Speech run' });
    await advancePoll();
    await waitFor(() => expect(within(card).getByTestId('run-status')).toHaveTextContent('Succeeded'));

    const figure = within(panel).getByRole('figure', { name: 'Generated speech' });
    expect(within(figure).getByText('AI-generated audio')).toBeVisible();
    const audio = await waitFor(() => {
      const element = figure.querySelector('audio');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('src', mockSignedUrl(SPEECH_OBJECT_ID));
    expect(audio).toHaveAccessibleName('AI-generated audio, voice coral');
    expect(within(figure).getByRole('link', { name: 'Download audio' })).toHaveAttribute(
      'href',
      mockSignedUrl(SPEECH_OBJECT_ID),
    );
  });

  it('renders a failed run through the shared copy', async () => {
    server.use(
      http.get('*/api/ai/runs/:id', ({ params }) =>
        HttpResponse.json({
          data: { ...mockMediaRun(String(params.id), null, 'failed'), errorCode: 'AI_STORAGE_UNAVAILABLE', errorMessage: 'x' },
        }),
      ),
    );
    const { user, panel } = await renderSpeech();
    await user.type(within(panel).getByRole('textbox', { name: 'Text to speak' }), 'Hi');
    await user.click(within(panel).getByRole('button', { name: 'Generate speech' }));
    await within(panel).findByRole('region', { name: 'Speech run' });
    await advancePoll();

    expect(await within(panel).findByText("File storage isn't available")).toBeInTheDocument();
    expect(within(panel).queryByRole('figure', { name: 'Generated speech' })).not.toBeInTheDocument();
  });

  it('shows a refused start (an unknown voice) with its AI copy', async () => {
    server.use(
      http.post('*/api/ai/audio/speech', () =>
        HttpResponse.json(aiErrorBody('AI_INVALID_REQUEST', 'This model does not speak in that voice'), { status: 400 }),
      ),
    );
    const { user, panel } = await renderSpeech();
    await user.type(within(panel).getByRole('textbox', { name: 'Text to speak' }), 'Hi');
    await user.click(within(panel).getByRole('button', { name: 'Generate speech' }));
    expect(await within(panel).findByText('This model does not speak in that voice')).toBeInTheDocument();
  });
});
