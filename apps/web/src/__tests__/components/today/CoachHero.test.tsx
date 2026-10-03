/**
 * `CoachHero` (E7.8, #248): the latest unread coach line and a Reply button
 * to `/coach`, and nothing at all when the coach is hidden or nothing is unread.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { CoachHero, latestUnreadCoachMessage } from '../../../components/today/CoachHero';
import { coachMessageId, mockCoachMessage } from '../../mocks/fixtures/coach';

const API = '*/api';

function messages(items: ReturnType<typeof mockCoachMessage>[]) {
  server.use(http.get(`${API}/coach/messages`, () => HttpResponse.json({ data: { items, nextCursor: null } })));
}

const unread = mockCoachMessage({ id: coachMessageId(7), openedAt: null, title: 'Streak at risk', body: 'One session saves it.' });

describe('CoachHero', () => {
  it('shows the latest unread coach line and a Reply link to that message', async () => {
    messages([
      mockCoachMessage({ id: coachMessageId(9), role: 'user', kind: 'chat', openedAt: null, body: 'mine' }),
      unread,
      mockCoachMessage({ id: coachMessageId(5), openedAt: null, body: 'older' }),
    ]);
    render(<CoachHero />, { wrapperOptions: { aiEnabled: true } });

    expect(await screen.findByTestId('coach-hero-line')).toHaveTextContent('Streak at risk: One session saves it.');
    expect(screen.getByRole('link', { name: 'Reply' })).toHaveAttribute('href', `/coach?m=${coachMessageId(7)}`);
    expect(screen.getByRole('region', { name: 'From your coach' })).toBeInTheDocument();
  });

  it('shows markdown as one plain line, without asterisks (#343)', async () => {
    messages([
      mockCoachMessage({
        id: coachMessageId(8),
        openedAt: null,
        kind: 'chat',
        title: '',
        body: 'You did **19 working sets**.\n\n- Squat\n- `Bench`',
      }),
    ]);
    render(<CoachHero />, { wrapperOptions: { aiEnabled: true } });
    const line = await screen.findByTestId('coach-hero-line');
    expect(line).toHaveTextContent('You did 19 working sets. Squat Bench');
    expect(line.textContent).not.toMatch(/[*`]/);
    expect(line).toHaveAttribute('title', 'You did 19 working sets. Squat Bench');
  });

  it('renders nothing when every coach message has been read', async () => {
    let called = false;
    server.use(
      http.get(`${API}/coach/messages`, () => {
        called = true;
        return HttpResponse.json({ data: { items: [mockCoachMessage()], nextCursor: null } });
      }),
    );
    render(<CoachHero />, { wrapperOptions: { aiEnabled: true } });
    await waitFor(() => expect(called).toBe(true));
    expect(screen.queryByTestId('coach-hero')).not.toBeInTheDocument();
  });

  it('renders nothing and fetches nothing with AI off', async () => {
    let called = false;
    server.use(
      http.get(`${API}/coach/messages`, () => {
        called = true;
        return HttpResponse.json({ data: { items: [unread], nextCursor: null } });
      }),
    );
    render(<CoachHero />, { wrapperOptions: { aiEnabled: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(called).toBe(false);
    expect(screen.queryByTestId('coach-hero')).not.toBeInTheDocument();
  });

  it('renders nothing without ai:use, even with AI on', async () => {
    messages([unread]);
    render(<CoachHero />, {
      wrapperOptions: { aiEnabled: true, user: { ...mockUser, permissions: mockUser.permissions.filter((p) => p !== 'ai:use') } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('coach-hero')).not.toBeInTheDocument();
  });

  it('stays quiet on a failed load', async () => {
    server.use(http.get(`${API}/coach/messages`, () => HttpResponse.json({ message: 'Boom' }, { status: 500 })));
    render(<CoachHero />, { wrapperOptions: { aiEnabled: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('coach-hero')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('picks the first unread coach message from a newest-first page', () => {
    expect(latestUnreadCoachMessage([])).toBeNull();
    expect(latestUnreadCoachMessage([unread])?.id).toBe(unread.id);
  });

  it('has no axe violations', async () => {
    messages([unread]);
    const { container } = render(<CoachHero />, { wrapperOptions: { aiEnabled: true } });
    await screen.findByTestId('coach-hero');
    expect(await axe(container)).toHaveNoViolations();
  });
});
