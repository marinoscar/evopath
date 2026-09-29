import { describe, it, expect } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, within } from '../utils/test-utils';
import TrainPage from '../../pages/TrainPage';
import { comingInLabel } from '../../config/roadmap';

const SECTION_TITLES = ["Today's session", 'Programs', 'Log and history', 'Quick workouts'];
const NOTE =
  'Every workout can be planned and logged by hand. Photos and AI drafts will be optional helpers.';

describe('TrainPage', () => {
  it('renders the h1', () => {
    render(<TrainPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Train' })).toBeInTheDocument();
  });

  it('renders the roadmap chip', () => {
    render(<TrainPage />);
    expect(screen.getByText(comingInLabel('workouts'))).toBeInTheDocument();
  });

  it('renders every section heading and the note', () => {
    render(<TrainPage />);
    for (const name of SECTION_TITLES) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('has no links, buttons or progressbars', () => {
    render(<TrainPage />);
    const main = screen.queryByRole('main') ?? document.body;
    expect(within(main).queryAllByRole('link')).toHaveLength(0);
    expect(within(main).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<TrainPage />);
    // jsdom cannot resolve colour contrast.
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
