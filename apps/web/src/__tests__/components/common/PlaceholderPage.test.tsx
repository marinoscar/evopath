import { describe, it, expect } from 'vitest';
import FitnessCenterIcon from '@mui/icons-material/FitnessCenter';
import TimelineIcon from '@mui/icons-material/Timeline';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen } from '../../utils/test-utils';
import { PlaceholderPage } from '../../../components/common/PlaceholderPage';

const sections = [
  { title: 'Log a workout', description: 'Record sets and reps.', Icon: FitnessCenterIcon },
  { title: 'History', description: 'See past sessions.', Icon: TimelineIcon },
];

const baseProps = {
  title: 'Train',
  subtitle: 'Where you log your training.',
  area: 'programs' as const,
  sections,
};

describe('PlaceholderPage', () => {
  it('renders exactly one h1 with the title', () => {
    render(<PlaceholderPage {...baseProps} />);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Train');
  });

  it('renders the subtitle and the coming-in chip', () => {
    render(<PlaceholderPage {...baseProps} />);
    expect(screen.getByText('Where you log your training.')).toBeInTheDocument();
    expect(screen.getByText('Coming in E5')).toBeInTheDocument();
  });

  it('renders one heading per section', () => {
    render(<PlaceholderPage {...baseProps} />);
    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s.map((h) => h.textContent)).toEqual(['Log a workout', 'History']);
  });

  it('renders the note only when given', () => {
    const { rerender } = render(<PlaceholderPage {...baseProps} />);
    expect(screen.queryByText('Manual entry always works.')).toBeNull();
    rerender(<PlaceholderPage {...baseProps} note="Manual entry always works." />);
    expect(screen.getByText('Manual entry always works.')).toBeInTheDocument();
  });

  it('renders header and chip without crashing when sections is empty', () => {
    render(<PlaceholderPage {...baseProps} sections={[]} />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Coming in E5')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });

  it('has no axe violations', async () => {
    const { container } = render(<PlaceholderPage {...baseProps} note="A note." />);
    // jsdom cannot resolve colour contrast.
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
