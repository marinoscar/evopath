/**
 * `LabReportDialog` and "Needs attention" (#317), over the stateful MSW lab
 * intake: the issues route is read with the duplicate check and again when a
 * result changes, its issues badge the rows, the save hint and the "Not saved
 * yet" panel offer "Show rows that need attention" (the review's filter), and
 * each reason of a refused apply links to its row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within, mockUser, type MockUser } from '../../utils/test-utils';
import { LAB_REPORT_TITLE, LabReportDialog, SHOW_ATTENTION_LABEL } from '../../../components/health/LabReportDialog';
import { clearPhotoUrlCache } from '../../../components/intake/StoragePhotoThumb';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import {
  defaultLabIssues,
  labIntake,
  labIntakeApi,
  labItem,
  labValue,
  panelItems,
  type LabIntakeApiOptions,
} from '../../mocks/fixtures/labReportIntake';

const reader: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'],
};

const PHOTOS = [
  { id: 'p-1', storageObjectId: 'obj-1', name: 'report.pdf', sortOrder: 0, healthDocumentId: 'doc-1', retention: 'keep' as const },
];

/** The panel with a BUN/creatinine ratio printed as "SEE NOTE" (an analyte, no number). */
function intakeWithNoValue() {
  const items = [
    ...panelItems(),
    labItem(labValue({ analyteKey: 'creatinine', nameAsPrinted: 'BUN/Creatinine Ratio', value: null, valueText: 'SEE NOTE', panel: 'cmp' })),
  ];
  return labIntake('ready', { items, photos: PHOTOS, context: { collectionDate: '2026-09-15', labName: null } });
}

function setup(options: LabIntakeApiOptions = {}) {
  const api = labIntakeApi({ existing: [intakeWithNoValue()], ...options });
  const user = userEvent.setup();
  render(<LabReportDialog open onClose={vi.fn()} onSaved={vi.fn()} pollIntervalMs={10} />, {
    wrapperOptions: { user: reader, aiEnabled: true },
  });
  return { api, user };
}

const dialog = () => screen.getByRole('dialog', { name: LAB_REPORT_TITLE });
const rowFor = (printed: string) => {
  const row = screen.getAllByTestId('lab-result-row').find((candidate) => candidate.textContent?.includes(printed));
  if (!row) throw new Error(`No row for ${printed}`);
  return row;
};
const chip = (label: RegExp) => within(screen.getByRole('group', { name: 'Show only' })).getByRole('button', { name: label });
const saveButton = () => within(dialog()).getByRole('button', { name: /Save to Health|Saving/ });

beforeEach(() => {
  resetMeasurementCatalogCache();
  clearPhotoUrlCache();
});

describe('LabReportDialog: needs attention (#317)', () => {
  it('reads the issues with the duplicate check, badges the rows, and re-reads after a change', async () => {
    const { api, user } = setup();
    await screen.findByTestId('lab-report-review');
    await waitFor(() => expect(within(rowFor('BUN/Creatinine Ratio')).getByTestId('lab-result-attention-badge')).toBeInTheDocument());
    expect(api.requests.some((request) => request.path === '/api/measurements/lab-reports/lab-intake-1/issues')).toBe(true);
    expect(within(rowFor('Lipoprotein (a)')).getByRole('button', { name: /^Needs attention: / })).toBeInTheDocument();
    expect(within(rowFor('HDL Cholesterol')).queryByTestId('lab-result-attention-badge')).toBeNull();

    await user.click(within(rowFor('BUN/Creatinine Ratio')).getByRole('button', { name: /^Needs attention/ }));
    expect(within(rowFor('BUN/Creatinine Ratio')).getByTestId('lab-result-attention-reasons')).toHaveTextContent(
      'BUN/Creatinine Ratio has no numeric value; enter one or reject it',
    );

    const checks = api.issueChecks;
    await user.click(within(rowFor('BUN/Creatinine Ratio')).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.issueChecks).toBeGreaterThan(checks));
  });

  it('the save hint shows the rows that need attention', async () => {
    const { user } = setup();
    await screen.findByTestId('lab-report-review');
    const show = await screen.findByRole('button', { name: `${SHOW_ATTENTION_LABEL} (2)` });
    await user.click(show);
    await waitFor(() => expect(chip(/^Needs attention/)).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getAllByTestId('lab-result-row').map((row) => row.textContent?.includes('Lipoprotein (a)') || row.textContent?.includes('BUN'))).toEqual([
      true,
      true,
    ]);
  });

  it('says a result the server flags needs attention once the catalog is clear', async () => {
    const intake = intakeWithNoValue();
    intake.items = intake.items.filter((item) => item.value.analyteKey !== null);
    setup({ existing: [intake] });
    await screen.findByTestId('lab-report-review');
    await waitFor(() =>
      expect(screen.getByTestId('lab-report-save-hint')).toHaveTextContent('1 result needs attention before saving: fix or reject it'),
    );
  });

  it('links each reason of a refused save to its row, and shows the rows that need attention', async () => {
    const intake = intakeWithNoValue();
    // Every result accepted and mapped; the server still refuses glucose and the ratio.
    intake.items = intake.items.filter((item) => item.value.analyteKey !== null).map((item) => ({ ...item, status: 'accepted' as const }));
    const glucose = intake.items.find((item) => item.value.nameAsPrinted === 'Glucose')!;
    const ratio = intake.items.find((item) => item.value.nameAsPrinted === 'BUN/Creatinine Ratio')!;
    const outOfRange = 'Fasting glucose is outside what a lab can report; check the value or reject it';
    const noValue = 'BUN/Creatinine Ratio has no numeric value; enter one or reject it';
    const { user } = setup({
      existing: [intake],
      issues: (current) => [
        ...defaultLabIssues(current),
        { itemId: glucose.id, issues: [{ code: 'OUT_OF_RANGE', field: 'value', message: outOfRange }] },
      ],
      applyIssues: () => [
        { path: `items.${glucose.id}.value.value`, message: outOfRange },
        { path: `items.${ratio.id}.value.value`, message: noValue },
      ],
    });
    await screen.findByTestId('lab-report-review');
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());

    const panel = await screen.findByTestId('lab-report-apply-issues');
    expect(panel).toHaveTextContent('Not saved yet');
    const links = within(panel).getAllByTestId('lab-report-apply-issue-link');
    expect(links.map((link) => link.textContent)).toEqual([outOfRange, noValue]);

    // A search hiding the row is cleared when its reason is followed.
    const search = screen.getByRole('textbox', { name: 'Search results' });
    await user.type(search, 'hdl');
    await waitFor(() => expect(screen.getAllByTestId('lab-result-row')).toHaveLength(1));
    await user.click(within(panel).getByRole('button', { name: outOfRange }));
    await waitFor(() => expect(rowFor('Glucose')).toHaveAttribute('data-highlighted', 'true'));
    expect(search).toHaveValue('');
    expect(within(rowFor('Glucose')).getByRole('button', { name: /^Needs attention/ })).toHaveAttribute('aria-expanded', 'true');
    expect(rowFor('Glucose')).toHaveFocus();

    await user.click(within(panel).getByRole('button', { name: SHOW_ATTENTION_LABEL }));
    await waitFor(() => expect(chip(/^Needs attention \(2\)/)).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getAllByTestId('lab-result-row')).toHaveLength(2);
  });
});
