import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen } from '../../utils/test-utils';
import { MeasurementTile } from '../../../components/health/MeasurementTile';

const NOW = new Date(2026, 8, 29, 12, 0);

describe('MeasurementTile', () => {
  it('shows the label as a heading, the value with its unit, the date and the method chip', () => {
    render(
      <MeasurementTile
        label="Weight"
        value="208.4"
        unit="lb"
        takenAt={new Date(2026, 8, 26, 8, 0).toISOString()}
        method="Smart scale"
        onLog={vi.fn()}
        logLabel="Log weight"
        now={NOW}
      />,
    );
    const region = screen.getByRole('region', { name: 'Weight' });
    expect(screen.getByRole('heading', { level: 2, name: 'Weight' })).toBeInTheDocument();
    expect(region).toHaveTextContent('208.4 lb');
    expect(screen.getByText('3 days ago')).toBeInTheDocument();
    expect(screen.getByText('Smart scale')).toBeInTheDocument();
  });

  it('shows "No data yet" and a Log button when empty', async () => {
    const onLog = vi.fn();
    render(<MeasurementTile label="Waist" onLog={onLog} logLabel="Log waist" />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Log waist' }));
    expect(onLog).toHaveBeenCalledTimes(1);
  });

  it('renders a neutral delta with spoken text', () => {
    render(
      <MeasurementTile
        label="Weight"
        value="208.4"
        unit="lb"
        delta={{ direction: 'up', text: '+0.4 lb', spoken: 'up 0.4 pounds since previous reading' }}
      />,
    );
    expect(screen.getByText('+0.4 lb')).toBeInTheDocument();
    expect(screen.getByText('up 0.4 pounds since previous reading')).toBeInTheDocument();
    expect(screen.getByText('+0.4 lb').closest('p')).toHaveClass('MuiTypography-body2');
  });

  it('shows "no change"', () => {
    render(
      <MeasurementTile
        label="Weight"
        value="80.0"
        unit="kg"
        delta={{ direction: 'none', text: 'no change', spoken: 'no change since previous reading' }}
      />,
    );
    expect(screen.getByText('no change')).toBeInTheDocument();
  });

  it('writes a percentage without a space', () => {
    render(<MeasurementTile label="Body fat" value="27.8" unit="%" />);
    expect(screen.getByRole('region', { name: 'Body fat' })).toHaveTextContent('27.8%');
  });

  it('disables the Log button without permission and explains why', async () => {
    const onLog = vi.fn();
    render(<MeasurementTile label="Weight" onLog={onLog} canLog={false} logLabel="Log weight" />);
    const button = screen.getByRole('button', { name: 'Log weight' });
    expect(button).toBeDisabled();
    await userEvent.setup().hover(button.parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent("You don't have permission to log health data");
  });

  it('has no Log button without onLog', () => {
    render(<MeasurementTile label="BMI" value="24.1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <MeasurementTile
        label="Weight"
        value="208.4"
        unit="lb"
        takenAt={NOW.toISOString()}
        method="Scale"
        delta={{ direction: 'down', text: '-0.5 lb', spoken: 'down 0.5 pounds since previous reading' }}
        onLog={vi.fn()}
        canLog={false}
        logLabel="Log weight"
        now={NOW}
      />,
    );
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
