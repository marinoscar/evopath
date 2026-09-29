import { describe, it, expect } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, within } from '../utils/test-utils';
import HealthPage from '../../pages/HealthPage';
import { comingInLabel } from '../../config/roadmap';

const SECTION_TITLES = ['Body', 'Vitals', 'Daily check-in', 'Trends'];
const NOTE = 'Log a value by hand or from a photo of your scale. Nothing is required.';

describe('HealthPage', () => {
  it('renders the h1', () => {
    render(<HealthPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Health' })).toBeInTheDocument();
  });

  it('renders the roadmap chip', () => {
    render(<HealthPage />);
    expect(screen.getByText(comingInLabel('health'))).toBeInTheDocument();
  });

  it('renders every section heading and the note', () => {
    render(<HealthPage />);
    for (const name of SECTION_TITLES) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('has no links, buttons or progressbars', () => {
    render(<HealthPage />);
    const main = screen.queryByRole('main') ?? document.body;
    expect(within(main).queryAllByRole('link')).toHaveLength(0);
    expect(within(main).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<HealthPage />);
    // jsdom cannot resolve colour contrast.
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
