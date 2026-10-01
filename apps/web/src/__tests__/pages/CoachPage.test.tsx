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
import { server } from '../mocks/server';
import CoachPage from '../../pages/CoachPage';
import { coachMessageId, coachSseBody, mockCoachMessage } from '../mocks/fixtures/coach';
import { SPEECH_OBJECT_ID } from '../mocks/fixtures/ai';
import type { CoachTimelineItem } from '../../services/coach';

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

    it('marks each unread coach message opened exactly once, and never a read one or a user turn', async () => {
      messagesPages({ first: { items: [nudge, reply, oldest], nextCursor: null } });
      const opened = recordPosts('opened');
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => expect(opened.map((c) => c.id)).toEqual([nudge.id]));
      // Re-rendering the bubble (feedback) does not post again.
      await user.click(screen.getAllByRole('button', { name: 'Helpful' })[0]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(opened).toHaveLength(1);
    });

    it('tolerates the opened route answering 404 (E7.5 not deployed) without any error on screen', async () => {
      messagesPages({ first: { items: [nudge], nextCursor: null } });
      const opened = recordPosts('opened', 404);
      renderPage();
      await waitFor(() => expect(opened).toHaveLength(1));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
