/**
 * `/ai` — the Playground's Voice mode (issue #449).
 *
 * Offered only when `GET /ai/config` says `allowRealtime: true`; models are
 * filtered by the `realtime` capability; a call shows a live You/Assistant
 * transcript, mutes, stops and cleans up; every failure has its own copy.
 * The network is MSW; WebRTC and the microphone are `utils/fakeWebRtc.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { aiErrorBody, mockAiPublicConfigEnabled, mockPlaygroundModels } from '../mocks/fixtures/ai';
import AiPlaygroundPage from '../../pages/AiPlaygroundPage';
import { AiConfigContext, type UseAiConfigReturn } from '../../hooks/useAiConfig';
import type { AiPublicConfig, UsableAiModel } from '../../services/ai';
import {
  FAKE_CLIENT_SECRET,
  installFakeWebRtc,
  mediaError,
  mockRealtimeNetwork,
  type FakeWebRtc,
} from '../utils/fakeWebRtc';

const REALTIME_MODEL: UsableAiModel = {
  provider: 'openai',
  modelId: 'gpt-realtime',
  displayName: 'GPT Realtime',
  capabilities: {
    capabilities: ['realtime'],
    inputModalities: ['text', 'audio'],
    outputModalities: ['text', 'audio'],
    voices: ['marin', 'cedar'],
  },
  keySource: 'user',
};

function serveModels(models: UsableAiModel[]) {
  server.use(http.get('*/api/ai/models', () => HttpResponse.json({ data: models })));
}

async function renderPlayground(config: AiPublicConfig) {
  const user = userEvent.setup();
  const aiValue: UseAiConfigReturn = {
    config,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  const view = render(
    <AiConfigContext.Provider value={aiValue}>
      <AiPlaygroundPage />
    </AiConfigContext.Provider>,
    { wrapperOptions: { route: '/ai', aiEnabled: true } },
  );
  const modes = await screen.findByRole('group', { name: 'Playground mode' });
  return { user, modes, view };
}

async function openVoice() {
  const rendered = await renderPlayground({ ...mockAiPublicConfigEnabled, allowRealtime: true });
  await rendered.user.click(within(rendered.modes).getByRole('button', { name: 'Voice' }));
  const panel = screen.getByTestId('playground-mode-voice');
  await waitFor(() =>
    expect(within(panel).getByRole('combobox', { name: 'Model' })).toHaveTextContent('GPT Realtime'),
  );
  return { ...rendered, panel };
}

let rtc: FakeWebRtc;

// Microphone-permission mocking (issue #508). Independent of `fakeWebRtc`'s
// `RTCPeerConnection`/`getUserMedia` stubs — this mocks the Permissions API
// and `window.isSecureContext` that `useMicrophonePermission` reads.
const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions');

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

class FakePermissionStatus {
  state: PermissionState;
  private listeners: Array<() => void> = [];

  constructor(state: PermissionState) {
    this.state = state;
  }

  addEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'change') this.listeners.push(listener);
  });

  removeEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'change') this.listeners = this.listeners.filter((l) => l !== listener);
  });

  /** Simulate the browser flipping the permission and firing `change`. */
  setState(state: PermissionState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

/** Stub `navigator.permissions.query('microphone')` to resolve with a fixed state. */
function setPermissionsApi(options: { state: PermissionState }): FakePermissionStatus {
  const status = new FakePermissionStatus(options.state);
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn(() => Promise.resolve(status)) },
  });
  return status;
}

beforeEach(() => {
  rtc = installFakeWebRtc();
  serveModels([...mockPlaygroundModels, REALTIME_MODEL]);
  // Default: the Permissions API knows nothing yet ("unknown"), matching how
  // most of the existing tests above behaved before this hook existed — they
  // never asserted on the permission panel, so `unknown` (no panel) preserves
  // that behavior for every test that does not opt into a fixed state.
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: undefined });
});

afterEach(() => {
  rtc.restore();
  if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  else delete (window as { isSecureContext?: unknown }).isSecureContext;
  if (originalPermissions) Object.defineProperty(navigator, 'permissions', originalPermissions);
  else delete (navigator as { permissions?: unknown }).permissions;
});

describe('AiPlaygroundPage — Voice mode', () => {
  it('is hidden when realtime sessions are not allowed, even with a realtime model', async () => {
    const { modes } = await renderPlayground({ ...mockAiPublicConfigEnabled, allowRealtime: false });
    expect(within(modes).getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    expect(within(modes).queryByRole('button', { name: 'Voice' })).not.toBeInTheDocument();
  });

  it('is hidden when the API does not report allowRealtime at all', async () => {
    const { modes } = await renderPlayground(mockAiPublicConfigEnabled);
    expect(within(modes).queryByRole('button', { name: 'Voice' })).not.toBeInTheDocument();
  });

  it('is shown when allowed and a realtime model exists, listing only realtime models and their voices', async () => {
    const { user, panel } = await openVoice();

    expect(within(screen.getByRole('group', { name: 'Playground mode' })).getByRole('button', { name: 'Voice' }))
      .toHaveAttribute('aria-pressed', 'true');
    await user.click(within(panel).getByRole('combobox', { name: 'Model' }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining('GPT Realtime')]);
    await user.keyboard('{Escape}');

    expect(within(panel).getByRole('combobox', { name: 'Voice' })).toHaveTextContent('marin');
    expect(within(panel).getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('is offered but disabled, with the reason, when no usable model has realtime', async () => {
    serveModels(mockPlaygroundModels);
    const { user, modes } = await renderPlayground({ ...mockAiPublicConfigEnabled, allowRealtime: true });
    const voice = within(modes).getByRole('button', { name: 'Voice' });
    expect(voice).toHaveAttribute('aria-disabled', 'true');
    await user.hover(voice);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'None of the models available to you can hold a voice conversation',
    );
  });

  it('starts a call, shows both sides of the transcript, and cleans up on Stop', async () => {
    const network = mockRealtimeNetwork();
    const { user, panel } = await openVoice();
    await user.click(within(panel).getByRole('combobox', { name: 'Voice' }));
    await user.click(screen.getByRole('option', { name: 'cedar' }));
    await user.type(within(panel).getByLabelText('Instructions'), 'Be brief.');

    await user.click(within(panel).getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(within(panel).getByTestId('realtime-status')).toHaveTextContent(/^Live · 00:0\d$/));
    expect(network.mints).toEqual([
      { provider: 'openai', model: 'gpt-realtime', voice: 'cedar', instructions: 'Be brief.' },
    ]);

    const channel = rtc.peer().channel!;
    act(() => {
      channel.open();
      channel.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'What time is it?' });
      channel.emit({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: 'It is noon.' });
    });

    const log = within(panel).getByRole('log', { name: 'Voice transcript' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(within(log).getByText('You')).toBeInTheDocument();
    expect(within(log).getByText('What time is it?')).toBeInTheDocument();
    expect(within(log).getByText('Assistant')).toBeInTheDocument();
    expect(within(log).getByText('It is noon.')).toBeInTheDocument();

    // The ephemeral secret is never on screen.
    expect(document.body.textContent).not.toContain(FAKE_CLIENT_SECRET);

    await user.click(within(panel).getByRole('button', { name: 'Mute' }));
    expect(rtc.mic.track.enabled).toBe(false);
    expect(within(panel).getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(panel).getByRole('button', { name: 'Stop' }));
    expect(rtc.peer().close).toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalled();
    expect(rtc.mic.track.stop).toHaveBeenCalled();
    expect(within(panel).getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(within(panel).getByTestId('realtime-status')).toHaveTextContent(/^Ended/);
    // The transcript stays readable after the call.
    expect(within(log).getByText('It is noon.')).toBeInTheDocument();
  });

  it('explains a blocked microphone', async () => {
    rtc.restore();
    rtc = installFakeWebRtc({ getUserMedia: () => Promise.reject(mediaError('NotAllowedError')) });
    const { user, panel } = await openVoice();
    await user.click(within(panel).getByRole('button', { name: 'Start' }));
    expect(await within(panel).findByText('Microphone access was blocked')).toBeInTheDocument();
  });

  it('renders the mint refusal through AiErrorAlert', async () => {
    mockRealtimeNetwork({ mintBody: aiErrorBody('AI_REALTIME_DISABLED', 'Realtime sessions are disabled'), mintStatus: 403 });
    const { user, panel } = await openVoice();
    await user.click(within(panel).getByRole('button', { name: 'Start' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveAttribute('data-ai-error-code', 'AI_REALTIME_DISABLED');
    expect(alert).toHaveTextContent('Voice sessions are turned off by your administrator.');
  });

  it('reports a dropped connection', async () => {
    mockRealtimeNetwork();
    const { user, panel } = await openVoice();
    await user.click(within(panel).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(within(panel).getByTestId('realtime-status')).toHaveTextContent(/^Live/));
    act(() => rtc.peer().setConnectionState('disconnected'));
    expect(await within(panel).findByText('The connection was lost')).toBeInTheDocument();
    expect(rtc.mic.track.stop).toHaveBeenCalled();
  });

  it('ends the call when the page unmounts', async () => {
    mockRealtimeNetwork();
    const { user, panel, view } = await openVoice();
    await user.click(within(panel).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(within(panel).getByTestId('realtime-status')).toHaveTextContent(/^Live/));
    view.unmount();
    expect(rtc.peer().close).toHaveBeenCalled();
    expect(rtc.mic.track.stop).toHaveBeenCalled();
  });

  /** The permission panel/alert, matched by its `data-mic-permission` attribute only. */
  function micPanel(container: HTMLElement, state: 'prompt' | 'denied' | 'insecure'): HTMLElement | null {
    return container.querySelector(`[data-mic-permission="${state}"]`);
  }

  /** The unblock-steps element, matched by its `data-mic-steps` attribute only. */
  function micSteps(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-mic-steps]');
  }

  describe('microphone permission panel (issue #508)', () => {
    it('shows the prompt panel, and clicking Allow microphone calls getUserMedia', async () => {
      setPermissionsApi({ state: 'prompt' });
      const { user, panel } = await openVoice();

      await waitFor(() => expect(micPanel(panel, 'prompt')).toBeInTheDocument());
      expect(within(panel).getByText('Microphone access needed')).toBeInTheDocument();

      const allowButton = within(panel).getByRole('button', { name: 'Allow microphone' });
      await user.click(allowButton);

      await waitFor(() => expect(rtc.getUserMedia).toHaveBeenCalledWith({ audio: true }));
    });

    it('shows the denied panel with the platform steps, and disables Start', async () => {
      setPermissionsApi({ state: 'denied' });
      const { panel } = await openVoice();

      await waitFor(() => expect(micPanel(panel, 'denied')).toBeInTheDocument());
      const steps = micSteps(panel);
      expect(steps).toHaveAttribute('data-mic-steps', 'desktop');
      expect(steps).toHaveTextContent('site-settings icon');
      expect(within(panel).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Start' })).toBeDisabled();
    });

    it('shows the insecure panel and disables Start', async () => {
      setSecureContext(false);
      const { panel } = await openVoice();

      expect(micPanel(panel, 'insecure')).toBeInTheDocument();
      expect(within(panel).getByText('Microphone requires a secure connection')).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Start' })).toBeDisabled();
    });

    it('shows no permission panel when granted', async () => {
      setPermissionsApi({ state: 'granted' });
      const { panel } = await openVoice();

      await waitFor(() => expect(within(panel).getByRole('button', { name: 'Start' })).toBeEnabled());
      expect(micPanel(panel, 'prompt')).not.toBeInTheDocument();
      expect(micPanel(panel, 'denied')).not.toBeInTheDocument();
      expect(micPanel(panel, 'insecure')).not.toBeInTheDocument();
    });

    it('shows one alert (no duplicate panel) with steps on a mic-denied Start failure, and clears it once permission becomes granted', async () => {
      rtc.restore();
      rtc = installFakeWebRtc({ getUserMedia: () => Promise.reject(mediaError('NotAllowedError')) });
      const status = setPermissionsApi({ state: 'prompt' });
      const { user, panel } = await openVoice();

      await user.click(within(panel).getByRole('button', { name: 'Start' }));

      const failureAlert = await within(panel).findByText('Microphone access was blocked');
      expect(failureAlert).toBeInTheDocument();
      // Exactly one alert with steps - the permission panel must be
      // suppressed while the mic-denied failure alert already says the same
      // thing, and there must be only one `data-mic-steps` element on screen.
      expect(micPanel(panel, 'prompt')).not.toBeInTheDocument();
      expect(micPanel(panel, 'denied')).not.toBeInTheDocument();
      expect(within(panel).getAllByRole('alert')).toHaveLength(1);
      const steps = micSteps(panel);
      expect(steps).toHaveAttribute('data-mic-steps', 'desktop');
      expect(steps).toHaveTextContent('site-settings icon');

      // The permission changes (e.g. the user allowed it in site settings and
      // came back) - the hook's `change` listener flips it to granted, which
      // must clear the stale failure alert.
      status.setState('granted');

      await waitFor(() =>
        expect(within(panel).queryByText('Microphone access was blocked')).not.toBeInTheDocument(),
      );
      expect(micSteps(panel)).not.toBeInTheDocument();
    });
  });
});
