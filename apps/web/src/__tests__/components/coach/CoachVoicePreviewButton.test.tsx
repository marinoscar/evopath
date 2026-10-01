/**
 * `CoachVoicePreviewButton` (E7.6, #246): "Hear it" posts the preview, polls
 * the speech run and plays it with the AI-generated disclosure; the rate
 * limit, the unresolved voice model and a failed run each explain themselves;
 * a locked adult-language level says the clean line plays.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import {
  CoachVoicePreviewButton,
  VOICE_PREVIEW_CENSORED,
  VOICE_PREVIEW_FAILED,
  VOICE_PREVIEW_NO_MODEL,
  VOICE_PREVIEW_RATE_LIMITED,
  VOICE_PREVIEW_SOON,
} from '../../../components/coach/CoachVoicePreviewButton';
import { AI_GENERATED_AUDIO_LABEL } from '../../../components/ai/AiSpeechPlayer';
import type { CoachVoicePreviewRequest } from '../../../services/coach';

const API = '*/api';
const REQUEST: CoachVoicePreviewRequest = { personaId: 'coach', intensity: 2, voice: 'coral', speed: 1, moment: 'streak_at_risk' };

function servePreview(overrides: Record<string, unknown> = {}, bodies: unknown[] = []) {
  server.use(
    http.post(`${API}/coach/voice-preview`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        {
          data: {
            runId: 'run_speech_preview_1',
            jobId: 'job-preview-1',
            personaId: 'coach',
            intensity: 2,
            moment: 'streak_at_risk',
            voice: 'coral',
            censored: false,
            ...overrides,
          },
        },
        { status: 202 },
      );
    }),
  );
  return bodies;
}

function renderButton(props: Partial<Parameters<typeof CoachVoicePreviewButton>[0]> = {}) {
  return render(<CoachVoicePreviewButton available request={REQUEST} pollIntervalMs={5} {...props} />);
}

describe('CoachVoicePreviewButton', () => {
  it('posts the request, polls the run and plays it with the AI-generated disclosure', async () => {
    const user = userEvent.setup();
    const bodies = servePreview();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Hear it' }));

    expect(await screen.findByText(AI_GENERATED_AUDIO_LABEL)).toBeInTheDocument();
    expect(screen.getByLabelText('Generated speech')).toBeInTheDocument();
    expect(bodies).toEqual([REQUEST]);
    expect(screen.queryByText(VOICE_PREVIEW_CENSORED)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hear it' })).toBeEnabled();
  });

  it('says the clean line plays when adult language is locked', async () => {
    const user = userEvent.setup();
    servePreview({ censored: true });
    renderButton({ request: { ...REQUEST, personaId: 'drill_sergeant', intensity: 3 } });

    await user.click(screen.getByRole('button', { name: 'Hear it' }));

    expect(await screen.findByText(VOICE_PREVIEW_CENSORED)).toBeInTheDocument();
    expect(screen.getByText(AI_GENERATED_AUDIO_LABEL)).toBeInTheDocument();
  });

  it('explains the rate limit (429 COACH_PREVIEW_RATE_LIMITED)', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/coach/voice-preview`, () =>
        HttpResponse.json(
          {
            statusCode: 429,
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many voice previews. Try again later.',
            details: { code: 'COACH_PREVIEW_RATE_LIMITED', reason: 'COACH_PREVIEW_RATE_LIMITED', retryAfterMs: 60000 },
          },
          { status: 429, headers: { 'Retry-After': '60' } },
        ),
      ),
    );
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Hear it' }));

    expect(await screen.findByText(VOICE_PREVIEW_RATE_LIMITED)).toBeInTheDocument();
    expect(screen.queryByText(AI_GENERATED_AUDIO_LABEL)).not.toBeInTheDocument();
  });

  it('explains a missing voice model (409)', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/coach/voice-preview`, () =>
        HttpResponse.json(
          { statusCode: 409, code: 'CONFLICT', message: 'No model', details: { reason: 'AI_FEATURE_UNAVAILABLE' } },
          { status: 409 },
        ),
      ),
    );
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Hear it' }));

    expect(await screen.findByText(VOICE_PREVIEW_NO_MODEL)).toBeInTheDocument();
  });

  it('reports a speech run that failed', async () => {
    const user = userEvent.setup();
    servePreview({ runId: 'run_failed_preview' });
    server.use(
      http.get(`${API}/ai/runs/:id`, ({ params }) =>
        HttpResponse.json({
          data: {
            id: String(params.id),
            status: 'failed',
            provider: 'openai',
            modelId: 'gpt-4o-mini-tts',
            output: null,
            errorCode: 'AI_CONTENT_FILTERED',
            errorMessage: 'Refused',
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        }),
      ),
    );
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Hear it' }));

    expect(await screen.findByText(VOICE_PREVIEW_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(AI_GENERATED_AUDIO_LABEL)).not.toBeInTheDocument();
  });

  it('stays disabled with its reason when blocked', () => {
    renderButton({ disabled: true, disabledReason: 'Turn on spoken messages to preview a voice.' });
    expect(screen.getByRole('button', { name: 'Hear it' })).toBeDisabled();
    expect(screen.getByText('Turn on spoken messages to preview a voice.')).toBeInTheDocument();
  });

  it('is disabled with "Voice preview arrives soon" when a fork switches it off', () => {
    renderButton({ available: false });
    expect(screen.getByRole('button', { name: 'Hear it' })).toBeDisabled();
    expect(screen.getByText(VOICE_PREVIEW_SOON)).toBeInTheDocument();
  });
});
