/**
 * `/coach` (E7.8, #248; docs/specs/ai-coach.md §2.13): the timeline (order,
 * paging, opened once), the deep link (`?m=`, `&autoplay=1`), streaming chat
 * (quick replies, tool chips, safety, errors and retry), thumbs feedback, the
 * empty state and accessibility.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render } from '../utils/test-utils';
import { installIntersectionObserver } from '../utils/intersectionObserver';
import { server } from '../mocks/server';
import CoachPage from '../../pages/CoachPage';
import {
  coachMessageId,
  coachSseBody,
  mockCoachMessage,
  mockCoachSettingsView,
  mockWeeklyReviewMessage,
  WEEKLY_REVIEW_PLAN_PROMPT,
} from '../mocks/fixtures/coach';
import { SPEECH_OBJECT_ID } from '../mocks/fixtures/ai';
import type { CoachTimelineItem } from '../../services/coach';
import { COACH_LISTEN_LABEL } from '../../components/coach/CoachMessageBubble';
import { coachAudioTiming } from '../../hooks/useCoachMessageAudio';

const API = '*/api';

function messagesPages(pages: Record<string, { items: CoachTimelineItem[]; nextCursor: string | null }>) {
  const requests: Array<string | null> = [];
  server.use(
    http.get(`${API}/coach/messages`, ({ request }) => {
      const before = new URL(request.url).searchParams.get('before');
      requests.push(before);
      const page = pages[before ?? 'first'] ?? { items: [], nextCursor: null };
      return HttpResponse.json({ data: page });
    }),
  );
  return requests;
}

function recordPosts(path: 'opened' | 'feedback', status = 204) {
  const calls: Array<{ id: string; body: unknown }> = [];
  server.use(
    http.post(`${API}/coach/messages/:id/${path}`, async ({ params, request }) => {
      const text = await request.text();
      calls.push({ id: String(params.id), body: text ? JSON.parse(text) : null });
      return status === 204
        ? new HttpResponse(null, { status })
        : HttpResponse.json({ message: 'Not Found' }, { status });
    }),
  );
  return calls;
}

/** A chat stream the test feeds frame by frame. */
function controlledChat() {
  const encoder = new TextEncoder();
  const bodies: unknown[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  server.use(
    http.post(`${API}/coach/chat/stream`, async ({ request }) => {
      bodies.push(await request.json());
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }),
  );
  return {
    bodies,
    push(event: string, data: unknown) {
      controller?.enqueue(encoder.encode(coachSseBody([[event, data]])));
    },
    close() {
      controller?.close();
    },
  };
}

function chatRefusal(status: number, body: Record<string, unknown>) {
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API}/coach/chat/stream`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(body, { status });
    }),
  );
  return bodies;
}

const nudge = mockCoachMessage({ id: coachMessageId(3), openedAt: null, body: 'Newest nudge', createdAt: '2026-09-29T12:00:00.000Z' });
const reply = mockCoachMessage({ id: coachMessageId(2), role: 'user', kind: 'chat', title: '', body: 'Middle user turn', personaId: null, openedAt: null, createdAt: '2026-09-29T11:00:00.000Z' });
const oldest = mockCoachMessage({ id: coachMessageId(1), body: 'Oldest read nudge', createdAt: '2026-09-29T10:00:00.000Z' });

function renderPage(route = '/coach') {
  return render(<CoachPage />, { wrapperOptions: { route, aiEnabled: true } });
}

function timelineTexts(): string[] {
  const log = screen.getByRole('log', { name: 'Coach conversation' });
  return [...log.querySelectorAll('[data-message-id]')].map((el) => el.getAttribute('data-message-id') ?? '');
}

describe('CoachPage', () => {
  let play: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('timeline', () => {
    it('renders the header and the messages oldest first, newest at the bottom, in a labelled log', async () => {
      messagesPages({ first: { items: [nudge, reply, oldest], nextCursor: null } });
      renderPage();

      expect(await screen.findByText('Newest nudge')).toBeInTheDocument();
      const log = screen.getByRole('log', { name: 'Coach conversation' });
      expect(log).toHaveAttribute('aria-live', 'polite');
      expect(timelineTexts()).toEqual([oldest.id, reply.id, nudge.id]);
      expect(await screen.findByTestId('coach-weekly-target')).toHaveTextContent('2 of 3 this week');
      expect(await screen.findByRole('heading', { level: 1, name: 'Coach' })).toBeInTheDocument();
    });

    it('loads an older page with the before cursor and prepends it', async () => {
      const older = mockCoachMessage({ id: coachMessageId(10), body: 'Ancient history', createdAt: '2026-09-20T10:00:00.000Z' });
      const requests = messagesPages({
        first: { items: [nudge], nextCursor: nudge.id },
        [nudge.id]: { items: [older], nextCursor: null },
      });
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Load older messages' }));
      expect(await screen.findByText('Ancient history')).toBeInTheDocument();
      expect(requests).toEqual([null, nudge.id]);
      expect(timelineTexts()).toEqual([older.id, nudge.id]);
      expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
    });

    it('keeps loaded messages when an older page fails, with a retry', async () => {
      server.use(
        http.get(`${API}/coach/messages`, ({ request }) =>
          new URL(request.url).searchParams.get('before')
            ? HttpResponse.json({ message: 'Boom' }, { status: 500 })
            : HttpResponse.json({ data: { items: [nudge], nextCursor: nudge.id } }),
        ),
      );
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Load older messages' }));
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.getByText('Newest nudge')).toBeInTheDocument();
    });

    it('shows an inline alert with retry when the timeline fails to load', async () => {
      let fail = true;
      server.use(
        http.get(`${API}/coach/messages`, () =>
          fail
            ? HttpResponse.json({ message: 'Down' }, { status: 500 })
            : HttpResponse.json({ data: { items: [nudge], nextCursor: null } }),
        ),
      );
      const user = userEvent.setup();
      renderPage();
      expect(await screen.findByText('Down')).toBeInTheDocument();
      fail = false;
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('Newest nudge')).toBeInTheDocument();
    });

    it('marks each unread coach message opened exactly once when seen, and never a read one or a user turn', async () => {
      const io = installIntersectionObserver();
      try {
        messagesPages({ first: { items: [nudge, reply, oldest], nextCursor: null } });
        const opened = recordPosts('opened');
        const user = userEvent.setup();
        renderPage();

        await screen.findByText('Newest nudge');
        io.intersectAll(1);
        await waitFor(() => expect(opened.map((c) => c.id)).toEqual([nudge.id]));
        // Re-rendering the bubble (feedback) or scrolling past again does not post again.
        await user.click(screen.getAllByRole('button', { name: 'Helpful' })[0]);
        io.intersectAll(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(opened).toHaveLength(1);
      } finally {
        io.restore();
      }
    });

    it('does not mark an unread message opened just because the page loaded it', async () => {
      const io = installIntersectionObserver();
      try {
        messagesPages({ first: { items: [nudge, reply, oldest], nextCursor: null } });
        const opened = recordPosts('opened');
        renderPage();
        await screen.findByText('Newest nudge');
        // Off screen, or less than half on screen.
        io.intersectAll(0);
        io.intersectAll(0.3);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(opened).toHaveLength(0);
      } finally {
        io.restore();
      }
    });

    it('tolerates the opened route answering 404 (E7.5 not deployed) without any error on screen', async () => {
      const io = installIntersectionObserver();
      try {
        messagesPages({ first: { items: [nudge], nextCursor: null } });
        const opened = recordPosts('opened', 404);
        renderPage();
        await screen.findByText('Newest nudge');
        io.intersectAll(1);
        await waitFor(() => expect(opened).toHaveLength(1));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      } finally {
        io.restore();
      }
    });

    it('shows the empty state introducing the coach, linking to its settings', async () => {
      messagesPages({ first: { items: [], nextCursor: null } });
      renderPage();
      const empty = await screen.findByTestId('coach-empty');
      expect(within(empty).getByRole('heading', { name: 'Meet your coach' })).toBeInTheDocument();
      expect(within(empty).getByRole('link', { name: 'Choose your coach' })).toHaveAttribute('href', '/settings/coach');
    });
  });

  describe('thumbs feedback', () => {
    it('posts up, reflects it, and clears it with a second tap', async () => {
      messagesPages({ first: { items: [oldest], nextCursor: null } });
      const feedback = recordPosts('feedback');
      const user = userEvent.setup();
      renderPage();

      const up = await screen.findByRole('button', { name: 'Helpful' });
      await user.click(up);
      await waitFor(() => expect(feedback).toEqual([{ id: oldest.id, body: { feedback: 'up' } }]));
      expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', 'true');

      await user.click(screen.getByRole('button', { name: 'Helpful' }));
      await waitFor(() => expect(feedback[1]).toEqual({ id: oldest.id, body: { feedback: null } }));
      expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('reverts when the feedback route fails', async () => {
      messagesPages({ first: { items: [oldest], nextCursor: null } });
      recordPosts('feedback', 404);
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Not helpful' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Not helpful' })).toHaveAttribute('aria-pressed', 'false'),
      );
    });
  });

  describe('deep link', () => {
    const spoken = mockCoachMessage({
      id: coachMessageId(42),
      openedAt: null,
      audioStatus: 'ready',
      audioStorageObjectId: SPEECH_OBJECT_ID,
      voice: 'coral',
      body: 'Spoken nudge',
    });

    it('highlights ?m=<id>, scrolls to it, marks it opened and autoplays with &autoplay=1', async () => {
      messagesPages({ first: { items: [nudge, spoken], nextCursor: null } });
      const opened = recordPosts('opened');
      renderPage(`/coach?m=${spoken.id}&autoplay=1`);

      await screen.findByText('Spoken nudge');
      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(opened.map((c) => c.id)).toContain(spoken.id));
      expect(opened.filter((c) => c.id === spoken.id)).toHaveLength(1);
      // Only the deep-linked message: the other unread one was never seen.
      expect(opened.map((c) => c.id)).not.toContain(nudge.id);
      expect(document.activeElement?.getAttribute('data-message-id')).toBe(spoken.id);
    });

    it('does not autoplay without &autoplay=1', async () => {
      messagesPages({ first: { items: [spoken], nextCursor: null } });
      renderPage(`/coach?m=${spoken.id}`);
      await screen.findByText('Spoken nudge');
      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(play).not.toHaveBeenCalled();
    });

    it('shows a Play button when the browser blocks autoplay', async () => {
      play.mockRejectedValueOnce(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
      messagesPages({ first: { items: [spoken], nextCursor: null } });
      renderPage(`/coach?m=${spoken.id}&autoplay=1`);
      expect(await screen.findByRole('button', { name: /^Play/ })).toBeInTheDocument();
    });

    it('pages back to find a message that is not on the first page', async () => {
      const requests = messagesPages({
        first: { items: [nudge], nextCursor: nudge.id },
        [nudge.id]: { items: [spoken], nextCursor: null },
      });
      renderPage(`/coach?m=${spoken.id}`);
      expect(await screen.findByText('Spoken nudge')).toBeInTheDocument();
      expect(requests).toEqual([null, nudge.id]);
    });

    it('ignores an m that is not a message id', async () => {
      const requests = messagesPages({ first: { items: [nudge], nextCursor: nudge.id } });
      renderPage('/coach?m=../../etc&autoplay=1');
      await screen.findByText('Newest nudge');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(requests).toEqual([null]);
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });
  });

  describe('chat', () => {
    beforeEach(() => {
      messagesPages({ first: { items: [oldest], nextCursor: null } });
    });

    it('shows a quick reply immediately, streams the reply with tool chips, then keeps it', async () => {
      const chat = controlledChat();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');

      await user.click(screen.getByRole('button', { name: 'How am I doing?' }));
      expect(await screen.findByTestId('coach-pending-user')).toHaveTextContent('How am I doing?');
      expect(await screen.findByRole('status', { name: 'Coach is typing' })).toBeInTheDocument();
      await waitFor(() => expect(chat.bodies).toEqual([{ text: 'How am I doing?' }]));

      chat.push('tool', { name: 'get_training_signals', status: 'ok' });
      expect(await screen.findByText('Checking your training')).toBeInTheDocument();
      chat.push('delta', { text: 'Two of three ' });
      expect(await screen.findByText('Two of three')).toBeInTheDocument();
      expect(screen.getByTestId('coach-streaming')).toHaveAttribute('aria-busy', 'true');
      chat.push('delta', { text: 'done. Nice.' });
      chat.push('done', {
        messageId: coachMessageId(901),
        userMessageId: coachMessageId(900),
        links: [{ label: "Adjust today's workout", href: '/train' }],
        pausedUntil: null,
        fallback: false,
      });
      chat.close();

      await waitFor(() => expect(screen.queryByTestId('coach-streaming')).not.toBeInTheDocument());
      expect(timelineTexts()).toEqual([oldest.id, coachMessageId(900), coachMessageId(901)]);
      expect(screen.getByText('Two of three done. Nice.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: "Adjust today's workout" })).toHaveAttribute('href', '/train');
      // The send buttons are enabled again.
      expect(screen.getByRole('button', { name: 'Motivate me' })).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('sends typed text from the composer', async () => {
      const user = userEvent.setup();
      let body: unknown = null;
      server.use(
        http.post(`${API}/coach/chat/stream`, async ({ request }) => {
          body = await request.json();
          return new HttpResponse(
            coachSseBody([
              ['delta', { text: 'Hi!' }],
              ['done', { messageId: coachMessageId(801), userMessageId: coachMessageId(800), links: [], pausedUntil: null, fallback: false }],
            ]),
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        }),
      );
      renderPage();
      await screen.findByText('Oldest read nudge');
      await user.type(screen.getByRole('textbox', { name: 'Message your coach' }), 'Hello coach{Enter}');
      expect(await screen.findByText('Hi!')).toBeInTheDocument();
      expect(body).toEqual({ text: 'Hello coach' });
    });

    it('styles a blocked safety reply as supportive, without the persona', async () => {
      const chat = controlledChat();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');

      await user.click(screen.getByRole('button', { name: "I'm sick" }));
      await waitFor(() => expect(chat.bodies).toHaveLength(1));
      chat.push('safety', { level: 'blocked', screen: 'symptom' });
      chat.push('delta', { text: 'Please stop and get checked.' });
      await waitFor(() => expect(screen.getByTestId('coach-streaming')).toHaveAttribute('data-kind', 'supportive'));
      chat.push('done', { messageId: coachMessageId(701), userMessageId: coachMessageId(700), links: [], pausedUntil: null, fallback: false });
      chat.close();

      const article = await screen.findByRole('article', { name: /^Support/ });
      expect(article).toHaveTextContent('Please stop and get checked.');
      expect(within(article).queryByRole('button', { name: 'Helpful' })).not.toBeInTheDocument();
    });

    it('explains COACH_DISABLED with a link to coach settings', async () => {
      chatRefusal(403, { message: 'Coach is disabled', details: { code: 'COACH_DISABLED' } });
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      await user.click(screen.getByRole('button', { name: 'Motivate me' }));
      const error = await screen.findByTestId('coach-chat-error');
      expect(within(error).getByRole('link', { name: 'Coach settings' })).toHaveAttribute('href', '/settings/coach');
    });

    it('explains AI_FEATURE_UNAVAILABLE without offering a retry', async () => {
      chatRefusal(409, { message: 'No model', details: { reason: 'AI_FEATURE_UNAVAILABLE' } });
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      await user.click(screen.getByRole('button', { name: 'Motivate me' }));
      const error = await screen.findByTestId('coach-chat-error');
      expect(error).toHaveTextContent(/not available right now/);
      expect(within(error).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });

    it('says to try later on 429, and a retry re-sends the same text into the same bubble', async () => {
      const bodies = chatRefusal(429, { message: 'Too many requests' });
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      await user.click(screen.getByRole('button', { name: 'Adjust this week' }));
      const error = await screen.findByTestId('coach-chat-error');
      expect(error).toHaveTextContent(/Try again later/);

      const chat = controlledChat();
      await user.click(within(error).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(chat.bodies).toEqual([{ text: 'Adjust this week' }]));
      expect(bodies).toHaveLength(1);
      // One user bubble for the turn, never two.
      expect(screen.getAllByTestId('coach-pending-user')).toHaveLength(1);
      expect(screen.getAllByText('Adjust this week', { selector: '[data-testid="coach-pending-user"] *' })).toHaveLength(1);
    });

    it('offers a retry after an error frame mid-stream', async () => {
      const chat = controlledChat();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      await user.click(screen.getByRole('button', { name: 'Motivate me' }));
      await waitFor(() => expect(chat.bodies).toHaveLength(1));
      chat.push('error', { code: 'AI_PROVIDER_ERROR', message: 'The provider failed.' });
      chat.close();

      const error = await screen.findByTestId('coach-chat-error');
      expect(error).toHaveTextContent('The provider failed.');
      expect(within(error).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.getByTestId('coach-pending-user')).toHaveTextContent('Motivate me');
    });

    it('retries a stored-but-unanswered turn with retryOf, labelled "No reply yet"', async () => {
      const chat = controlledChat();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      await user.click(screen.getByRole('button', { name: 'Motivate me' }));
      await waitFor(() => expect(chat.bodies).toHaveLength(1));
      chat.push('error', { code: 'AI_PROVIDER_ERROR', message: 'The provider failed.', userMessageId: coachMessageId(600) });
      chat.close();

      const error = await screen.findByTestId('coach-chat-error');
      expect(screen.getByLabelText('You, no reply yet — try again')).toHaveTextContent('Motivate me');
      expect(screen.getByTestId('coach-pending-status')).toHaveTextContent('No reply yet — try again');
      expect(screen.queryByLabelText('You, not delivered')).not.toBeInTheDocument();

      await user.click(within(error).getByRole('button', { name: 'Retry' }));
      await waitFor(() =>
        expect(chat.bodies).toEqual([{ text: 'Motivate me' }, { text: 'Motivate me', retryOf: coachMessageId(600) }]),
      );
      chat.push('delta', { text: 'Go!' });
      chat.push('done', { messageId: coachMessageId(601), userMessageId: coachMessageId(600), links: [], pausedUntil: null, fallback: false });
      chat.close();
      await waitFor(() => expect(screen.queryByTestId('coach-pending-user')).not.toBeInTheDocument());
      expect(timelineTexts()).toEqual([oldest.id, coachMessageId(600), coachMessageId(601)]);
    });

    it('retries plainly when the error frame says nothing was stored', async () => {
      const chat = controlledChat();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      await user.click(screen.getByRole('button', { name: 'Motivate me' }));
      await waitFor(() => expect(chat.bodies).toHaveLength(1));
      chat.push('error', { code: 'AI_PROVIDER_ERROR', message: 'The provider failed.', userMessageId: null });
      chat.close();

      const error = await screen.findByTestId('coach-chat-error');
      expect(screen.getByLabelText('You, not delivered')).toBeInTheDocument();
      expect(screen.queryByTestId('coach-pending-status')).not.toBeInTheDocument();
      await user.click(within(error).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(chat.bodies).toEqual([{ text: 'Motivate me' }, { text: 'Motivate me' }]));
    });

    it('after a cut-off stream, finds the stored turn on the latest page and retries it with retryOf', async () => {
      const storedTurn = mockCoachMessage({
        id: coachMessageId(650),
        role: 'user',
        kind: 'chat',
        title: '',
        body: 'Motivate me',
        personaId: null,
        createdAt: '2026-09-30T10:00:00.000Z',
      });
      const pageRequests = messagesPages({ first: { items: [oldest], nextCursor: null } });
      const chat = controlledChat();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      // From now on the latest page carries the stored user row.
      messagesPages({ first: { items: [storedTurn, oldest], nextCursor: null } });

      await user.click(screen.getByRole('button', { name: 'Motivate me' }));
      await waitFor(() => expect(chat.bodies).toHaveLength(1));
      chat.push('delta', { text: 'Half a rep' });
      chat.close();

      const error = await screen.findByTestId('coach-chat-error');
      expect(error).toHaveTextContent('The reply was cut off.');
      expect(screen.getByLabelText('You, no reply yet — try again')).toBeInTheDocument();
      expect(pageRequests).toEqual([null]);
      // The refetch did not put the stored row on screen beside the pending bubble.
      expect(timelineTexts()).toEqual([oldest.id]);

      await user.click(within(error).getByRole('button', { name: 'Retry' }));
      await waitFor(() =>
        expect(chat.bodies).toEqual([{ text: 'Motivate me' }, { text: 'Motivate me', retryOf: coachMessageId(650) }]),
      );
    });

    it('after a cut-off stream with no stored turn on the latest page, retries plainly', async () => {
      const chat = controlledChat();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      await user.click(screen.getByRole('button', { name: 'Motivate me' }));
      await waitFor(() => expect(chat.bodies).toHaveLength(1));
      chat.push('delta', { text: 'Half a rep' });
      chat.close();

      const error = await screen.findByTestId('coach-chat-error');
      expect(screen.getByLabelText('You, not delivered')).toBeInTheDocument();
      await user.click(within(error).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(chat.bodies).toEqual([{ text: 'Motivate me' }, { text: 'Motivate me' }]));
    });
  });

  describe('weekly review', () => {
    it('renders the review card, and Plan my week pre-fills the composer without sending', async () => {
      messagesPages({ first: { items: [mockWeeklyReviewMessage(), oldest], nextCursor: null } });
      const chat = chatRefusal(500, { message: 'should not be called' });
      const user = userEvent.setup();
      renderPage();
      const card = await screen.findByTestId('coach-weekly-review');
      expect(within(card).getByRole('heading', { name: 'Three of four, and a squat PR' })).toBeInTheDocument();

      await user.click(within(card).getByRole('button', { name: 'Plan my week' }));
      const field = screen.getByRole('textbox', { name: 'Message your coach' });
      expect(field).toHaveValue(WEEKLY_REVIEW_PLAN_PROMPT);
      expect(field).toHaveFocus();
      expect(chat).toHaveLength(0);

      // Editing then tapping again restores the prompt.
      await user.clear(field);
      await user.click(within(card).getByRole('button', { name: 'Plan my week' }));
      expect(field).toHaveValue(WEEKLY_REVIEW_PLAN_PROMPT);
    });
  });

  describe('Listen (#259)', () => {
    const original = { ...coachAudioTiming };
    beforeEach(() => {
      coachAudioTiming.pollIntervalMs = 10;
    });
    afterEach(() => {
      Object.assign(coachAudioTiming, original);
    });

    function speech(settingsAudio: boolean, allowAudio = true) {
      server.use(
        http.get(`${API}/coach/settings`, () =>
          HttpResponse.json({
            data: mockCoachSettingsView({
              settings: { audio: { enabled: settingsAudio, voice: null, speed: 1 } },
              policy: { allowAudio },
            }),
          }),
        ),
      );
    }

    function recordAudioPosts(status = 202, body: unknown = { data: { status: 'pending', runId: 'r' } }) {
      const posts: string[] = [];
      server.use(
        http.post(`${API}/coach/messages/:id/audio`, ({ params }) => {
          posts.push(String(params.id));
          return HttpResponse.json(body, { status });
        }),
      );
      return posts;
    }

    it('offers Listen on every coach message, never on a user turn, when speech is on', async () => {
      speech(true);
      messagesPages({ first: { items: [nudge, reply, oldest], nextCursor: null } });
      renderPage();
      await screen.findByText('Newest nudge');
      await waitFor(() => expect(screen.getAllByRole('button', { name: COACH_LISTEN_LABEL })).toHaveLength(2));
      const userTurn = document.querySelector(`[data-message-id="${reply.id}"]`) as HTMLElement;
      expect(within(userTurn).queryByRole('button', { name: COACH_LISTEN_LABEL })).not.toBeInTheDocument();
    });

    it.each([
      ['the user has spoken messages off', false, true],
      ['the deployment does not allow audio', true, false],
    ])('hides Listen when %s', async (_label, enabled, allowAudio) => {
      speech(enabled, allowAudio);
      messagesPages({ first: { items: [nudge], nextCursor: null } });
      renderPage();
      await screen.findByText('Newest nudge');
      await screen.findByTestId('coach-weekly-target');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByRole('button', { name: COACH_LISTEN_LABEL })).not.toBeInTheDocument();
    });

    it('hides every Listen button once the API says spoken messages are off', async () => {
      speech(true);
      recordAudioPosts(403, { message: 'Audio is off', details: { code: 'COACH_AUDIO_DISABLED' } });
      messagesPages({ first: { items: [nudge, oldest], nextCursor: null } });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByRole('button', { name: COACH_LISTEN_LABEL })).toHaveLength(2));
      await user.click(screen.getAllByRole('button', { name: COACH_LISTEN_LABEL })[0]);
      expect(await screen.findByText('Spoken messages are turned off')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: COACH_LISTEN_LABEL })).not.toBeInTheDocument();
    });

    it('a deep link with &autoplay=1 creates missing audio once, then plays it', async () => {
      speech(true);
      const posts = recordAudioPosts();
      const silent = mockCoachMessage({ id: coachMessageId(43), openedAt: null, body: 'Silent nudge' });
      messagesPages({ first: { items: [nudge, silent], nextCursor: null } });
      const { container } = renderPage(`/coach?m=${silent.id}&autoplay=1`);
      await screen.findByText('Silent nudge');
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      const target = container.querySelector(`[data-message-id="${silent.id}"]`) as HTMLElement;
      expect(target.querySelector('audio')).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts).toEqual([silent.id]);
    });

    it('a deep link with &autoplay=1 does not create audio while speech is off', async () => {
      speech(false);
      const posts = recordAudioPosts();
      const silent = mockCoachMessage({ id: coachMessageId(43), openedAt: null, body: 'Silent nudge' });
      messagesPages({ first: { items: [silent], nextCursor: null } });
      renderPage(`/coach?m=${silent.id}&autoplay=1`);
      await screen.findByText('Silent nudge');
      await screen.findByTestId('coach-weekly-target');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts).toEqual([]);
      expect(play).not.toHaveBeenCalled();
    });

    it('has no axe violations with Listen buttons', async () => {
      speech(true);
      messagesPages({ first: { items: [nudge, reply, oldest], nextCursor: null } });
      const { container } = renderPage();
      await waitFor(() => expect(screen.getAllByRole('button', { name: COACH_LISTEN_LABEL })).toHaveLength(2));
      await screen.findByTestId('coach-weekly-target');
      const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
      expect(results).toHaveNoViolations();
    });
  });

  it('has no axe violations with a weekly review card', async () => {
    messagesPages({ first: { items: [mockWeeklyReviewMessage(), oldest], nextCursor: null } });
    const { container } = renderPage();
    await screen.findByTestId('coach-weekly-review');
    await screen.findByTestId('coach-weekly-target');
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });

  describe('start over (#323)', () => {
    /** The timeline answers `before` until the clear, then `after` (as the API filters by chatClearedAt). */
    function clearableTimeline(before: CoachTimelineItem[], after: CoachTimelineItem[] = []) {
      const clears: number[] = [];
      let cleared = false;
      let reads = 0;
      server.use(
        http.get(`${API}/coach/messages`, () => {
          reads += 1;
          return HttpResponse.json({ data: { items: cleared ? after : before, nextCursor: null } });
        }),
        http.post(`${API}/coach/chat/clear`, () => {
          cleared = true;
          clears.push(Date.now());
          return new HttpResponse(null, { status: 204 });
        }),
      );
      return { clears, reads: () => reads };
    }

    const openMenu = async (user: ReturnType<typeof userEvent.setup>) =>
      user.click(await screen.findByRole('button', { name: 'Conversation options' }));

    it('menu, confirm dialog, POST, then an empty timeline with the empty state', async () => {
      const api = clearableTimeline([nudge, reply, oldest]);
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Newest nudge');
      const readsBefore = api.reads();

      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: 'Start over' }));
      const dialog = await screen.findByRole('dialog', { name: 'Start a fresh conversation?' });
      expect(dialog).toHaveTextContent("Your coach won't see earlier messages. Your memories and settings stay.");

      await user.click(within(dialog).getByRole('button', { name: 'Start over' }));

      await waitFor(() => expect(api.clears).toHaveLength(1));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await screen.findByTestId('coach-empty')).toBeInTheDocument();
      expect(screen.queryByText('Newest nudge')).not.toBeInTheDocument();
      expect(api.reads()).toBeGreaterThan(readsBefore);
    });

    it('cancel posts nothing and keeps the timeline', async () => {
      const api = clearableTimeline([nudge, reply, oldest]);
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Newest nudge');

      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: 'Start over' }));
      const dialog = await screen.findByRole('dialog', { name: 'Start a fresh conversation?' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(api.clears).toHaveLength(0);
      expect(screen.getByText('Newest nudge')).toBeInTheDocument();
    });

    it('keeps the dialog open with an error when the clear fails, and clears nothing on screen', async () => {
      server.use(
        http.get(`${API}/coach/messages`, () => HttpResponse.json({ data: { items: [nudge], nextCursor: null } })),
        http.post(`${API}/coach/chat/clear`, () => HttpResponse.json({ message: 'Coach unavailable' }, { status: 503 })),
      );
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Newest nudge');

      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: 'Start over' }));
      const dialog = await screen.findByRole('dialog', { name: 'Start a fresh conversation?' });
      await user.click(within(dialog).getByRole('button', { name: 'Start over' }));

      expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Newest nudge')).toBeInTheDocument();
    });

    it('is disabled while a chat turn streams', async () => {
      clearableTimeline([nudge, reply, oldest]);
      const chat = controlledChat();
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Oldest read nudge');
      expect(await screen.findByRole('button', { name: 'Conversation options' })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'How am I doing?' }));
      await waitFor(() => expect(chat.bodies).toHaveLength(1));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Conversation options' })).toBeDisabled());

      chat.push('delta', { text: 'All good.' });
      chat.push('done', {
        messageId: coachMessageId(40),
        userMessageId: coachMessageId(39),
        links: [],
        pausedUntil: null,
        fallback: false,
      });
      chat.close();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Conversation options' })).toBeEnabled());
    });

    it('has no axe violations with the confirm dialog open', async () => {
      clearableTimeline([nudge]);
      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Newest nudge');
      await openMenu(user);
      await user.click(screen.getByRole('menuitem', { name: 'Start over' }));
      await screen.findByRole('dialog', { name: 'Start a fresh conversation?' });
      const results = await axe(document.body, { rules: { 'color-contrast': { enabled: false } } });
      expect(results).toHaveNoViolations();
    });
  });

  it('has no axe violations with messages and the composer', async () => {
    messagesPages({ first: { items: [nudge, reply, oldest], nextCursor: null } });
    const { container } = renderPage();
    await screen.findByText('Newest nudge');
    await screen.findByTestId('coach-weekly-target');
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
