/**
 * `/settings/coach` (E7.3, #243): the persona gallery, intensity, the 18+
 * adult-language flow, spoken messages, the schedule and "your why", and the
 * hub card's gating. Real hooks, MSW for the network.
 */
import { describe, it, expect } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import UserCoachSettingsPage, {
  AUDIO_POLICY_OFF_MESSAGE,
  COACH_POLICY_OFF_MESSAGE,
  NO_VOICES_MESSAGE,
} from '../../pages/UserCoachSettingsPage';
import UserSettingsHubPage from '../../pages/UserSettingsHubPage';
import {
  UNCENSORED_SARGE_LINE,
  mockCoachPersonas,
  mockCoachSettingsView,
} from '../mocks/fixtures/coach';
import { mockUsableAiModels } from '../mocks/fixtures/ai';
import { PROFANITY_REASON_TEXT, type CoachSettingsPut, type CoachSettingsView } from '../../services/coach';
import { VOICE_PREVIEW_SOON } from '../../components/coach/CoachVoicePreviewButton';

const API = '*/api';

function serveView(view: CoachSettingsView) {
  server.use(http.get(`${API}/coach/settings`, () => HttpResponse.json({ data: view })));
}

/** Captures every PUT; answers `respond(body)` (default: the view with the body merged into settings). */
function capturePut(respond?: (body: CoachSettingsPut) => Response) {
  const calls: CoachSettingsPut[] = [];
  server.use(
    http.put(`${API}/coach/settings`, async ({ request }) => {
      const body = (await request.json()) as CoachSettingsPut;
      calls.push(body);
      if (respond) return respond(body);
      const base = mockCoachSettingsView();
      const { confirmAdult, audio, quietHours, ...rest } = body;
      return HttpResponse.json({
        data: mockCoachSettingsView({
          settings: {
            ...(rest as Partial<CoachSettingsView['settings']>),
            ...(confirmAdult ? { adultConfirmedAt: '2026-10-01T00:00:00.000Z' } : {}),
            audio: { ...base.settings.audio, ...(audio as object) },
            quietHours: { ...base.settings.quietHours, ...(quietHours as object) },
          },
          effective: {
            maxNudgesPerDay: (rest.maxNudgesPerDay as number | undefined) ?? 2,
            register: body.profanity ? { profane: true, reason: null } : { profane: false, reason: 'toggle_off' },
          },
        }),
      });
    }),
  );
  return calls;
}

function serveVoices(voices: string[]) {
  server.use(
    http.get(`${API}/ai/models`, () =>
      HttpResponse.json({
        data: [{ ...mockUsableAiModels[0], capabilities: { ...mockUsableAiModels[0].capabilities, voices } }],
      }),
    ),
  );
}

async function renderPage() {
  const user = userEvent.setup();
  const result = render(<UserCoachSettingsPage />, { wrapperOptions: { aiEnabled: true } });
  await screen.findByRole('heading', { level: 1, name: 'Coach' });
  await waitFor(() => expect(screen.queryByLabelText('Loading your coach settings')).not.toBeInTheDocument());
  return { user, ...result };
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });

describe('UserCoachSettingsPage', () => {
  it('renders the persona gallery with names, taglines and the active persona marked', async () => {
    await renderPage();
    for (const name of ['Coach', 'Sarge', 'The Stoic']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    const coach = screen.getByRole('region', { name: 'Coach' });
    expect(within(coach).getByText('Warm, specific, celebrates small wins.')).toBeInTheDocument();
    expect(within(coach).getByText('Active')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Sarge' })).queryByText('Active')).not.toBeInTheDocument();
    expect(screen.getByText(/written by AI/)).toBeInTheDocument();
  });

  it('expands sample lines per moment, with placeholders filled in', async () => {
    const { user } = await renderPage();
    const stoic = screen.getByRole('region', { name: 'The Stoic' });
    await user.click(within(stoic).getByRole('button', { name: /Sample lines/ }));
    expect(within(stoic).getByText('Streak at risk')).toBeInTheDocument();
    expect(within(stoic).getAllByText('The session is gone. The next hour is still yours.').length).toBeGreaterThan(0);

    const coach = screen.getByRole('region', { name: 'Coach' });
    await user.click(within(coach).getByRole('button', { name: /Sample lines/ }));
    expect(within(coach).getAllByText("You're one session from a 4-week streak.").length).toBeGreaterThan(0);
  });

  it('selecting a persona and saving sends only personaId', async () => {
    const calls = capturePut();
    const { user } = await renderPage();
    expect(saveButton()).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Choose The Stoic' }));
    expect(screen.getByRole('button', { name: 'The Stoic selected' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(saveButton());

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ personaId: 'stoic' });
    await screen.findByText('Coach settings saved');
    expect(within(screen.getByRole('region', { name: 'The Stoic' })).getByText('Active')).toBeInTheDocument();
  });

  it('changes intensity with the slider and saves it', async () => {
    const calls = capturePut();
    const { user } = await renderPage();
    const slider = screen.getByRole('slider', { name: 'Intensity' });
    expect(slider).toHaveAttribute('aria-valuetext', '2, Steady');
    fireEvent.change(slider, { target: { value: 3 } });
    expect(screen.getByText(/Level 3: Firm/)).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ intensity: 3 });
  });

  describe('adult language', () => {
    function sargeL3(overrides: Parameters<typeof mockCoachSettingsView>[0] = {}) {
      return mockCoachSettingsView({
        ...overrides,
        settings: { personaId: 'drill_sergeant', intensity: 3, ...overrides.settings },
        effective: { intensity: 2, voice: 'onyx', ...overrides.effective },
      });
    }

    it('shows Unhinged locked with the register reason and never renders uncensored lines', async () => {
      serveView(sargeL3({ effective: { register: { profane: false, reason: 'age_unverified' } } }));
      const { user } = await renderPage();
      const sarge = screen.getByRole('region', { name: 'Sarge' });
      expect(within(sarge).getByText(/Unhinged · 18\+ · locked/)).toBeInTheDocument();
      expect(within(sarge).getByTestId('persona-drill_sergeant-lock-reason')).toHaveTextContent(
        PROFANITY_REASON_TEXT.age_unverified,
      );
      await user.click(within(sarge).getByRole('button', { name: /Sample lines/ }));
      expect(within(sarge).getByText(/Adult lines are hidden/)).toBeInTheDocument();
      expect(screen.queryByText(UNCENSORED_SARGE_LINE)).not.toBeInTheDocument();
    });

    it('confirming the 18+ dialog sends confirmAdult and turns the switch on', async () => {
      serveView(sargeL3());
      const calls = capturePut();
      const { user } = await renderPage();
      const toggle = screen.getByRole('switch', { name: 'Adult language (18+)' });
      expect(toggle).not.toBeChecked();

      await user.click(toggle);
      const dialog = await screen.findByRole('dialog', { name: 'Turn on adult language?' });
      const confirm = within(dialog).getByRole('button', { name: 'Turn on adult language' });
      expect(confirm).toBeDisabled();
      expect(within(dialog).getByRole('checkbox', { name: 'I confirm I am 18 or older' })).not.toBeChecked();
      await user.click(within(dialog).getByRole('checkbox', { name: 'I confirm I am 18 or older' }));
      await user.click(confirm);

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ profanity: true, confirmAdult: true, personaId: 'drill_sergeant', intensity: 3 });
      expect(calls[0]).not.toHaveProperty('adultConfirmedAt');
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Adult language (18+)' })).toBeChecked());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('cancelling the dialog sends nothing and leaves the switch off', async () => {
      serveView(sargeL3());
      const calls = capturePut();
      const { user } = await renderPage();
      await user.click(screen.getByRole('switch', { name: 'Adult language (18+)' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('switch', { name: 'Adult language (18+)' })).not.toBeChecked();
      expect(calls).toHaveLength(0);
    });

    it('maps 403 COACH_PROFANITY_LOCKED: reverts the switch and names the failed condition', async () => {
      serveView(sargeL3());
      capturePut(() =>
        HttpResponse.json(
          {
            code: 'FORBIDDEN',
            message: 'Adult language cannot be turned on: an unlock condition is not met.',
            details: { code: 'COACH_PROFANITY_LOCKED', reason: 'system_disabled' },
          },
          { status: 403 },
        ),
      );
      const { user } = await renderPage();
      await user.click(screen.getByRole('switch', { name: 'Adult language (18+)' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('checkbox'));
      await user.click(within(dialog).getByRole('button', { name: 'Turn on adult language' }));

      const alert = await screen.findByText('Adult language was not turned on');
      expect(alert.closest('[role="alert"]')).toHaveTextContent(PROFANITY_REASON_TEXT.system_disabled);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('switch', { name: 'Adult language (18+)' })).not.toBeChecked();
    });

    it('keeps the switch locked with the underage reason and opens no dialog', async () => {
      serveView(sargeL3({ effective: { register: { profane: false, reason: 'underage' } } }));
      await renderPage();
      const toggle = screen.getByRole('switch', { name: 'Adult language (18+)' });
      expect(toggle).toBeDisabled();
      expect(screen.getByTestId('profanity-status')).toHaveTextContent(PROFANITY_REASON_TEXT.underage);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('hides the switch when the deployment does not allow profane personas', async () => {
      serveView(
        sargeL3({
          policy: { allowProfanePersonas: false },
          effective: { register: { profane: false, reason: 'system_disabled' } },
        }),
      );
      await renderPage();
      expect(screen.queryByRole('switch', { name: 'Adult language (18+)' })).not.toBeInTheDocument();
      expect(screen.getByTestId('profanity-policy-off')).toHaveTextContent(PROFANITY_REASON_TEXT.system_disabled);
    });

    it('is not offered for a persona without a profane level', async () => {
      await renderPage();
      expect(screen.queryByRole('region', { name: 'Adult language' })).not.toBeInTheDocument();
    });

    it('renders uncensored lines only when the server serves them', async () => {
      serveView(sargeL3({ settings: { profanity: true }, effective: { register: { profane: true, reason: null }, intensity: 3 } }));
      server.use(http.get(`${API}/coach/personas`, () => HttpResponse.json({ data: mockCoachPersonas(false) })));
      const { user } = await renderPage();
      const sarge = screen.getByRole('region', { name: 'Sarge' });
      await user.click(within(sarge).getByRole('button', { name: /Sample lines/ }));
      expect(within(sarge).getAllByText(UNCENSORED_SARGE_LINE).length).toBeGreaterThan(0);
      expect(screen.getByRole('switch', { name: 'Adult language (18+)' })).toBeChecked();
    });
  });

  describe('spoken messages', () => {
    it('is off by default: voice, speed and preview disabled until the switch is on', async () => {
      serveVoices(['alloy', 'coral', 'onyx']);
      const calls = capturePut();
      const { user } = await renderPage();
      const audio = screen.getByRole('region', { name: 'Spoken messages' });
      const toggle = within(audio).getByRole('switch', { name: 'Speak my coach messages' });
      expect(toggle).not.toBeChecked();
      expect(within(audio).getByRole('combobox', { name: 'Voice' })).toHaveAttribute('aria-disabled', 'true');
      expect(within(audio).getByRole('slider')).toBeDisabled();
      expect(within(audio).getByRole('button', { name: 'Hear it' })).toBeDisabled();

      await user.click(toggle);
      const voice = within(audio).getByRole('combobox', { name: 'Voice' });
      expect(voice).not.toHaveAttribute('aria-disabled', 'true');
      expect(within(audio).getByRole('slider')).not.toBeDisabled();

      await user.click(voice);
      const listbox = await screen.findByRole('listbox');
      expect(within(listbox).getByRole('option', { name: 'Persona default (coral)' })).toBeInTheDocument();
      await user.click(within(listbox).getByRole('option', { name: 'onyx' }));
      await user.click(saveButton());
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toEqual({ audio: { enabled: true, voice: 'onyx' } });
    });

    it('enables "Hear it" once audio is on and previews the draft persona, intensity, voice and speed (E7.6)', async () => {
      serveVoices(['alloy']);
      serveView(mockCoachSettingsView({ settings: { audio: { enabled: true, voice: 'alloy', speed: 1.25 } } }));
      const bodies: unknown[] = [];
      server.use(
        http.post(`${API}/coach/voice-preview`, async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json(
            {
              data: {
                runId: 'run_speech_page_preview',
                jobId: 'job-page-preview',
                personaId: 'coach',
                intensity: 2,
                moment: 'streak_at_risk',
                voice: 'alloy',
                censored: false,
              },
            },
            { status: 202 },
          );
        }),
      );
      const { user } = await renderPage();
      const audio = screen.getByRole('region', { name: 'Spoken messages' });
      const hear = within(audio).getByRole('button', { name: 'Hear it' });
      expect(hear).toBeEnabled();
      expect(within(audio).queryByText(VOICE_PREVIEW_SOON)).not.toBeInTheDocument();

      await user.click(hear);
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({ personaId: 'coach', intensity: 2, voice: 'alloy', speed: 1.25, moment: 'streak_at_risk' });
    });

    it('asks the user to contact an admin when the voice model lists no voices', async () => {
      serveVoices([]);
      await renderPage();
      expect(await screen.findByText(NO_VOICES_MESSAGE)).toBeInTheDocument();
    });

    it('is disabled with an explanation when the deployment disallows audio', async () => {
      serveView(mockCoachSettingsView({ policy: { allowAudio: false } }));
      await renderPage();
      const audio = screen.getByRole('region', { name: 'Spoken messages' });
      expect(within(audio).getByTestId('audio-policy-off')).toHaveTextContent(AUDIO_POLICY_OFF_MESSAGE);
      expect(within(audio).getByRole('switch', { name: 'Speak my coach messages' })).toBeDisabled();
      expect(within(audio).getByRole('button', { name: 'Hear it' })).toBeDisabled();
    });
  });

  describe('schedule', () => {
    it('accepts overnight quiet hours and labels them', async () => {
      const calls = capturePut();
      const { user } = await renderPage();
      expect(screen.getByTestId('quiet-hours-overnight')).toHaveTextContent('Overnight');

      fireEvent.change(screen.getByLabelText('Quiet from'), { target: { value: '22:00' } });
      fireEvent.change(screen.getByLabelText('Quiet until'), { target: { value: '06:45' } });
      expect(screen.getByTestId('quiet-hours-overnight')).toBeInTheDocument();
      await user.click(saveButton());
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toEqual({ quietHours: { start: '22:00', end: '06:45' } });
    });

    it('rejects an invalid time inline and blocks saving', async () => {
      const calls = capturePut();
      await renderPage();
      fireEvent.change(screen.getByLabelText('Quiet from'), { target: { value: '' } });
      expect(screen.getByText(/Enter a time as HH:mm/)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
      expect(calls).toHaveLength(0);
    });

    it('caps nudges per day at the ceiling and says why', async () => {
      serveView(
        mockCoachSettingsView({
          settings: { maxNudgesPerDay: 4 },
          effective: { maxNudgesPerDay: 2 },
          policy: { maxNudgesPerDayCeiling: 2 },
        }),
      );
      const { user } = await renderPage();
      const select = screen.getByRole('combobox', { name: 'Nudges per day, at most' });
      expect(select).toHaveTextContent('2');
      expect(screen.getByText(/You chose 4, but your administrator allows at most 2 a day/)).toBeInTheDocument();
      await user.click(select);
      const options = within(await screen.findByRole('listbox')).getAllByRole('option');
      expect(options.map((option) => option.textContent)).toEqual(['1', '2']);
      // Showing the clamped value is not an unsaved change.
      await user.keyboard('{Escape}');
      expect(saveButton()).toBeDisabled();
    });

    it('saves lock-screen-safe, photo cadence and the why as text', async () => {
      const calls = capturePut();
      const { user } = await renderPage();
      await user.click(screen.getByRole('switch', { name: 'Lock-screen safe notifications' }));
      await user.click(screen.getByRole('combobox', { name: 'Progress photo reminders' }));
      await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Every month' }));
      await user.type(screen.getByRole('textbox', { name: 'Your why' }), '<b>For my kids</b>');
      await user.click(saveButton());
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toEqual({ lockScreenSafe: false, photoCadence: 'monthly', why: '<b>For my kids</b>' });
    });

    it('rejects a why over 200 characters', async () => {
      await renderPage();
      fireEvent.change(screen.getByRole('textbox', { name: 'Your why' }), { target: { value: 'x'.repeat(201) } });
      expect(screen.getByText(/Keep it to 200 characters/)).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
    });
  });

  it('keeps the draft and offers a retry on a server error', async () => {
    let attempts = 0;
    const calls = capturePut((body) => {
      attempts += 1;
      if (attempts === 1) return HttpResponse.json({ message: 'boom' }, { status: 500 });
      return HttpResponse.json({ data: mockCoachSettingsView({ settings: { personaId: body.personaId as string } }) });
    });
    const { user } = await renderPage();
    await user.click(screen.getByRole('button', { name: 'Choose The Stoic' }));
    await user.click(saveButton());
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'The Stoic selected' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    await screen.findByText('Coach settings saved');
  });

  it('maps COACH_AUDIO_DISABLED on save and puts the switch back', async () => {
    serveVoices(['alloy']);
    capturePut(() =>
      HttpResponse.json(
        { code: 'FORBIDDEN', message: 'x', details: { code: 'COACH_AUDIO_DISABLED', reason: 'COACH_AUDIO_DISABLED' } },
        { status: 403 },
      ),
    );
    const { user } = await renderPage();
    await user.click(screen.getByRole('switch', { name: 'Speak my coach messages' }));
    await user.click(saveButton());
    expect(await screen.findByText('Spoken coach messages are switched off for this deployment.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Speak my coach messages' })).not.toBeChecked();
  });

  it('explains when the deployment has the coach switched off', async () => {
    serveView(mockCoachSettingsView({ settings: { enabled: false }, policy: { enabled: false } }));
    await renderPage();
    expect(screen.getByText(COACH_POLICY_OFF_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Let the coach message me' })).toBeDisabled();
  });

  it('shows a load error with a retry', async () => {
    server.use(http.get(`${API}/coach/settings`, () => HttpResponse.json({ message: 'down' }, { status: 500 })));
    render(<UserCoachSettingsPage />, { wrapperOptions: { aiEnabled: true } });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('fits a phone-width window without a horizontal layout', async () => {
    act(() => setViewportWidth(375));
    await renderPage();
    expect(screen.getByRole('region', { name: 'Persona' })).toBeInTheDocument();
    act(() => setViewportWidth(1440));
  });

  it('has no axe violations', async () => {
    const { container } = await renderPage();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

describe('the Coach card on /settings', () => {
  it('appears when AI is on and the user holds ai:use', async () => {
    render(<UserSettingsHubPage />, { wrapperOptions: { aiEnabled: true } });
    expect(await screen.findByText('Coach')).toBeInTheDocument();
  });

  it('is hidden while AI is off', async () => {
    render(<UserSettingsHubPage />, { wrapperOptions: { aiEnabled: false } });
    await screen.findByText('Profile');
    expect(screen.queryByText('Coach')).not.toBeInTheDocument();
  });

  it('is hidden without ai:use', async () => {
    render(<UserSettingsHubPage />, {
      wrapperOptions: {
        aiEnabled: true,
        user: { ...mockUser, permissions: mockUser.permissions.filter((p) => p !== 'ai:use') },
      },
    });
    await screen.findByText('Profile');
    expect(screen.queryByText('Coach')).not.toBeInTheDocument();
  });
});
