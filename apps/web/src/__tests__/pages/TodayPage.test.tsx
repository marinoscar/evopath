import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, mockUser } from '../utils/test-utils';
import TodayPage from '../../pages/TodayPage';
import { comingInLabel } from '../../config/roadmap';

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
    expect(screen.getAllByText(comingInLabel('health'))).toHaveLength(2);
    expect(screen.getByText('Coming in E5')).toBeInTheDocument();
    expect(screen.getByText('Coming in E3')).toBeInTheDocument();
    for (const card of CARDS) {
      const links = screen.getAllByRole('link', { name: card.link });
      expect(links.some((l) => l.getAttribute('href') === card.href)).toBe(true);
    }
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
});
