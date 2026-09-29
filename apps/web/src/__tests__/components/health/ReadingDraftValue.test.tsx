/**
 * The `body_metric_reading` value view and editor (issue #64, E2.6), and the
 * provenance readers in `services/health.ts`. Units, methods and bounds come
 * from the catalog fixture (the API's registry), never a copy.
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { render, screen, within } from '../../utils/test-utils';
import {
  ReadingEditor,
  boundsInUnit,
  emptyReading,
  readingMethodLabel,
  readingProblem,
  readingText,
} from '../../../components/health/ReadingDraftValue';
import {
  isUnreadableResult,
  photoSourceRef,
  type BodyMetricReadingValue,
} from '../../../services/health';
import { catalogMetric, mockMetricCatalog } from '../../mocks/fixtures/measurements';

describe('readingText', () => {
  it('reads as the device showed it, naming the pressure pair', () => {
    expect(readingText({ metricKey: 'weight', value: 208.4, unit: 'lb' }, mockMetricCatalog)).toBe('Weight 208.4 lb');
    expect(readingText({ metricKey: 'bp_systolic', value: 128, unit: 'mmHg' }, mockMetricCatalog)).toBe(
      'Blood pressure: systolic 128 mmHg',
    );
    expect(readingText({ metricKey: 'bp_diastolic', value: 84, unit: 'mmHg' }, mockMetricCatalog)).toBe(
      'Blood pressure: diastolic 84 mmHg',
    );
    expect(readingText({ metricKey: 'body_fat_pct', value: 27.8, unit: '%' }, mockMetricCatalog)).toBe('Body fat 27.8%');
    expect(readingText({ metricKey: 'weight', value: Number.NaN, unit: 'kg' }, mockMetricCatalog)).toBe('Weight — kg');
  });

  it('names the method from the catalog, and none for unspecified', () => {
    expect(readingMethodLabel({ metricKey: 'weight', value: 1, unit: 'kg', method: 'smart_scale' }, mockMetricCatalog)).toBe(
      'Smart scale',
    );
    expect(readingMethodLabel({ metricKey: 'weight', value: 1, unit: 'kg', method: 'unspecified' }, mockMetricCatalog)).toBeNull();
    expect(readingMethodLabel({ metricKey: 'weight', value: 1, unit: 'kg' }, mockMetricCatalog)).toBeNull();
  });
});

describe('bounds and problems', () => {
  it('converts the catalog bounds into the device unit, rounded inward', () => {
    expect(boundsInUnit(catalogMetric('weight'), 'kg')).toEqual({ min: 20, max: 500 });
    expect(boundsInUnit(catalogMetric('weight'), 'lb')).toEqual({ min: 44.1, max: 1102.3 });
    expect(boundsInUnit(catalogMetric('weight'), 'stone')).toBeNull();
  });

  it('explains a missing number, a foreign unit and an out-of-range value', () => {
    const v = (value: number, unit = 'kg'): BodyMetricReadingValue => ({ metricKey: 'weight', value, unit });
    expect(readingProblem(v(Number.NaN), mockMetricCatalog)).toBe('Enter a number');
    expect(readingProblem(v(80, 'mmHg'), mockMetricCatalog)).toBe('Choose a unit');
    expect(readingProblem(v(9999), mockMetricCatalog)).toBe('Enter a value between 20 and 500 kg');
    expect(readingProblem(v(80), mockMetricCatalog)).toBeNull();
  });

  it('starts Add missing item as a weight in the profile unit', () => {
    expect(emptyReading(mockMetricCatalog, 'imperial')).toMatchObject({ metricKey: 'weight', unit: 'lb' });
    expect(emptyReading(mockMetricCatalog, 'metric')).toMatchObject({ metricKey: 'weight', unit: 'kg' });
  });
});

describe('ReadingEditor', () => {
  function Harness({ initial, spy }: { initial: BodyMetricReadingValue; spy: (v: BodyMetricReadingValue) => void }) {
    const [value, setValue] = useState(initial);
    return (
      <ReadingEditor
        value={value}
        onChange={(next) => {
          spy(next);
          setValue(next);
        }}
        catalog={mockMetricCatalog}
        unitSystem="metric"
      />
    );
  }

  it('switching metric keeps an allowed unit/method and replaces the rest from the catalog', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ metricKey: 'weight', value: 80, unit: 'kg', method: 'scale' }} spy={spy} />);

    await user.click(screen.getByRole('combobox', { name: 'Measurement' }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: catalogMetric('bp_systolic').label }));
    expect(spy).toHaveBeenLastCalledWith({ metricKey: 'bp_systolic', value: 80, unit: 'mmHg' });

    await user.click(screen.getByRole('combobox', { name: 'Method' }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Blood-pressure cuff' }));
    expect(spy).toHaveBeenLastCalledWith({ metricKey: 'bp_systolic', value: 80, unit: 'mmHg', method: 'bp_cuff' });

    await user.click(screen.getByRole('combobox', { name: 'Method' }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Not specified' }));
    expect(spy).toHaveBeenLastCalledWith({ metricKey: 'bp_systolic', value: 80, unit: 'mmHg' });
  });

  it('offers only the metric catalog units and parses a comma decimal', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ metricKey: 'weight', value: 80, unit: 'kg' }} spy={spy} />);

    await user.click(screen.getByRole('combobox', { name: 'Unit' }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(catalogMetric('weight').units.map((u) => u.label));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'lb' }));

    const value = screen.getByRole('textbox', { name: 'Value' });
    await user.clear(value);
    await user.type(value, '176,5');
    expect(spy).toHaveBeenLastCalledWith({ metricKey: 'weight', value: 176.5, unit: 'lb' });
  });
});

describe('photo provenance readers', () => {
  const row = (sourceRef: Record<string, unknown> | null) => ({ sourceRef });

  it('photoSourceRef reads a photo intake ref, defaulting userEdited to false', () => {
    expect(photoSourceRef(row(null))).toBeNull();
    expect(photoSourceRef(row({ kind: 'other', intakeId: 'x' }))).toBeNull();
    expect(photoSourceRef(row({ kind: 'photo_intake' }))).toBeNull();
    expect(photoSourceRef(row({ kind: 'photo_intake', intakeId: 'i-1' }))).toEqual({
      kind: 'photo_intake',
      intakeId: 'i-1',
      storageObjectIds: undefined,
      userEdited: false,
    });
    expect(
      photoSourceRef(row({ kind: 'photo_intake', intakeId: 'i-1', storageObjectIds: ['a', 3, 'b'], userEdited: true })),
    ).toMatchObject({ storageObjectIds: ['a', 'b'], userEdited: true });
  });

  it('isUnreadableResult is true only for resultMeta.unreadable === true', () => {
    expect(isUnreadableResult(null)).toBe(false);
    expect(isUnreadableResult({ unreadable: false })).toBe(false);
    expect(isUnreadableResult({ unreadable: 'yes' })).toBe(false);
    expect(isUnreadableResult({ unreadable: true, promptVersion: 1 })).toBe(true);
  });
});
