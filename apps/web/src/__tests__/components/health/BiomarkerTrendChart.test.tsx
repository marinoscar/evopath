/**
 * The biomarker trend chart (H5, #189): a render smoke test of the
 * per-result reference band. jsdom has no layout, so the chart gets an
 * explicit width; the band geometry itself is unit-tested in
 * `utils/biomarkers.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '../../utils/test-utils';
import { BiomarkerTrendChart } from '../../../components/health/biomarkers/BiomarkerTrendChart';
import { labSeriesPoint, mockLdlSeries } from '../../mocks/fixtures/biomarkers';

describe('BiomarkerTrendChart', () => {
  it('draws one band step per result with a range, each at its own limits', () => {
    render(<BiomarkerTrendChart label="LDL cholesterol" unit="mg/dL" decimals={0} points={mockLdlSeries.points} width={800} />);

    const chart = screen.getByRole('img', { name: /^LDL cholesterol, 4 results, latest 142 mg\/dL/ });
    expect(chart).toHaveAccessibleName(/lowest 120 mg\/dL, highest 142 mg\/dL/);
    expect(chart).toHaveAccessibleName(/shaded band is the reference range/);

    const steps = screen.getAllByTestId('reference-band-step');
    // Four results, one without a range: three steps.
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => [s.getAttribute('data-low'), s.getAttribute('data-high')])).toEqual([
      ['0', '130'],
      ['0', '130'],
      ['', '100'],
    ]);

    const geometry = steps.map((s) => ({
      x: Number(s.getAttribute('x')),
      y: Number(s.getAttribute('y')),
      width: Number(s.getAttribute('width')),
      height: Number(s.getAttribute('height')),
    }));
    for (const g of geometry) {
      expect(g.width).toBeGreaterThan(0);
      expect(g.height).toBeGreaterThan(0);
    }
    // The same range draws the same band; the tighter range of the last lab a different one.
    expect(geometry[1].y).toBeCloseTo(geometry[0].y, 5);
    expect(geometry[1].height).toBeCloseTo(geometry[0].height, 5);
    expect(geometry[2].y).toBeGreaterThan(geometry[0].y);
    // Steps follow each other in time, with a gap where the result had no range.
    expect(geometry[1].x).toBeCloseTo(geometry[0].x + geometry[0].width, 5);
    expect(geometry[2].x).toBeGreaterThan(geometry[1].x + geometry[1].width);
  });

  it('draws no band when no result has a range', () => {
    render(
      <BiomarkerTrendChart
        label="TSH"
        unit="mIU/L"
        decimals={2}
        points={[labSeriesPoint('2026-09-15T12:00:00.000Z', 2.1)]}
        width={600}
      />,
    );
    expect(screen.getByRole('img', { name: 'TSH, 1 result, latest 2.10 mIU/L on Sep 15, 2026, 12:00 PM' }));
    expect(screen.queryAllByTestId('reference-band-step')).toHaveLength(0);
  });
});
