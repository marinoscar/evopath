import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '../../utils/test-utils';
import { LatestMeasurementTiles } from '../../../components/health/LatestMeasurementTiles';
import type { LatestItem } from '../../../services/health';
import { mockLatest, mockLatestEmpty, mockMeasurement, mockMetricCatalog } from '../../mocks/fixtures/measurements';

const NOW = new Date(2026, 8, 29, 12, 0);
const today = new Date(2026, 8, 29, 8, 0).toISOString();
const threeDaysAgo = new Date(2026, 8, 26, 8, 0).toISOString();

function renderTiles(items: LatestItem[], overrides: Partial<Parameters<typeof LatestMeasurementTiles>[0]> = {}) {
  const onLog = vi.fn();
  render(
    <LatestMeasurementTiles
      catalog={mockMetricCatalog}
      items={items}
      unitSystem="imperial"
      heightMm={1778}
      canLog
      onLog={onLog}
      now={NOW}
      {...overrides}
    />,
  );
  return { onLog };
}

const tile = (name: string) => screen.getByRole('region', { name });

describe('LatestMeasurementTiles', () => {
  it('shows five empty tiles with a Log button each and no BMI tile', () => {
    renderTiles(mockLatestEmpty);
    const names = ['Weight', 'Body fat', 'Waist', 'Blood pressure', 'Resting heart rate'];
    expect(screen.getAllByRole('region').map((r) => r.querySelector('h2')?.textContent)).toEqual(names);
    for (const name of names) {
      expect(within(tile(name)).getByText('No data yet')).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button', { name: /^Log / })).toHaveLength(5);
    expect(screen.queryByRole('region', { name: 'BMI' })).toBeNull();
  });

  it('converts to the user unit, dates the reading and hides the unspecified method', () => {
    renderTiles(mockLatest({ weight: { latest: mockMeasurement('weight', 94.5327, { measuredAt: today }) } }));
    const weight = tile('Weight');
    expect(weight).toHaveTextContent('208.4 lb');
    expect(within(weight).getByText('Today')).toBeInTheDocument();
    expect(within(weight).queryByText('Not specified')).toBeNull();
    expect(within(weight).queryByText(/since previous reading/)).toBeNull();
  });

  it('shows the method chip and the delta against the previous reading', () => {
    renderTiles(
      mockLatest({
        body_fat_pct: {
          latest: mockMeasurement('body_fat_pct', 27.8, { method: 'smart_scale', measuredAt: today }),
          previous: mockMeasurement('body_fat_pct', 28.3, { measuredAt: threeDaysAgo }),
        },
        weight: {
          latest: mockMeasurement('weight', 94.2987),
          previous: mockMeasurement('weight', 94.5327),
        },
      }),
    );
    const fat = tile('Body fat');
    expect(within(fat).getByText('Smart scale')).toBeInTheDocument();
    expect(within(fat).getByText('-0.5%')).toBeInTheDocument();
    expect(within(fat).getByText('down 0.5 percentage points since previous reading')).toBeInTheDocument();
    expect(within(tile('Weight')).getByText('-0.5 lb')).toBeInTheDocument();
  });

  it('says "no change" for equal values', () => {
    renderTiles(
      mockLatest({
        resting_hr: { latest: mockMeasurement('resting_hr', 58), previous: mockMeasurement('resting_hr', 58) },
      }),
    );
    expect(within(tile('Resting heart rate')).getByText('no change')).toBeInTheDocument();
  });

  it('combines a blood-pressure pair from one entry into 128/84', () => {
    const entryId = 'bp-entry';
    renderTiles(
      mockLatest({
        bp_systolic: { latest: mockMeasurement('bp_systolic', 128, { entryId, measuredAt: today }) },
        bp_diastolic: { latest: mockMeasurement('bp_diastolic', 84, { entryId, measuredAt: today }) },
      }),
    );
    expect(tile('Blood pressure')).toHaveTextContent('128/84 mmHg');
    expect(within(tile('Blood pressure')).getByText('Today')).toBeInTheDocument();
  });

  it('shows each blood-pressure value with its own date when they come from different entries', () => {
    renderTiles(
      mockLatest({
        bp_systolic: { latest: mockMeasurement('bp_systolic', 128, { entryId: 'a', measuredAt: today }) },
        bp_diastolic: { latest: mockMeasurement('bp_diastolic', 84, { entryId: 'b', measuredAt: threeDaysAgo }) },
      }),
    );
    const bp = tile('Blood pressure');
    expect(bp).toHaveTextContent('Systolic 128 mmHg · Today');
    expect(bp).toHaveTextContent('Diastolic 84 mmHg · 3 days ago');
  });

  it('shows a calculated BMI with weight and height', () => {
    renderTiles(mockLatest({ weight: { latest: mockMeasurement('weight', 76.2) } }));
    const bmiTile = tile('BMI');
    expect(bmiTile).toHaveTextContent('24.1');
    expect(within(bmiTile).getByText('Calculated from weight and height')).toBeInTheDocument();
    expect(within(bmiTile).getByText('Calculated')).toBeInTheDocument();
    expect(within(bmiTile).queryByRole('button')).toBeNull();
  });

  it('offers "Add your height" when height is missing', () => {
    renderTiles(mockLatest({ weight: { latest: mockMeasurement('weight', 76.2) } }), { heightMm: null });
    expect(within(tile('BMI')).getByRole('link', { name: 'Add your height' })).toHaveAttribute(
      'href',
      '/settings/health-profile',
    );
  });

  it('asks to log the metric of the tile', async () => {
    const { onLog } = renderTiles(mockLatestEmpty);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Log body fat' }));
    await user.click(screen.getByRole('button', { name: 'Log blood pressure' }));
    expect(onLog.mock.calls).toEqual([['body_fat_pct'], ['bp_systolic']]);
  });

  it('disables every Log button without write permission', () => {
    renderTiles(mockLatestEmpty, { canLog: false });
    for (const button of screen.getAllByRole('button', { name: /^Log / })) {
      expect(button).toBeDisabled();
    }
  });

  it('shows metric units for a metric user', () => {
    renderTiles(mockLatest({ waist_circumference: { latest: mockMeasurement('waist_circumference', 84) } }), {
      unitSystem: 'metric',
    });
    expect(tile('Waist')).toHaveTextContent('84.0 cm');
  });
});
