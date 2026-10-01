/**
 * `CoachMessageBubble` (E7.8, #248): the variants by `kind`, the audio player
 * only for `ready` audio, the supportive safety style, Take photo, the chat's
 * links, thumbs feedback and the displayed-once signal.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../../utils/test-utils';
import { CoachMessageBubble, COACH_TAKE_PHOTO_PATH } from '../../../components/coach/CoachMessageBubble';
import { AI_GENERATED_AUDIO_LABEL } from '../../../components/ai/AiSpeechPlayer';
import { mockCoachMessage, mockCoachPersona } from '../../mocks/fixtures/coach';
import { SPEECH_OBJECT_ID } from '../../mocks/fixtures/ai';

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

  it('reports itself displayed exactly once', async () => {
    const onDisplayed = vi.fn();
    const message = mockCoachMessage();
    const { rerender } = render(<CoachMessageBubble message={message} persona={persona} onDisplayed={onDisplayed} />);
    rerender(<CoachMessageBubble message={{ ...message, feedback: 'up' }} persona={persona} onDisplayed={onDisplayed} />);
    await waitFor(() => expect(onDisplayed).toHaveBeenCalledTimes(1));
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <CoachMessageBubble message={mockCoachMessage({ kind: 'photo_prompt' })} persona={persona} onFeedback={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
