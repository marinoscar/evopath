/**
 * `CoachMessageBubble` (E7.8, #248): the variants by `kind`, the audio player
 * only for `ready` audio, the supportive safety style, Take photo, the chat's
 * links, thumbs feedback and the displayed-once signal (only when actually
 * visible, or at once for the deep-linked message).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import { installIntersectionObserver, type ControlledIntersectionObserver } from '../../utils/intersectionObserver';
import { CoachMessageBubble, COACH_TAKE_PHOTO_PATH } from '../../../components/coach/CoachMessageBubble';
import { AI_GENERATED_AUDIO_LABEL } from '../../../components/ai/AiSpeechPlayer';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import {
  COACH_AUDIO_OBJECT_ID,
  mockCoachAudioReady,
  mockCoachMessage,
  mockCoachPersona,
} from '../../mocks/fixtures/coach';
import { SPEECH_OBJECT_ID, mockSignedUrl } from '../../mocks/fixtures/ai';
import { COACH_LISTEN_LABEL } from '../../../components/coach/CoachMessageBubble';
import { coachAudioTiming } from '../../../hooks/useCoachMessageAudio';
import { COACH_AUDIO_MESSAGES } from '../../../services/coach';

const persona = mockCoachPersona();

describe('CoachMessageBubble', () => {
  it('renders a coach nudge with the persona name, title and body as text', () => {
    render(<CoachMessageBubble message={mockCoachMessage()} persona={persona} />);
    const article = screen.getByRole('article', { name: /^Coach: Missed yesterday/ });
    expect(article).toHaveTextContent('No stress. Ten minutes today keeps the habit alive.');
  });

  it('renders a user turn on the right, without thumbs', () => {
    const { container } = render(
      <CoachMessageBubble
        message={mockCoachMessage({ role: 'user', kind: 'chat', title: '', body: 'Motivate me', personaId: null })}
        persona={persona}
        onFeedback={vi.fn()}
      />,
    );
    expect(screen.getByText('Motivate me')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Helpful' })).not.toBeInTheDocument();
    expect(container.querySelector('[data-message-id]')).toHaveStyle({ justifyContent: 'flex-end' });
  });

  it('never interprets the body as HTML', () => {
    render(
      <CoachMessageBubble message={mockCoachMessage({ body: '<img src=x onerror=alert(1)> hi' })} persona={persona} />,
    );
    expect(screen.getByText('<img src=x onerror=alert(1)> hi')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('shows the AI-generated audio player only when audio is ready', async () => {
    const { rerender } = render(
      <CoachMessageBubble
        message={mockCoachMessage({ audioStatus: 'ready', audioStorageObjectId: SPEECH_OBJECT_ID, voice: 'coral' })}
        persona={persona}
      />,
    );
    expect(screen.getByText(AI_GENERATED_AUDIO_LABEL)).toBeInTheDocument();

    for (const audioStatus of ['failed', 'none', 'pending'] as const) {
      rerender(<CoachMessageBubble message={mockCoachMessage({ audioStatus })} persona={persona} />);
      expect(screen.queryByText(AI_GENERATED_AUDIO_LABEL)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  });

  it('styles a celebration as the accent card', () => {
    const { container } = render(
      <CoachMessageBubble message={mockCoachMessage({ kind: 'celebration', title: 'New PR!' })} persona={persona} />,
    );
    expect(container.querySelector('[data-kind="celebration"]')).not.toBeNull();
    expect(screen.getByText('New PR!')).toBeInTheDocument();
  });

  it('renders a weekly review with whatever stats are present, and falls back to the body', () => {
    const { rerender } = render(
      <CoachMessageBubble
        message={mockCoachMessage({
          kind: 'weekly_review',
          title: 'Your week',
          body: 'Solid week overall.',
          data: { headline: 'Three for three', adherence: { done: 3, planned: 3 }, wins: ['New squat PR'], focus: 'Sleep' },
        })}
        persona={persona}
      />,
    );
    expect(screen.getByText('Three for three')).toBeInTheDocument();
    expect(screen.getByTestId('coach-review-adherence')).toHaveTextContent('3 of 3 sessions done');
    expect(screen.getByText('New squat PR')).toBeInTheDocument();
    expect(screen.getByText('Sleep')).toBeInTheDocument();

    rerender(
      <CoachMessageBubble
        message={mockCoachMessage({ kind: 'weekly_review', title: 'Your week', body: 'Solid week.', data: { wins: 'nope' } })}
        persona={persona}
      />,
    );
    expect(screen.getByText('Solid week.')).toBeInTheDocument();
    expect(screen.queryByTestId('coach-review-adherence')).not.toBeInTheDocument();
  });

  it('offers Take photo on a photo prompt, linking to the progress photos page', () => {
    render(<CoachMessageBubble message={mockCoachMessage({ kind: 'photo_prompt' })} persona={persona} />);
    expect(screen.getByRole('link', { name: 'Take photo' })).toHaveAttribute('href', COACH_TAKE_PHOTO_PATH);
    expect(COACH_TAKE_PHOTO_PATH).toBe('/health/progress-photos?add=1');
  });

  it('renders a distress safety reply in the supportive style, without persona or thumbs', () => {
    const { container } = render(
      <CoachMessageBubble
        message={mockCoachMessage({ kind: 'chat', personaId: null, title: '', body: 'Please reach out.', data: { safety: 'distress' } })}
        persona={persona}
        onFeedback={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-kind="supportive"]')).not.toBeNull();
    expect(screen.getByRole('article', { name: /^Support/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Helpful' })).not.toBeInTheDocument();
  });

  it('renders chat links as buttons, keeps only app-internal hrefs, and strips the Markdown link', () => {
    render(
      <CoachMessageBubble
        message={mockCoachMessage({
          kind: 'chat',
          title: '',
          body: "Try [Adjust today's workout](/train) instead.",
          data: {
            links: [
              { label: "Adjust today's workout", href: '/train' },
              { label: 'Evil', href: 'https://evil.example' },
            ],
          },
        })}
        persona={persona}
      />,
    );
    expect(screen.getByRole('link', { name: "Adjust today's workout" })).toHaveAttribute('href', '/train');
    expect(screen.queryByRole('link', { name: 'Evil' })).not.toBeInTheDocument();
    expect(screen.getByText("Try Adjust today's workout instead.")).toBeInTheDocument();
  });

  it('toggles thumbs: up, then up again clears to null', async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn();
    const { rerender } = render(
      <CoachMessageBubble message={mockCoachMessage()} persona={persona} onFeedback={onFeedback} />,
    );
    const up = screen.getByRole('button', { name: 'Helpful' });
    expect(up).toHaveAttribute('aria-pressed', 'false');
    await user.click(up);
    expect(onFeedback).toHaveBeenLastCalledWith(mockCoachMessage().id, 'up');

    rerender(<CoachMessageBubble message={mockCoachMessage({ feedback: 'up' })} persona={persona} onFeedback={onFeedback} />);
    expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(onFeedback).toHaveBeenLastCalledWith(mockCoachMessage().id, null);
    await user.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(onFeedback).toHaveBeenLastCalledWith(mockCoachMessage().id, 'down');
  });

  describe('displayed signal', () => {
    let io: ControlledIntersectionObserver;
    beforeEach(() => {
      io = installIntersectionObserver();
    });
    afterEach(() => {
      io.restore();
    });

    it('is not reported on mount, only once the bubble is half visible', () => {
      const onDisplayed = vi.fn();
      const message = mockCoachMessage();
      render(<CoachMessageBubble message={message} persona={persona} onDisplayed={onDisplayed} />);
      expect(onDisplayed).not.toHaveBeenCalled();
      expect(io.instances[0]?.options?.threshold).toBe(0.5);

      io.intersectAll(1);
      expect(onDisplayed).toHaveBeenCalledTimes(1);
      expect(onDisplayed).toHaveBeenCalledWith(message);
      // Disconnected after firing.
      expect(io.observed()).toHaveLength(0);
    });

    it('is not reported while the bubble is off screen or barely visible', () => {
      const onDisplayed = vi.fn();
      const { container } = render(
        <CoachMessageBubble message={mockCoachMessage()} persona={persona} onDisplayed={onDisplayed} />,
      );
      const el = container.querySelector('[data-message-id]') as Element;
      io.intersect(el, 0);
      io.intersect(el, 0.2);
      expect(onDisplayed).not.toHaveBeenCalled();
    });

    it('reports itself displayed exactly once, across re-renders and repeated intersections', () => {
      const onDisplayed = vi.fn();
      const message = mockCoachMessage();
      const { rerender } = render(<CoachMessageBubble message={message} persona={persona} onDisplayed={onDisplayed} />);
      rerender(<CoachMessageBubble message={{ ...message, feedback: 'up' }} persona={persona} onDisplayed={onDisplayed} />);
      io.intersectAll(1);
      io.intersectAll(1);
      rerender(<CoachMessageBubble message={{ ...message, feedback: null }} persona={persona} onDisplayed={onDisplayed} />);
      expect(onDisplayed).toHaveBeenCalledTimes(1);
    });

    it('reports the highlighted (deep-linked) message at once', () => {
      const onDisplayed = vi.fn();
      render(<CoachMessageBubble message={mockCoachMessage()} persona={persona} highlighted onDisplayed={onDisplayed} />);
      expect(onDisplayed).toHaveBeenCalledTimes(1);
    });
  });

  describe('displayed signal without IntersectionObserver', () => {
    const original = globalThis.IntersectionObserver;
    beforeEach(() => {
      // @ts-expect-error simulate a browser without IntersectionObserver
      delete globalThis.IntersectionObserver;
    });
    afterEach(() => {
      globalThis.IntersectionObserver = original;
    });

    it('never auto-reports an ordinary message', async () => {
      const onDisplayed = vi.fn();
      render(<CoachMessageBubble message={mockCoachMessage()} persona={persona} onDisplayed={onDisplayed} />);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onDisplayed).not.toHaveBeenCalled();
    });

    it('still reports the highlighted (deep-linked) message', () => {
      const onDisplayed = vi.fn();
      render(<CoachMessageBubble message={mockCoachMessage()} persona={persona} highlighted onDisplayed={onDisplayed} />);
      expect(onDisplayed).toHaveBeenCalledTimes(1);
    });
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <CoachMessageBubble message={mockCoachMessage({ kind: 'photo_prompt' })} persona={persona} onFeedback={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  describe('Listen (#259)', () => {
    const original = { ...coachAudioTiming };
    let play: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      coachAudioTiming.pollIntervalMs = 10;
      play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    });
    afterEach(() => {
      Object.assign(coachAudioTiming, original);
      vi.restoreAllMocks();
    });

    function recordAudio(
      post: () => Response | Promise<Response> = () => HttpResponse.json({ data: { status: 'pending', runId: 'r' } }, { status: 202 }),
      get: () => Response | Promise<Response> = () => HttpResponse.json({ data: mockCoachAudioReady() }),
    ) {
      const calls = { posts: 0, gets: 0 };
      server.use(
        http.post('*/api/coach/messages/:id/audio', () => {
          calls.posts += 1;
          return post();
        }),
        http.get('*/api/coach/messages/:id/audio', () => {
          calls.gets += 1;
          return get();
        }),
      );
      return calls;
    }

    it('is hidden unless speech is enabled', () => {
      render(<CoachMessageBubble message={mockCoachMessage()} persona={persona} onFeedback={vi.fn()} />);
      expect(screen.queryByRole('button', { name: COACH_LISTEN_LABEL })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Helpful' })).toBeInTheDocument();
    });

    it('is never shown on a user turn', () => {
      render(
        <CoachMessageBubble
          message={mockCoachMessage({ role: 'user', kind: 'chat', title: '', body: 'Hi', personaId: null })}
          persona={persona}
          speechEnabled
        />,
      );
      expect(screen.queryByRole('button', { name: COACH_LISTEN_LABEL })).not.toBeInTheDocument();
    });

    it.each([
      ['nudge', {}],
      ['celebration', { kind: 'celebration' }],
      ['chat reply', { kind: 'chat', title: '' }],
      ['weekly review', { kind: 'weekly_review', data: { headline: 'Week' } }],
      ['safety reply', { kind: 'chat', personaId: null, title: '', data: { safety: 'distress' } }],
    ])('is shown on a coach %s', (_label, overrides) => {
      render(
        <CoachMessageBubble message={mockCoachMessage(overrides)} persona={persona} onFeedback={vi.fn()} speechEnabled />,
      );
      expect(screen.getByRole('button', { name: COACH_LISTEN_LABEL })).toBeInTheDocument();
    });

    it('creates audio only on press: POST, Creating audio…, poll, then plays', async () => {
      // Hold the POST open so the "creating" state is observable deterministically,
      // instead of racing a mocked response that can settle before the assertion.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls = recordAudio(async () => {
        await gate;
        return HttpResponse.json({ data: { status: 'pending', runId: 'r' } }, { status: 202 });
      });
      const user = userEvent.setup();
      const { container } = render(
        <CoachMessageBubble message={mockCoachMessage()} persona={persona} speechEnabled />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.posts).toBe(0);

      await user.click(screen.getByRole('button', { name: COACH_LISTEN_LABEL }));
      await waitFor(() => expect(calls.posts).toBe(1));
      expect(screen.getByTestId('coach-audio-status')).toHaveTextContent(COACH_AUDIO_MESSAGES.creating);
      expect(screen.getByRole('button', { name: COACH_LISTEN_LABEL })).toHaveAttribute('aria-busy', 'true');
      expect(container.querySelector('audio')).toBeNull();
      expect(calls.gets).toBe(0);

      release();
      await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
      expect(container.querySelector('audio')).toHaveAttribute('src', mockSignedUrl(COACH_AUDIO_OBJECT_ID));
      expect(screen.getByText(AI_GENERATED_AUDIO_LABEL)).toBeInTheDocument();
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      expect(calls).toEqual({ posts: 1, gets: 1 });
      expect(screen.getByTestId('coach-audio-status')).toHaveTextContent('');
      expect(screen.getByRole('button', { name: COACH_LISTEN_LABEL })).toHaveAttribute('aria-busy', 'false');

      // A second press replays from the loaded player, without a request.
      await user.click(screen.getByRole('button', { name: COACH_LISTEN_LABEL }));
      await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
      expect(calls).toEqual({ posts: 1, gets: 1 });
    });

    it('plays audio already ready in the timeline without a POST', async () => {
      const calls = recordAudio();
      const user = userEvent.setup();
      const { container } = render(
        <CoachMessageBubble
          message={mockCoachMessage({ audioStatus: 'ready', audioStorageObjectId: SPEECH_OBJECT_ID, voice: 'coral' })}
          persona={persona}
          speechEnabled
        />,
      );
      await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
      expect(play).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: COACH_LISTEN_LABEL }));
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      expect(calls.posts).toBe(0);
    });

    it('explains a failed generation, and a second press retries', async () => {
      let fail = true;
      const calls = recordAudio(undefined, () =>
        HttpResponse.json({ data: fail ? { status: 'failed' } : mockCoachAudioReady() }),
      );
      const user = userEvent.setup();
      const { container } = render(<CoachMessageBubble message={mockCoachMessage()} persona={persona} speechEnabled />);
      await user.click(screen.getByRole('button', { name: COACH_LISTEN_LABEL }));
      await waitFor(() =>
        expect(screen.getByTestId('coach-audio-status')).toHaveTextContent(COACH_AUDIO_MESSAGES.failed),
      );
      expect(container.querySelector('audio')).toBeNull();

      fail = false;
      await user.click(screen.getByRole('button', { name: COACH_LISTEN_LABEL }));
      await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
      expect(calls.posts).toBe(2);
    });

    it.each([
      [403, { code: 'COACH_AUDIO_DISABLED' }, COACH_AUDIO_MESSAGES.disabled],
      [409, { reason: 'NO_SPEECH_MODEL' }, COACH_AUDIO_MESSAGES.unavailable],
      [429, { code: 'COACH_AUDIO_RATE_LIMITED' }, COACH_AUDIO_MESSAGES.rateLimited],
    ])('explains a %s refusal', async (status, details, text) => {
      recordAudio(() => HttpResponse.json({ message: 'refused', details }, { status }));
      const onSpeechDisabled = vi.fn();
      const user = userEvent.setup();
      render(
        <CoachMessageBubble
          message={mockCoachMessage()}
          persona={persona}
          speechEnabled
          onSpeechDisabled={onSpeechDisabled}
        />,
      );
      await user.click(screen.getByRole('button', { name: COACH_LISTEN_LABEL }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      if (status === 403) {
        expect(onSpeechDisabled).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('button', { name: COACH_LISTEN_LABEL })).not.toBeInTheDocument();
      } else {
        expect(onSpeechDisabled).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: COACH_LISTEN_LABEL })).toBeInTheDocument();
      }
    });

    it('requests audio by itself for an autoplay deep link, once', async () => {
      const calls = recordAudio();
      const message = mockCoachMessage();
      const { container, rerender } = render(
        <CoachMessageBubble message={message} persona={persona} highlighted autoPlay speechEnabled />,
      );
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      expect(container.querySelector('audio')).not.toBeNull();
      rerender(<CoachMessageBubble message={{ ...message, feedback: 'up' }} persona={persona} highlighted autoPlay speechEnabled />);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls.posts).toBe(1);
    });

    it('does not request audio for an autoplay deep link while speech is off', async () => {
      const calls = recordAudio();
      render(<CoachMessageBubble message={mockCoachMessage()} persona={persona} highlighted autoPlay />);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls.posts).toBe(0);
    });

    it('stops polling when unmounted', async () => {
      const calls = recordAudio(undefined, () => HttpResponse.json({ data: { status: 'pending', runId: 'r' } }));
      const user = userEvent.setup();
      const { unmount } = render(<CoachMessageBubble message={mockCoachMessage()} persona={persona} speechEnabled />);
      await user.click(screen.getByRole('button', { name: COACH_LISTEN_LABEL }));
      await waitFor(() => expect(calls.gets).toBeGreaterThan(0));
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const settled = calls.gets;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(calls.gets).toBe(settled);
    });

    it('has no axe violations with the Listen button and its status', async () => {
      recordAudio(undefined, () => HttpResponse.json({ data: { status: 'pending', runId: 'r' } }));
      const user = userEvent.setup();
      const { container } = render(
        <CoachMessageBubble message={mockCoachMessage()} persona={persona} onFeedback={vi.fn()} speechEnabled />,
      );
      expect(await axe(container)).toHaveNoViolations();
      await user.click(screen.getByRole('button', { name: COACH_LISTEN_LABEL }));
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
