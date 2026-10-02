/**
 * `LabReportDialog` (H4, #188) over the intake kit and a stateful MSW
 * `/api/intakes` for the `lab_report` kind: the upload step with the
 * keep-or-delete choice, the review grouped by panel, highlighting, the
 * unmatched gate and mapping, edits, the report details, the duplicate
 * warning with "Save anyway", apply, and an axe pass on the review; #305: a
 * multi-date report, "Accept high confidence" and a save over several dates;
 * #307: mapping one result maps every same-named one, with the feedback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser, type MockUser } from '../../utils/test-utils';

vi.mock('../../../utils/downscaleImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/downscaleImage')>();
  return { ...actual, downscaleImage: vi.fn(async (file: File) => file) };
});

import {
  LAB_REPORT_HELPER_TEXT,
  LAB_REPORT_TITLE,
  LabReportDialog,
  SAVE_ANYWAY_LABEL,
} from '../../../components/health/LabReportDialog';
import { clearPhotoUrlCache } from '../../../components/intake/StoragePhotoThumb';
import { RETAIN_FILES_LABEL } from '../../../components/intake';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import {
  cholesterolDuplicate,
  labIntake,
  labIntakeApi,
  labItem,
  labValue,
  panelItems,
  type LabIntakeApiOptions,
} from '../../mocks/fixtures/labReportIntake';
import type { LabReportValue } from '../../../services/labReport';

const reader: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'],
};

const PHOTOS = [
  { id: 'p-1', storageObjectId: 'obj-1', name: 'report.pdf', sortOrder: 0, healthDocumentId: 'doc-1', retention: 'keep' as const },
];

/** A lab report intake already read (resumed), so the review renders at once. */
function readyIntake() {
  return labIntake('ready', {
    items: panelItems(),
    photos: PHOTOS,
    context: { collectionDate: '2026-09-15', labName: 'Acme Clinical Laboratories' },
  });
}

function setup(options: LabIntakeApiOptions = {}) {
  const api = labIntakeApi(options);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const user = userEvent.setup();
  const utils = render(<LabReportDialog open onClose={onClose} onSaved={onSaved} pollIntervalMs={10} />, {
    wrapperOptions: { user: reader, aiEnabled: true },
  });
  return { ...utils, api, onClose, onSaved, user };
}

const dialog = () => screen.getByRole('dialog', { name: LAB_REPORT_TITLE });
const rowFor = (printed: string) => {
  const row = screen
    .getAllByTestId('lab-result-row')
    .find((candidate) => within(candidate).queryAllByTestId('lab-result-value')[0]?.textContent?.startsWith(printed));
  if (!row) throw new Error(`No row for ${printed}`);
  return row;
};
const saveButton = () => within(dialog()).getByRole('button', { name: /Save to Health|Saving/ });

async function openReview(options: LabIntakeApiOptions = {}) {
  const ctx = setup({ existing: [readyIntake()], ...options });
  await screen.findByTestId('lab-report-review');
  return ctx;
}

beforeEach(() => {
  resetMeasurementCatalogCache();
  clearPhotoUrlCache();
});

describe('LabReportDialog: upload and read', () => {
  it('starts a lab_report intake that keeps files by default, takes PDFs, and reads into a review', async () => {
    const { api, user } = setup();

    await screen.findByText(LAB_REPORT_HELPER_TEXT);
    expect(api.created).toEqual([{ kind: 'lab_report', retainFiles: true }]);
    expect(api.requests[0].path).toBe('/api/intakes?kind=lab_report&status=draft%2Cscanning%2Cready&limit=1');

    // The keep-or-delete control is shown for this health kind, checked.
    expect(screen.getByRole('checkbox', { name: RETAIN_FILES_LABEL })).toBeChecked();
    expect(screen.getByLabelText('Add photos or PDFs')).toHaveAttribute('accept', 'image/*,application/pdf');
    expect(screen.getByTestId('ai-vision-disclosure')).toHaveTextContent('openai');

    await user.upload(
      screen.getByLabelText('Add photos or PDFs'),
      new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' }),
    );
    await waitFor(() => expect(screen.getByTestId('intake-photo-tile')).toHaveAttribute('data-stage', 'ready'));
    const read = within(dialog()).getByRole('button', { name: 'Read' });
    await waitFor(() => expect(read).toBeEnabled());
    await user.click(read);

    expect(await screen.findByTestId('lab-report-review')).toBeInTheDocument();
    expect(screen.getAllByTestId('lab-result-row')).toHaveLength(7);
    expect(screen.getByRole('textbox', { name: 'Laboratory' })).toHaveValue('Acme Clinical Laboratories');
    expect(screen.getByLabelText('Report date')).toHaveValue('2026-09-15');
  });
});

describe('LabReportDialog: review', () => {
  it('groups the results by panel, in panel order', async () => {
    await openReview();
    const panels = screen.getAllByTestId('lab-panel');
    expect(panels.map((panel) => panel.getAttribute('data-panel'))).toEqual(['lipids', 'glycemic']);
    expect(within(panels[0]).getByRole('heading', { name: 'Lipids (5)' })).toBeInTheDocument();
    expect(within(panels[1]).getByRole('heading', { name: 'Glycemic (2)' })).toBeInTheDocument();
    expect(within(panels[0]).getAllByTestId('lab-result-row')).toHaveLength(5);
    expect(within(panels[1]).getByText('Glucose')).toBeInTheDocument();
  });

  it('shows the matched analyte, the converted value with the printed one, the range and the flag', async () => {
    await openReview();
    const glucose = rowFor('Glucose');
    expect(within(glucose).getByTestId('lab-result-number')).toHaveTextContent('97.2973 mg/dL');
    expect(glucose).toHaveTextContent('Saved as Fasting glucose');
    expect(within(glucose).getByTestId('lab-result-original')).toHaveTextContent('Printed 5.4 mmol/L');
    expect(glucose).toHaveTextContent('Range 70.2703–99.0991');

    const cholesterol = rowFor('Cholesterol, Total');
    expect(within(cholesterol).getByText('Flag: High')).toBeInTheDocument();
    expect(within(cholesterol).queryByTestId('lab-result-original')).not.toBeInTheDocument();
  });

  it('highlights the unmatched row with the reason and leaves plain matches unhighlighted', async () => {
    await openReview();
    const lpa = rowFor('Lipoprotein (a)');
    expect(lpa).toHaveAttribute('data-attention', 'true');
    expect(lpa).toHaveAttribute('data-unresolved', 'true');
    expect(within(lpa).getByText('Not in catalog')).toBeInTheDocument();
    expect(within(lpa).getByTestId('draft-item-uncertainty')).toHaveTextContent('Not in the lab catalog');
    expect(rowFor('HDL Cholesterol')).toHaveAttribute('data-attention', 'false');
  });

  it('keeps Save disabled with the reason while a result is unmatched; mapping it resolves the row and saving works', async () => {
    const { api, user, onSaved, onClose } = await openReview();

    await user.click(within(dialog()).getByRole('button', { name: 'Accept all (7)' }));
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Accept all (0)' })).toBeDisabled());
    expect(saveButton()).toBeDisabled();
    expect(screen.getByTestId('lab-report-save-hint')).toHaveTextContent(
      '1 result is not in the lab catalog: map it to an analyte or reject it before saving',
    );

    // Map it through the searchable picker (an alias finds the analyte).
    const picker = within(rowFor('Lipoprotein (a)')).getByRole('combobox', { name: 'Map “Lipoprotein (a)” to an analyte' });
    await user.type(picker, 'apo b');
    await user.click(await screen.findByRole('option', { name: /Apolipoprotein B/ }));

    // #307: the map route, not an item PATCH; one result mapped needs no extra message.
    await waitFor(() => expect(api.maps).toHaveLength(1));
    expect(api.maps[0]).toMatchObject({ analyteKey: 'apob', mapped: [api.maps[0].itemId], skipped: [] });
    expect(api.requests.find((request) => request.path.endsWith('/map'))?.body).toEqual({
      itemId: rowFor('Lipoprotein (a)').getAttribute('data-item-id'),
      analyteKey: 'apob',
    });
    expect(api.itemPatches).toHaveLength(0);
    expect(screen.queryByTestId('lab-report-map-notice')).not.toBeInTheDocument();

    await waitFor(() => expect(rowFor('Lipoprotein (a)')).toHaveAttribute('data-unresolved', 'false'));
    expect(within(rowFor('Lipoprotein (a)')).getByText('Mapped by you')).toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(api.applied).toBe(0);

    await user.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.applied).toBe(1);
    expect(onSaved.mock.calls[0][0]).toMatchObject({ entryId: 'entry-lab-1', measuredAtSource: 'collection_date', documentDate: '2026-09-15' });
    expect(onSaved.mock.calls[0][0].items).toHaveLength(7);
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText('Saved 7 lab results to Health')).toBeInTheDocument();
  });

  it('rejecting the unmatched row also unblocks Save', async () => {
    const { user } = await openReview();
    await user.click(within(rowFor('Lipoprotein (a)')).getByRole('button', { name: 'Reject' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Accept all (6)' }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.getByTestId('lab-report-save-hint')).toHaveTextContent('6 results will be saved');
    expect(screen.getByText('Rejected (1)')).toBeInTheDocument();
  });

  it('Edit sends a PATCH with the new value and the row shows what the AI said', async () => {
    const { api, user } = await openReview();
    const hdl = rowFor('HDL Cholesterol');
    await user.click(within(hdl).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByTestId('lab-result-editor');
    const value = within(editor).getByRole('textbox', { name: 'Value' });
    await user.clear(value);
    await user.type(value, '50');
    await user.click(within(hdl).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.itemPatches).toHaveLength(1));
    expect(api.itemPatches[0].body).toMatchObject({
      value: { analyteKey: 'hdl_cholesterol', value: 50, unit: 'mg/dL', referenceLow: 39 },
    });
    await waitFor(() => expect(within(rowFor('HDL Cholesterol')).getAllByTestId('lab-result-number')[0]).toHaveTextContent('50 mg/dL'));
    expect(within(rowFor('HDL Cholesterol')).getByTestId('draft-item-ai-said')).toHaveTextContent('48 mg/dL');
  });

  it("shows the server's field message when an edit is refused", async () => {
    const message = 'unit must be one of mg/dL, mmol/L for HDL cholesterol';
    const { user } = await openReview({
      itemPatchError: {
        status: 400,
        body: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: [{ path: 'value.unit', message }] } },
      },
    });
    const hdl = rowFor('HDL Cholesterol');
    await user.click(within(hdl).getByRole('button', { name: 'Edit' }));
    await user.click(within(hdl).getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('lab-report-write-issues')).toHaveTextContent(message);
  });

  it('"Add missing value" posts a result for the chosen analyte', async () => {
    const { api, user } = await openReview();
    await user.click(screen.getByRole('button', { name: 'Add missing value' }));
    const add = screen.getByTestId('lab-result-add');
    expect(within(add).getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.type(within(add).getByRole('combobox', { name: 'Analyte' }), 'TSH');
    await user.click(await screen.findByRole('option', { name: /^TSH/ }));
    await user.type(within(add).getByRole('textbox', { name: 'Value' }), '2.1');
    await user.click(within(add).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.itemPosts).toHaveLength(1));
    expect(api.itemPosts[0]).toMatchObject({ kind: 'result', value: { analyteKey: 'tsh', value: 2.1, unit: 'mIU/L' } });
    await waitFor(() => expect(screen.getAllByTestId('lab-panel').map((p) => p.getAttribute('data-panel'))).toContain('thyroid'));
  });

  it('saves a corrected lab name as the intake context', async () => {
    const { api, user } = await openReview();
    const lab = screen.getByRole('textbox', { name: 'Laboratory' });
    await user.clear(lab);
    await user.type(lab, 'Beta Labs');
    await user.tab();
    await waitFor(() => expect(api.intakePatches).toHaveLength(1));
    expect(api.intakePatches[0].body).toEqual({ context: { collectionDate: '2026-09-15', labName: 'Beta Labs' } });
  });

  it('warns about duplicates before saving and saves only after an explicit "Save anyway"', async () => {
    const { api, user, onSaved } = await openReview({ duplicates: cholesterolDuplicate });

    const warning = await screen.findByTestId('lab-report-duplicates');
    expect(warning).toHaveTextContent('Some of these results are already saved');
    expect(warning).toHaveTextContent('Total cholesterol 212 mg/dL');
    expect(within(warning).queryByRole('button', { name: SAVE_ANYWAY_LABEL })).not.toBeInTheDocument();

    await user.click(within(rowFor('Lipoprotein (a)')).getByRole('button', { name: 'Reject' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Accept all (6)' }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());

    const confirm = await within(screen.getByTestId('lab-report-duplicates')).findByRole('button', { name: SAVE_ANYWAY_LABEL });
    expect(api.applied).toBe(0);
    await user.click(confirm);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.applied).toBe(1);
  });

  it('has no axe violations on the review', async () => {
    await openReview({ duplicates: cholesterolDuplicate });
    await screen.findByTestId('lab-report-duplicates');
    const results = await axe(dialog(), { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

/** A trend report: glucose and cholesterol on three dates; no report date read. */
function trendIntake() {
  const dates = ['2023-04-06', '2024-05-01', '2025-11-19'];
  const items = dates.flatMap((date, index) => [
    labItem(labValue({ analyteKey: 'fasting_glucose', nameAsPrinted: 'Glucose Lvl', value: 90 + index, unit: 'mg/dL', panel: 'glycemic', collectionDate: date })),
    labItem(
      labValue({ analyteKey: 'total_cholesterol', nameAsPrinted: 'Cholesterol', value: 180 + index, unit: 'mg/dL', panel: 'lipids', collectionDate: date }),
      index === 0 ? { confidence: 'low' } : {},
    ),
  ]);
  return labIntake('ready', { items, photos: PHOTOS, context: { collectionDate: null, labName: null } });
}

describe('LabReportDialog: multi-date report (#305)', () => {
  it('groups by date, accepts the high-confidence results, and saves one entry per date', async () => {
    const { api, user, onSaved } = setup({ existing: [trendIntake()] });
    await screen.findByTestId('lab-report-review');

    expect(screen.getAllByTestId('lab-date-group').map((group) => group.getAttribute('data-date'))).toEqual([
      '2025-11-19',
      '2024-05-01',
      '2023-04-06',
    ]);
    expect(screen.getByLabelText('Report date')).toHaveValue('');
    expect(screen.getByTestId('lab-report-details')).toHaveTextContent('Each result uses its own date');

    await user.click(within(dialog()).getByRole('button', { name: 'Accept high confidence (5)' }));
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Accept high confidence (0)' })).toBeDisabled());
    const acceptAll = api.requests.filter((request) => request.path.endsWith('/items/accept-all'));
    expect(acceptAll.map((request) => request.body)).toEqual([{ only: 'high_confidence' }]);
    expect(screen.getByTestId('lab-report-save-hint')).toHaveTextContent('1 result needs a decision before saving');

    await user.click(within(dialog()).getByRole('button', { name: 'Accept all (1)' }));
    const confirm = await screen.findByRole('dialog', { name: 'Accept all 1 results?' });
    await user.click(within(confirm).getByRole('button', { name: 'Accept all' }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const result = onSaved.mock.calls[0][0];
    expect(result.entryIds).toHaveLength(3);
    expect(result.measuredAtSource).toBe('collection_date');
    expect(result.entries.map((entry: { collectionDate: string }) => entry.collectionDate)).toEqual([
      '2025-11-19',
      '2024-05-01',
      '2023-04-06',
    ]);
    expect(await screen.findByText('Saved 6 results on 3 dates')).toBeInTheDocument();
  });

  it('says the report date is used for results without their own date', async () => {
    const intake = readyIntake();
    intake.items[0] = { ...intake.items[0], value: { ...intake.items[0].value, collectionDate: '2026-09-01' } };
    setup({ existing: [intake] });
    await screen.findByTestId('lab-report-review');
    expect(screen.getByTestId('lab-report-details')).toHaveTextContent('Used for results without their own date');
    expect(screen.getAllByTestId('lab-date-group').map((group) => group.getAttribute('data-date'))).toEqual([
      '2026-09-15',
      '2026-09-01',
    ]);
  });
});

/** A trend report printing "Chol/HDL Ratio" (not in the mock catalog) on five dates, plus distractors. */
function ratioIntake() {
  const dates = ['2021-03-01', '2022-03-01', '2023-03-01', '2024-03-01', '2025-03-01'];
  const ratio = (date: string, value: number, extra = {}, overrides: Partial<LabReportValue> = {}) =>
    labItem(
      labValue({
        nameAsPrinted: 'Chol/HDL Ratio',
        value,
        unit: null,
        panel: 'lipids',
        match: 'unmatched',
        collectionDate: date,
        referenceText: '(CALC)',
        ...overrides,
      }),
      { uncertain: true, uncertaintyNote: 'Not in the lab catalog: map it to an analyte or reject it', ...extra },
    );
  const items = [
    ...dates.map((date, index) => ratio(date, 3.5 + index / 10)),
    // Rejected: left alone.
    ratio('2020-03-01', 4.2, { status: 'rejected' }),
    // Already mapped by the user to another analyte: left alone.
    ratio('2019-03-01', 4.4, {}, { analyteKey: 'hdl_cholesterol', match: 'user_mapped' }),
    // A different printed name: left alone.
    labItem(labValue({ nameAsPrinted: 'LDL/HDL Ratio', value: 2.1, unit: null, panel: 'lipids', match: 'unmatched', collectionDate: dates[0] }), {
      uncertain: true,
    }),
  ];
  return labIntake('ready', { items, photos: PHOTOS, context: { collectionDate: null, labName: null } });
}

const ratioRows = () =>
  screen
    .getAllByTestId('lab-result-row')
    .filter((row) => within(row).queryAllByTestId('lab-result-value')[0]?.textContent?.startsWith('Chol/HDL Ratio'));

describe('LabReportDialog: map once for every same-named result (#307)', () => {
  it('mapping one of several same-named results maps all of them and says how many', async () => {
    const { api, user } = setup({ existing: [ratioIntake()] });
    await screen.findByTestId('lab-report-review');
    // Five unmatched plus the one the user mapped elsewhere (the rejected one sits in "Rejected").
    expect(ratioRows().filter((row) => row.getAttribute('data-unresolved') === 'true')).toHaveLength(5);

    const first = ratioRows().find((row) => row.getAttribute('data-unresolved') === 'true')!;
    const picker = within(first).getByRole('combobox', { name: 'Map “Chol/HDL Ratio” to an analyte' });
    await user.type(picker, 'TC/HDL');
    await user.click(await screen.findByRole('option', { name: /Cholesterol\/HDL ratio/ }));

    await waitFor(() => expect(api.maps).toHaveLength(1));
    expect(api.maps[0].analyteKey).toBe('chol_hdl_ratio');
    expect(api.maps[0].mapped).toHaveLength(5);
    expect(api.itemPatches).toHaveLength(0);

    const notice = await screen.findByTestId('lab-report-map-notice');
    expect(notice).toHaveTextContent('Mapped 5 results named “Chol/HDL Ratio” to Cholesterol/HDL ratio');
    expect(notice).not.toHaveTextContent('could not be mapped');

    // Every same-named row is resolved after the re-read; the distractors are not touched.
    await waitFor(() =>
      expect(ratioRows().filter((row) => row.getAttribute('data-unresolved') === 'true')).toHaveLength(0),
    );
    const intake = api.intakes.get('lab-intake-1')!;
    const byName = (name: string) => intake.items.filter((item) => item.value.nameAsPrinted === name);
    expect(byName('Chol/HDL Ratio').filter((item) => item.value.analyteKey === 'chol_hdl_ratio')).toHaveLength(5);
    expect(byName('Chol/HDL Ratio').find((item) => item.status === 'rejected')?.value.analyteKey).toBeNull();
    expect(byName('Chol/HDL Ratio').filter((item) => item.value.analyteKey === 'hdl_cholesterol')).toHaveLength(1);
    expect(byName('LDL/HDL Ratio')[0].value.analyteKey).toBeNull();
    expect(screen.getByTestId('lab-report-save-hint')).toHaveTextContent('1 result is not in the lab catalog');
  });

  it('says how many could not be mapped, with the reason', async () => {
    const reason = 'unit mg/dL is not allowed for Cholesterol/HDL ratio';
    const intake = ratioIntake();
    // The last same-named result was printed with a unit the ratio does not take.
    intake.items[4] = { ...intake.items[4], value: { ...intake.items[4].value, unit: 'mg/dL' } };
    const { api, user } = setup({
      existing: [intake],
      mapRefusal: (item, metric) => (item.value.unit && item.value.unit !== metric.canonicalUnit ? reason : null),
    });
    await screen.findByTestId('lab-report-review');

    const row = ratioRows().find((candidate) => candidate.getAttribute('data-item-id') === intake.items[0].id)!;
    await user.type(within(row).getByRole('combobox', { name: 'Map “Chol/HDL Ratio” to an analyte' }), 'TC/HDL');
    await user.click(await screen.findByRole('option', { name: /Cholesterol\/HDL ratio/ }));

    await waitFor(() => expect(api.maps).toHaveLength(1));
    expect(api.maps[0].skipped).toEqual([intake.items[4].id]);
    const notice = await screen.findByTestId('lab-report-map-notice');
    expect(notice).toHaveTextContent('Mapped 4 results named “Chol/HDL Ratio” to Cholesterol/HDL ratio. 1 could not be mapped');
    expect(notice).toHaveTextContent(reason);
    expect(notice.className).toMatch(/Warning/);
    await waitFor(() => expect(screen.getByTestId('lab-report-save-hint')).toHaveTextContent('2 results are not in the lab catalog'));
  });

  it("shows the server's message when the picked result itself cannot be mapped", async () => {
    const message = 'unit nmol/L is not allowed for Apolipoprotein B';
    const { user } = await openReview({
      mapError: {
        status: 400,
        body: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: { issues: [{ path: 'value.unit', message }] } },
      },
    });
    const picker = within(rowFor('Lipoprotein (a)')).getByRole('combobox', { name: 'Map “Lipoprotein (a)” to an analyte' });
    await user.type(picker, 'apo b');
    await user.click(await screen.findByRole('option', { name: /Apolipoprotein B/ }));
    expect(await screen.findByTestId('lab-report-write-issues')).toHaveTextContent(message);
    expect(screen.queryByTestId('lab-report-map-notice')).not.toBeInTheDocument();
    expect(rowFor('Lipoprotein (a)')).toHaveAttribute('data-unresolved', 'true');
  });
});
