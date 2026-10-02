/**
 * The lab report review under the lab unit preference (#234): canonical
 * drafts are SHOWN in the preferred unit with their ranges, the review says
 * which unit system it uses, a newly chosen analyte pre-selects the preferred
 * unit, and an edit is sent in whatever unit the user picks. Conventional is
 * the default and leaves the output as it was. #307: the map picker calls
 * `onMapItem` when given, else edits the one result. #308: the already-saved
 * badge with Skip and Save again.
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '../../utils/test-utils';
import { LabReportReview, alreadySavedLabel } from '../../../components/health/LabReportReview';
import type { LabUnits } from '../../../utils/labUnits';
import { labItem, labValue, mockLabCatalog } from '../../mocks/fixtures/labReportIntake';

const glucose = () =>
  labItem(
    labValue({
      analyteKey: 'fasting_glucose',
      nameAsPrinted: 'Glucose',
      value: 97.2973,
      unit: 'mg/dL',
      originalValue: 5.4,
      originalUnit: 'mmol/L',
      referenceLow: 70.2703,
      referenceHigh: 99.0991,
      panel: 'glycemic',
    }),
    { sourcePhotoIds: [] },
  );

const hba1c = () =>
  labItem(
    labValue({ analyteKey: 'hba1c', nameAsPrinted: 'Hemoglobin A1c', value: 6.5, unit: '%', referenceHigh: 5.6, panel: 'glycemic' }),
    { sourcePhotoIds: [] },
  );

function renderReview(labUnits?: LabUnits) {
  const onAddItem = vi.fn();
  const onEditItem = vi.fn();
  const user = userEvent.setup();
  render(
    <LabReportReview
      items={[glucose(), hba1c()]}
      photos={[]}
      catalog={mockLabCatalog}
      {...(labUnits ? { labUnits } : {})}
      onAcceptItem={vi.fn()}
      onRejectItem={vi.fn()}
      onRestoreItem={vi.fn()}
      onEditItem={onEditItem}
      onAddItem={onAddItem}
      onAcceptAll={vi.fn()}
      onAcceptHighConfidence={vi.fn()}
    />,
  );
  return { user, onAddItem, onEditItem };
}

function rowFor(name: string): HTMLElement {
  return screen.getAllByTestId('lab-result-row').find((row) => row.textContent?.includes(name))!;
}

describe('LabReportReview: lab units', () => {
  it('by default shows canonical values as before and says so', () => {
    renderReview();
    expect(screen.getByTestId('lab-units-note')).toHaveTextContent('Values in US conventional units');
    const row = rowFor('Glucose');
    expect(within(row).getByTestId('lab-result-number')).toHaveTextContent('97.2973 mg/dL');
    expect(row).toHaveTextContent('Range 70.2703–99.0991');
    expect(within(rowFor('Hemoglobin A1c')).getByTestId('lab-result-number')).toHaveTextContent('6.5%');
  });

  it('under SI shows values and ranges in SI units, keeping what the report printed', () => {
    renderReview('si');
    expect(screen.getByTestId('lab-units-note')).toHaveTextContent('Values in SI units');
    const row = rowFor('Glucose');
    expect(within(row).getByTestId('lab-result-number')).toHaveTextContent('5.4 mmol/L');
    expect(row).toHaveTextContent('Range 3.9–5.5');
    expect(within(row).getByTestId('lab-result-original')).toHaveTextContent('Printed 5.4 mmol/L');
    // An affine conversion: (6.5 − 2.15) × 10.929 = 47.54, shown with 0 decimals.
    const a1c = rowFor('Hemoglobin A1c');
    expect(within(a1c).getByTestId('lab-result-number')).toHaveTextContent('48 mmol/mol');
    expect(a1c).toHaveTextContent('Range ≤ 38');
  });

  it('"Add missing value" pre-selects the SI unit and sends the value in it', async () => {
    const { user, onAddItem } = renderReview('si');
    await user.click(screen.getByRole('button', { name: 'Add missing value' }));
    const add = screen.getByTestId('lab-result-add');
    await user.type(within(add).getByRole('combobox', { name: 'Analyte' }), 'LDL');
    await user.click(await screen.findByRole('option', { name: /^LDL cholesterol/ }));
    expect(within(add).getByRole('combobox', { name: 'Unit' })).toHaveTextContent('mmol/L');
    await user.type(within(add).getByRole('textbox', { name: 'Value' }), '3.21');
    await user.click(within(add).getByRole('button', { name: 'Add' }));
    expect(onAddItem).toHaveBeenCalledWith(expect.objectContaining({ analyteKey: 'ldl_cholesterol', value: 3.21, unit: 'mmol/L' }));
  });

  it('the user can still pick the conventional unit; the edit is sent in it', async () => {
    const { user, onAddItem } = renderReview('si');
    await user.click(screen.getByRole('button', { name: 'Add missing value' }));
    const add = screen.getByTestId('lab-result-add');
    await user.type(within(add).getByRole('combobox', { name: 'Analyte' }), 'LDL');
    await user.click(await screen.findByRole('option', { name: /^LDL cholesterol/ }));
    await user.click(within(add).getByRole('combobox', { name: 'Unit' }));
    await user.click(await screen.findByRole('option', { name: 'mg/dL' }));
    await user.type(within(add).getByRole('textbox', { name: 'Value' }), '124');
    await user.click(within(add).getByRole('button', { name: 'Add' }));
    expect(onAddItem).toHaveBeenCalledWith(expect.objectContaining({ analyteKey: 'ldl_cholesterol', value: 124, unit: 'mg/dL' }));
  });

  it('conventional pre-selects the canonical unit', async () => {
    const { user } = renderReview();
    await user.click(screen.getByRole('button', { name: 'Add missing value' }));
    const add = screen.getByTestId('lab-result-add');
    await user.type(within(add).getByRole('combobox', { name: 'Analyte' }), 'LDL');
    await user.click(await screen.findByRole('option', { name: /^LDL cholesterol/ }));
    expect(within(add).getByRole('combobox', { name: 'Unit' })).toHaveTextContent('mg/dL');
  });
});

describe('LabReportReview: map an unmatched result (#307)', () => {
  const unmatched = () =>
    labItem(labValue({ nameAsPrinted: 'Chol/HDL Ratio', value: 3.9, unit: null, panel: 'lipids', match: 'unmatched' }), {
      sourcePhotoIds: [],
    });
  const handlers = () => ({
    onAcceptItem: vi.fn(),
    onRejectItem: vi.fn(),
    onRestoreItem: vi.fn(),
    onEditItem: vi.fn(),
    onAddItem: vi.fn(),
    onAcceptAll: vi.fn(),
    onAcceptHighConfidence: vi.fn(),
  });
  const pick = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByRole('combobox', { name: 'Map “Chol/HDL Ratio” to an analyte' }), 'TC/HDL');
    await user.click(await screen.findByRole('option', { name: /Cholesterol\/HDL ratio/ }));
  };

  it('calls onMapItem with the item and the analyte, not an edit', async () => {
    const item = unmatched();
    const props = handlers();
    const onMapItem = vi.fn();
    const user = userEvent.setup();
    render(<LabReportReview items={[item]} photos={[]} catalog={mockLabCatalog} {...props} onMapItem={onMapItem} />);
    await pick(user);
    expect(onMapItem).toHaveBeenCalledWith(item.id, 'chol_hdl_ratio');
    expect(props.onEditItem).not.toHaveBeenCalled();
  });

  it('without onMapItem, the map is an edit of the one result', async () => {
    const item = unmatched();
    const props = handlers();
    const user = userEvent.setup();
    render(<LabReportReview items={[item]} photos={[]} catalog={mockLabCatalog} {...props} />);
    await pick(user);
    expect(props.onEditItem).toHaveBeenCalledWith(item.id, expect.objectContaining({ analyteKey: 'chol_hdl_ratio' }));
  });
});

describe('LabReportReview: already-saved results (#308)', () => {
  const handlers = () => ({
    onAcceptItem: vi.fn(),
    onRejectItem: vi.fn(),
    onRestoreItem: vi.fn(),
    onEditItem: vi.fn(),
    onAddItem: vi.fn(),
    onAcceptAll: vi.fn(),
    onAcceptHighConfidence: vi.fn(),
  });

  it('labels the badge with text, and only on non-rejected duplicate rows', async () => {
    const dup = glucose();
    const rejected = labItem(labValue({ analyteKey: 'hba1c', nameAsPrinted: 'A1c', value: 6, unit: '%', panel: 'glycemic' }), {
      status: 'rejected',
      sourcePhotoIds: [],
    });
    const onSkipDuplicate = vi.fn();
    const onKeepDuplicate = vi.fn();
    const user = userEvent.setup();
    render(
      <LabReportReview
        items={[dup, hba1c(), rejected]}
        photos={[]}
        catalog={mockLabCatalog}
        {...handlers()}
        duplicateDates={new Map([[dup.id, '2025-11-19'], [rejected.id, null]])}
        onSkipDuplicate={onSkipDuplicate}
        onKeepDuplicate={onKeepDuplicate}
      />,
    );
    const badges = screen.getAllByTestId('lab-result-already-saved');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Already saved · Nov 19, 2025');
    expect(rowFor('Glucose')).toHaveAttribute('data-duplicate', 'true');
    expect(rowFor('Hemoglobin A1c')).toHaveAttribute('data-duplicate', 'false');

    await user.click(screen.getByRole('button', { name: 'Skip Glucose' }));
    expect(onSkipDuplicate).toHaveBeenCalledWith(dup.id);
    const again = screen.getByRole('button', { name: 'Save again Glucose' });
    expect(again).toHaveAttribute('aria-pressed', 'false');
    await user.click(again);
    expect(onKeepDuplicate).toHaveBeenCalledWith(dup.id);
  });

  it('shows a kept duplicate as pressed, saying it will be saved again', () => {
    const dup = glucose();
    render(
      <LabReportReview
        items={[dup]}
        photos={[]}
        catalog={mockLabCatalog}
        {...handlers()}
        duplicateDates={new Map([[dup.id, null]])}
        keptDuplicateIds={new Set([dup.id])}
        onSkipDuplicate={vi.fn()}
        onKeepDuplicate={vi.fn()}
      />,
    );
    expect(screen.getByTestId('lab-result-already-saved')).toHaveTextContent('Already saved · will be saved again');
    expect(screen.getByRole('button', { name: 'Save again Glucose' })).toHaveAttribute('aria-pressed', 'true');
    expect(alreadySavedLabel(null)).toBe('Already saved');
  });
});
