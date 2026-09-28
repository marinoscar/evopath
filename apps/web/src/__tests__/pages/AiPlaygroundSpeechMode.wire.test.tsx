/**
 * `/ai` Speech mode — the WIRE contract (issue #445 against #439).
 *
 * `POST /api/ai/audio/speech` is `.strict()`, so the body is compared with
 * `toEqual`: provider, model, the text as typed, the chosen format and — only
 * when the model lists voices — a voice from that list.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { mockPlaygroundSpeechModel } from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { api } from '../../services/api';
import type { UsableAiModel } from '../../services/ai';

function capture() {
  const bodies: unknown[] = [];
  const auth: (string | null)[] = [];
  server.use(
    http.post('*/api/ai/audio/speech', async ({ request }) => {
      bodies.push(await request.json());
      auth.push(request.headers.get('authorization'));
      return HttpResponse.json({ data: { runId: 'run_speech_9', jobId: 'job_9' } }, { status: 202 });
    }),
  );
  return { bodies, auth };
}

async function renderSpeech(models: UsableAiModel[] = [mockPlaygroundSpeechModel]) {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: models })));
  const user = userEvent.setup();
  render(<AiPlaygroundPage />, { wrapperOptions: { route: '/ai', aiEnabled: true } });
  const panel = await screen.findByTestId('playground-mode-speech');
  await waitFor(() => expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent(/TTS/));
  return { user, panel };
}

beforeEach(() => {
  api.setAccessToken('access-token-1');
});

afterEach(() => {
  api.setAccessToken(null);
});

describe('AiPlaygroundPage Speech mode — wire', () => {
  it("POSTs the text, the model's first voice and mp3 by default", async () => {
    const { bodies, auth } = capture();
    const { user, panel } = await renderSpeech();
    await user.type(within(panel).getByRole('textbox', { name: 'Text to speak' }), '  Hello there  ');
    await user.click(within(panel).getByRole('button', { name: 'Generate speech' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(auth[0]).toBe('Bearer access-token-1');
    expect(bodies[0]).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      input: '  Hello there  ',
      format: 'mp3',
      voice: 'alloy',
    });
  });

  it('sends the chosen voice, format and instructions', async () => {
    const { bodies } = capture();
    const { user, panel } = await renderSpeech();
    await user.click(within(panel).getByRole('combobox', { name: 'Voice' }));
    await user.click(screen.getByRole('option', { name: 'verse' }));
    await user.click(within(panel).getByRole('combobox', { name: 'Format' }));
    await user.click(screen.getByRole('option', { name: 'OPUS' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Style instructions' }), 'Calm');
    await user.type(within(panel).getByRole('textbox', { name: 'Text to speak' }), 'Hi');
    await user.click(within(panel).getByRole('button', { name: 'Generate speech' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      input: 'Hi',
      format: 'opus',
      voice: 'verse',
      instructions: 'Calm',
    });
  });

  it('omits voice for a model that lists none', async () => {
    const { bodies } = capture();
    const { user, panel } = await renderSpeech([
      { ...mockPlaygroundSpeechModel, capabilities: { ...mockPlaygroundSpeechModel.capabilities, voices: [] } },
    ]);
    await user.type(within(panel).getByRole('textbox', { name: 'Text to speak' }), 'Hi');
    await user.click(within(panel).getByRole('button', { name: 'Generate speech' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ provider: 'openai', model: 'gpt-4o-mini-tts', input: 'Hi', format: 'mp3' });
  });
});
