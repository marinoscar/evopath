/**
 * `/coach` memory notices (#325): a `memory` frame on the chat stream shows
 * "Memory updated: …" under the reply with Manage and, for an add or a delete,
 * an Undo that reverses it through `/api/memories`.
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
import { coachMessageId, coachSseBody } from '../mocks/fixtures/coach';
import { mockMemory } from '../mocks/fixtures/memories';

const API = '*/api';

const done: [string, unknown] = [
  'done',
  { messageId: coachMessageId(901), userMessageId: coachMessageId(900), links: [], pausedUntil: null, fallback: false },
];

function chatWith(frames: Array<[string, unknown]>) {
  server.use(
    http.post(`${API}/coach/chat/stream`, () =>
      new HttpResponse(coachSseBody(frames), { headers: { 'Content-Type': 'text/event-stream' } }),
    ),
  );
}

function recordMemoryWrites() {
  const calls: Array<{ method: string; path: string }> = [];
  server.use(
    http.delete(`${API}/memories/:id`, ({ request }) => {
      calls.push({ method: 'DELETE', path: new URL(request.url).pathname });
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/memories/:id/restore`, ({ request, params }) => {
      calls.push({ method: 'POST', path: new URL(request.url).pathname });
      return HttpResponse.json({ data: mockMemory({ id: String(params.id) }) });
    }),
  );
  return calls;
}

async function sendMessage(text: string) {
  const user = userEvent.setup();
  const result = render(<CoachPage />, { wrapperOptions: { route: '/coach', aiEnabled: true } });
  const field = await screen.findByRole('textbox', { name: 'Message your coach' });
  await user.type(field, `${text}{Enter}`);
  return { user, ...result };
}

describe('CoachPage: memory notices (#325)', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "Memory updated" with Manage, and Undo of an add deletes the memory', async () => {
    chatWith([
      ['delta', { text: 'Got it, I will remember.' }],
      ['memory', { op: 'added', memoryId: 'mem-1', content: 'Trains before work' }],
      done,
    ]);
    const calls = recordMemoryWrites();
    const { user } = await sendMessage('Remember I train before work');

    const notices = await screen.findByTestId('coach-memory-updates');
    expect(within(notices).getByText('Memory updated: Trains before work')).toBeInTheDocument();
    expect(within(notices).getByRole('link', { name: 'Manage' })).toHaveAttribute('href', '/settings/memory');

    await user.click(within(notices).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'DELETE', path: '/api/memories/mem-1' }]));
    await waitFor(() => expect(screen.queryByTestId('coach-memory-updates')).not.toBeInTheDocument());
    expect(await screen.findByText('Memory change undone')).toBeInTheDocument();
  });

  it('Undo of a delete restores the memory', async () => {
    chatWith([['memory', { op: 'deleted', memoryId: 'mem-2', content: 'Knee pain' }], done]);
    const calls = recordMemoryWrites();
    const { user } = await sendMessage('Forget my knee pain');
    const notices = await screen.findByTestId('coach-memory-updates');
    expect(within(notices).getByText('Memory removed: Knee pain')).toBeInTheDocument();
    await user.click(within(notices).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/memories/mem-2/restore' }]));
  });

  it('an update offers only Manage, no Undo', async () => {
    chatWith([['memory', { op: 'updated', memoryId: 'mem-3', content: 'Prefers evenings' }], done]);
    await sendMessage('Actually I prefer evenings');
    const notices = await screen.findByTestId('coach-memory-updates');
    expect(within(notices).getByText('Memory updated: Prefers evenings')).toBeInTheDocument();
    expect(within(notices).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(within(notices).getByRole('link', { name: 'Manage' })).toBeInTheDocument();
  });

  it('shows a refused undo inline', async () => {
    chatWith([['memory', { op: 'added', memoryId: 'mem-4', content: 'Likes rowing' }], done]);
    server.use(http.delete(`${API}/memories/:id`, () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })));
    const { user } = await sendMessage('Remember I like rowing');
    const notices = await screen.findByTestId('coach-memory-updates');
    await user.click(within(notices).getByRole('button', { name: 'Undo' }));
    expect(await within(notices).findByRole('alert')).toHaveTextContent(/no longer exists/);
  });

  it('ignores malformed memory frames and unknown frames; the reply still lands', async () => {
    chatWith([
      ['memory', { op: 'nope' }],
      ['glitter', { x: 1 }],
      ['delta', { text: 'All good.' }],
      done,
    ]);
    await sendMessage('Hi');
    expect(await screen.findByText('All good.')).toBeInTheDocument();
    expect(screen.queryByTestId('coach-memory-updates')).not.toBeInTheDocument();
  });

  it('has no axe violations with a notice shown', async () => {
    chatWith([['memory', { op: 'added', memoryId: 'mem-5', content: 'Trains before work' }], done]);
    const { container } = await sendMessage('Remember I train before work');
    await screen.findByTestId('coach-memory-updates');
    expect(await axe(container)).toHaveNoViolations();
  });
});
