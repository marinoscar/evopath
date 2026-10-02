/**
 * The lab report review for a multi-date (trend) report (#305): results
 * grouped by the date they are saved on, newest first, the undated group last;
 * the bulk actions ("Accept all", "Accept high confidence", "Add missing
 * value") above the list; each row's date; and the editor's date field.
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, within } from '../../utils/test-utils';
import { ACCEPT_HIGH_CONFIDENCE_LABEL, LabReportReview } from '../../../components/health/LabReportReview';
import type { DraftItemView } from '../../../services/intake';
import type { LabReportValue } from '../../../services/labReport';
import { labItem, labValue, mockLabCatalog } from '../../mocks/fixtures/labReportIntake';

const glucose = (date: string | null, value: number, extra: Partial<DraftItemView<LabReportValue>> = {}) =>
  labItem(
    labValue({ analyteKey: 'fasting_glucose', nameAsPrinted: 'Glucose Lvl', value, unit: 'mg/dL', panel: 'glycemic', collectionDate: date }),
    { sourcePhotoIds: [], ...extra },
  );
const cholesterol = (date: string | null, value: number, extra: Partial<DraftItemView<LabReportValue>> = {}) =>
  labItem(
    labValue({ analyteKey: 'total_cholesterol', nameAsPrinted: 'Cholesterol', value, unit: 'mg/dL', panel: 'lipids', collectionDate: date }),
    { sourcePhotoIds: [], ...extra },
  );

function renderReview(items: DraftItemView<LabReportValue>[], reportDate: string | null = null) {
  const handlers = {
    onAcceptItem: vi.fn(),
    onRejectItem: vi.fn(),
    onRestoreItem: vi.fn(),
    onEditItem: vi.fn(),
    onAddItem: vi.fn(),
    onAcceptAll: vi.fn(),
    onAcceptHighConfidence: vi.fn(),
  };
  const user = userEvent.setup();
  render(<LabReportReview items={items} photos={[]} catalog={mockLabCatalog} reportDate={reportDate} {...handlers} />);
  return { user, ...handlers };
}

describe('LabReportReview: dates and bulk actions (#305)', () => {
  it('groups results by date, newest first, then by panel, with the undated group last', () => {
    renderReview([
      glucose('2023-04-06', 92),
      cholesterol('2025-11-19', 190),
      glucose('2025-11-19', 97),
      glucose(null, 101),
    ]);
    const groups = screen.getAllByTestId('lab-date-group');
    expect(groups.map((group) => group.getAttribute('data-date'))).toEqual(['2025-11-19', '2023-04-06', '']);
    expect(within(groups[0]).getByRole('heading', { level: 3, name: 'Nov 19, 2025 · 2 results' })).toBeInTheDocument();
    expect(within(groups[0]).getAllByTestId('lab-panel').map((panel) => panel.getAttribute('data-panel'))).toEqual([
      'lipids',
      'glycemic',
    ]);
    expect(within(groups[1]).getByRole('heading', { level: 3, name: 'Apr 6, 2023 · 1 result' })).toBeInTheDocument();
    expect(within(groups[2]).getByRole('heading', { level: 3 })).toHaveTextContent('No date · 1 result, saved with today’s date');
  });

  it('puts results without their own date under the report date, and says so on the row', () => {
    renderReview([glucose('2025-11-19', 97), glucose(null, 101)], '2025-11-19');
    const groups = screen.getAllByTestId('lab-date-group');
    expect(groups).toHaveLength(1);
    const dates = within(groups[0]).getAllByTestId('lab-result-date').map((node) => node.textContent);
    expect(dates).toEqual(['Nov 19, 2025', 'Report date (Nov 19, 2025)']);
  });

  it('shows the bulk actions above the first group', () => {
    renderReview([glucose('2025-11-19', 97)]);
    const toolbar = screen.getByTestId('lab-review-toolbar');
    const firstGroup = screen.getAllByTestId('lab-date-group')[0];
    expect(toolbar.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: /Accept all/ })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /Accept high confidence/ })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Add missing value' })).toBeInTheDocument();
  });

  it('"Accept high confidence" counts pending, high-confidence, sure results and calls its handler', async () => {
    const { user, onAcceptHighConfidence, onAcceptAll } = renderReview([
      glucose('2025-11-19', 97),
      glucose('2024-05-01', 95),
      glucose('2023-04-06', 92, { confidence: 'low' }),
      cholesterol('2025-11-19', 190, { uncertain: true, uncertaintyNote: 'Smudged' }),
      cholesterol('2024-05-01', 180, { status: 'accepted' }),
    ]);
    await user.click(screen.getByRole('button', { name: `${ACCEPT_HIGH_CONFIDENCE_LABEL} (2)` }));
    expect(onAcceptHighConfidence).toHaveBeenCalledTimes(1);
    expect(onAcceptAll).not.toHaveBeenCalled();

    // "Accept all" still asks first when a pending result has low confidence.
    await user.click(screen.getByRole('button', { name: 'Accept all (4)' }));
    const confirm = await screen.findByRole('dialog', { name: 'Accept all 4 results?' });
    await user.click(within(confirm).getByRole('button', { name: 'Accept all' }));
    expect(onAcceptAll).toHaveBeenCalledTimes(1);
  });

  it('disables "Accept high confidence" when no result qualifies', () => {
    renderReview([glucose('2025-11-19', 97, { confidence: 'medium' })]);
    expect(screen.getByRole('button', { name: `${ACCEPT_HIGH_CONFIDENCE_LABEL} (0)` })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Accept all (1)' })).toBeEnabled();
  });

  it('edits a result’s date, and clearing it sends null', async () => {
    const { user, onEditItem } = renderReview([glucose('2025-11-19', 97)]);
    const row = screen.getByTestId('lab-result-row');

    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const field = within(row).getByLabelText('Date collected');
    expect(field).toHaveValue('2025-11-19');
    expect(field).toHaveAttribute('max', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    fireEvent.change(field, { target: { value: '2025-11-18' } });
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(onEditItem).toHaveBeenLastCalledWith(row.getAttribute('data-item-id'), expect.objectContaining({ collectionDate: '2025-11-18' }));

    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(row).getByLabelText('Date collected'), { target: { value: '' } });
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(onEditItem).toHaveBeenLastCalledWith(row.getAttribute('data-item-id'), expect.objectContaining({ collectionDate: null }));
  });
});
