import { describe, it, expect } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, within } from '../utils/test-utils';
import GymsPage from '../../pages/GymsPage';
import { comingInLabel } from '../../config/roadmap';

const SECTION_TITLES = ['My gyms', 'Equipment', 'Photos', 'Nearby'];
const NOTE =
  'Add gyms and equipment by hand any time. Photo recognition and location are optional.';

describe('GymsPage', () => {
  it('renders the h1', () => {
    render(<GymsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Gyms' })).toBeInTheDocument();
  });

  it('renders the roadmap chip', () => {
    render(<GymsPage />);
    expect(screen.getByText(comingInLabel('gyms'))).toBeInTheDocument();
  });

  it('renders every section heading and the note', () => {
    render(<GymsPage />);
    for (const name of SECTION_TITLES) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('has no links, buttons or progressbars', () => {
    render(<GymsPage />);
    const main = screen.queryByRole('main') ?? document.body;
    expect(within(main).queryAllByRole('link')).toHaveLength(0);
    expect(within(main).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<GymsPage />);
    // jsdom cannot resolve colour contrast.
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
