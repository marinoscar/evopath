import { describe, it, expect } from 'vitest';
import { render, screen } from '../../utils/test-utils';
import { TodayCard } from '../../../components/today/TodayCard';
import { TODAY_CARDS, type TodayCardDef } from '../../../config/todayCards';
import { comingInLabel } from '../../../config/roadmap';

const base = TODAY_CARDS[0];

describe('TodayCard', () => {
  it('renders the placeholder, chip and link when there is no Content', () => {
    render(<TodayCard def={base} />);
    const region = screen.getByRole('region', { name: base.title });
    expect(region).toBeInTheDocument();
    expect(screen.getByText(base.description)).toBeInTheDocument();
    expect(screen.getByText(comingInLabel(base.area))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: base.linkLabel })).toHaveAttribute('href', base.to);
  });

  it('renders Content instead of the placeholder and chip', () => {
    const def: TodayCardDef = { ...base, Content: () => <p>Real content</p> };
    render(<TodayCard def={def} />);
    expect(screen.getByText('Real content')).toBeInTheDocument();
    expect(screen.queryByText(base.description)).toBeNull();
    expect(screen.queryByText(comingInLabel(base.area))).toBeNull();
    expect(screen.getByRole('link', { name: base.linkLabel })).toBeInTheDocument();
  });
});
