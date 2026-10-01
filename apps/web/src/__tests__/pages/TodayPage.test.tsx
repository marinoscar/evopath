import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, mockUser, within } from '../utils/test-utils';
import TodayPage from '../../pages/TodayPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { comingInLabel } from '../../config/roadmap';
import { coachMessageId, mockCoachMessage } from '../mocks/fixtures/coach';

const CARDS = [
  { title: "Today's workout", area: 'programs', link: 'Open Train', href: '/train' },
  { title: 'Readiness', area: 'health', link: 'Open Health', href: '/health' },
  { title: 'Body snapshot', area: 'health', link: 'Open Health', href: '/health' },
  { title: 'Your gym', area: 'gyms', link: 'Open Gyms', href: '/gyms' },
] as const;

describe('TodayPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the h1 and the long local date', () => {
    render(<TodayPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument();
    expect(screen.getByText(/Tuesday/)).toBeInTheDocument();
    expect(screen.getByText(/September/)).toBeInTheDocument();
  });

  it('renders exactly four regions in order', () => {
    render(<TodayPage />);
    const regions = screen.getAllByRole('region');
    expect(regions.map((r) => r.getAttribute('aria-labelledby'))).toHaveLength(4);
    expect(regions.map((r) => r.querySelector('h2')?.textContent)).toEqual(
      CARDS.map((c) => c.title)
    );
  });

  it('shows each chip and link', () => {
    render(<TodayPage />);
    for (const card of CARDS) {
      expect(screen.getByRole('region', { name: card.title })).toBeInTheDocument();
    }
    // Readiness (#56) and Body snapshot (#53) have `Content`, so no health chip.
    expect(screen.queryAllByText(comingInLabel('health'))).toHaveLength(0);
    expect(
      within(screen.getByRole('region', { name: 'Readiness' })).queryByText(comingInLabel('health')),
    ).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Body snapshot' })).queryByText(comingInLabel('health')),
    ).toBeNull();
    // Today's workout (E4.6) has `Content`, so no chip on it either.
    expect(screen.queryByText(comingInLabel('programs'))).toBeNull();
    expect(screen.queryByText(/Coming in/)).toBeNull();
    // Your gym (E3.3) has `Content`, so no gyms chip.
    expect(screen.queryByText(comingInLabel('gyms'))).toBeNull();
    for (const card of CARDS) {
      const links = screen.getAllByRole('link', { name: card.link });
      expect(links.some((l) => l.getAttribute('href') === card.href)).toBe(true);
    }
  });

  it('renders the body snapshot content (#53): the empty state and the Open Health link', async () => {
    render(<TodayPage />);
    const body = screen.getByRole('region', { name: 'Body snapshot' });
    expect(
      await within(body).findByRole('button', { name: 'Log your first weight' }),
    ).toBeInTheDocument();
    expect(within(body).getByRole('link', { name: 'Open Health' })).toHaveAttribute('href', '/health');
  });

  it('renders the readiness content (#56): the check-in prompt and the Open Health link', async () => {
    render(<TodayPage />);
    const readiness = screen.getByRole('region', { name: 'Readiness' });
    expect(await within(readiness).findByText('How are you feeling today? Takes a few seconds.')).toBeInTheDocument();
    expect(within(readiness).getByRole('button', { name: 'Check in' })).toBeInTheDocument();
    expect(within(readiness).getByRole('link', { name: 'Open Health' })).toHaveAttribute('href', '/health');
  });

  it('renders the gym content (E3.3): "Add your gym" and the Open Gyms link', async () => {
    render(<TodayPage />);
    const gym = screen.getByRole('region', { name: 'Your gym' });
    expect(await within(gym).findByRole('link', { name: 'Add your gym' })).toHaveAttribute('href', '/gyms/new');
    expect(within(gym).getByRole('link', { name: 'Open Gyms' })).toHaveAttribute('href', '/gyms');
  });

  it('renders the workout content (E4.6): Start workout, the empty state and the Open Train link', async () => {
    render(<TodayPage />);
    const workout = screen.getByRole('region', { name: "Today's workout" });
    expect(await within(workout).findByRole('button', { name: 'Start workout' })).toBeInTheDocument();
    expect(within(workout).getByText('No workouts yet.')).toBeInTheDocument();
    expect(within(workout).getByRole('link', { name: 'Open Train' })).toHaveAttribute('href', '/train');
  });

  it('keeps the other cards when the workout summary fails (E4.6)', async () => {
    server.use(
      http.get('*/api/workouts/summary', () =>
        HttpResponse.json({ statusCode: 500, message: 'Boom', error: 'Internal Server Error' }, { status: 500 }),
      ),
    );
    render(<TodayPage />);
    const workout = screen.getByRole('region', { name: "Today's workout" });
    expect(await within(workout).findByText("Couldn't load training")).toBeInTheDocument();
    expect(within(workout).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    const readiness = screen.getByRole('region', { name: 'Readiness' });
    expect(await within(readiness).findByRole('button', { name: 'Check in' })).toBeInTheDocument();
    const body = screen.getByRole('region', { name: 'Body snapshot' });
    expect(await within(body).findByRole('button', { name: 'Log your first weight' })).toBeInTheDocument();
    const gym = screen.getByRole('region', { name: 'Your gym' });
    expect(await within(gym).findByRole('link', { name: 'Add your gym' })).toBeInTheDocument();
  });

  it('greets by first name', () => {
    render(<TodayPage />, {
      wrapperOptions: { user: { ...mockUser, displayName: '  Test User ' } },
    });
    expect(screen.getByText(/Hello, Test$/)).toBeInTheDocument();
  });

  it.each([null, '   '])('omits the greeting for displayName %j', (displayName) => {
    render(<TodayPage />, { wrapperOptions: { user: { ...mockUser, displayName } } });
    expect(screen.queryByText(/Hello/)).toBeNull();
  });

  it('shows no old Home text', () => {
    render(<TodayPage />);
    expect(screen.queryByText(/Welcome back/)).toBeNull();
    expect(screen.queryByText(/Quick Actions/)).toBeNull();
    expect(screen.queryByText(/Your dashboard overview/)).toBeNull();
  });

  it('has no axe violations', async () => {
    vi.useRealTimers();
    const { container } = render(<TodayPage />);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });

  /** E7.8 (#248): the CoachHero strip and the appended, gated coach card. */
  describe('coach (E7.8)', () => {
    it('shows neither the hero nor the coach card with AI off', async () => {
      render(<TodayPage />, { wrapperOptions: { aiEnabled: false } });
      expect(screen.getAllByRole('region').map((r) => r.querySelector('h2')?.textContent)).toEqual(
        CARDS.map((c) => c.title),
      );
      expect(screen.queryByRole('region', { name: 'Coach' })).toBeNull();
      expect(screen.queryByTestId('coach-hero')).toBeNull();
    });

    it('appends the Coach card last with AI on and ai:use, with its state and Open Coach link', async () => {
      render(<TodayPage />, { wrapperOptions: { aiEnabled: true } });
      const regions = screen.getAllByRole('region').filter((r) => r.querySelector('h2'));
      expect(regions.map((r) => r.querySelector('h2')?.textContent)).toEqual([
        ...CARDS.map((c) => c.title),
        'Coach',
      ]);
      const coach = screen.getByRole('region', { name: 'Coach' });
      expect(await within(coach).findByTestId('today-coach-target')).toHaveTextContent('2 of 3 this week');
      expect(within(coach).getByRole('link', { name: 'Open Coach' })).toHaveAttribute('href', '/coach');
    });

    it('hides the Coach card from a user without ai:use', () => {
      render(<TodayPage />, {
        wrapperOptions: {
          aiEnabled: true,
          user: { ...mockUser, permissions: mockUser.permissions.filter((p) => p !== 'ai:use') },
        },
      });
      expect(screen.queryByRole('region', { name: 'Coach' })).toBeNull();
    });

    it('shows the CoachHero above the cards with the latest unread line and Reply', async () => {
      server.use(
        http.get('*/api/coach/messages', () =>
          HttpResponse.json({
            data: {
              items: [mockCoachMessage({ id: coachMessageId(3), openedAt: null, kind: 'chat', title: '', body: 'Ready for today?' })],
              nextCursor: null,
            },
          }),
        ),
      );
      render(<TodayPage />, { wrapperOptions: { aiEnabled: true } });
      const hero = await screen.findByTestId('coach-hero');
      expect(within(hero).getByText('Ready for today?')).toBeInTheDocument();
      expect(within(hero).getByRole('link', { name: 'Reply' })).toHaveAttribute('href', `/coach?m=${coachMessageId(3)}`);
      const firstCard = screen.getByRole('region', { name: "Today's workout" });
      expect(hero.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  /** #268: the appended Goals card, gated on `goals:read`. */
  describe('goals (#268)', () => {
    it('hides the Goals card without goals:read', () => {
      render(<TodayPage />);
      expect(screen.queryByRole('region', { name: 'Goals' })).toBeNull();
    });

    it('appends the Goals card last with goals:read, with "Set a goal" and Open Goals', async () => {
      render(<TodayPage />, {
        wrapperOptions: { user: { ...mockUser, permissions: [...mockUser.permissions, 'goals:read', 'goals:write'] } },
      });
      const regions = screen.getAllByRole('region').filter((r) => r.querySelector('h2'));
      expect(regions.map((r) => r.querySelector('h2')?.textContent)).toEqual([...CARDS.map((c) => c.title), 'Goals']);
      const goals = screen.getByRole('region', { name: 'Goals' });
      expect(await within(goals).findByRole('link', { name: 'Set a goal' })).toHaveAttribute('href', '/train/goals');
      expect(within(goals).getByRole('link', { name: 'Open Goals' })).toHaveAttribute('href', '/train/goals');
    });
  });
});
