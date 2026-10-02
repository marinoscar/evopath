/**
 * `LabReportDialog` (H4, #188) over the intake kit and a stateful MSW
 * `/api/intakes` for the `lab_report` kind: the upload step with the
 * keep-or-delete choice, the review grouped by panel, highlighting, the
 * unmatched gate and mapping, edits, the report details, apply, and an axe
 * pass on the review; #308: already-saved results decided row by row or with
 * the bar's "Skip all" / "Save all again"; #311: "Reject unmatched" from the
 * toolbar and the save hint; #305: a
 * multi-date report, "Accept high confidence" and a save over several dates;
 * #307: mapping one result maps every same-named one, and an analyte or unit
 * edit is carried to them, with the feedback.
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
  SKIP_ALL_LABEL,
} from '../../../components/health/LabReportDialog';
import { clearPhotoUrlCache } from '../../../components/intake/StoragePhotoThumb';
import { RETAIN_FILES_LABEL } from '../../../components/intake';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import {
  cholesterolDuplicate,
  duplicatesOf,
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
    // #307: a value-only edit is not carried to other results.
    expect(api.maps).toHaveLength(0);
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

  it('has no axe violations on the review', async () => {
    await openReview({ duplicates: cholesterolDuplicate });
    await screen.findByTestId('lab-report-duplicates');
    expect(screen.getByTestId('lab-result-already-saved')).toBeInTheDocument();
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

/** "Glucose Lvl" printed in mmol/L-looking values but read as mg/dL on four dates; one already edited by the user. */
function glucoseTrendIntake() {
  const dates = ['2022-01-10', '2023-01-10', '2024-01-10', '2025-01-10'];
  const items = dates.map((date, index) =>
    labItem(
      labValue({ analyteKey: 'fasting_glucose', nameAsPrinted: 'Glucose Lvl', value: 5.1 + index / 10, unit: 'mg/dL', panel: 'glycemic', collectionDate: date }),
    ),
  );
  // The user already corrected this one: an edit elsewhere leaves it alone.
  items[3] = { ...items[3], originalAiValue: items[3].value, userVerified: true };
  items.push(labItem(labValue({ analyteKey: 'hba1c', nameAsPrinted: 'Hemoglobin A1c', value: 5.6, unit: '%', panel: 'glycemic', collectionDate: dates[0] })));
  return labIntake('ready', { items, photos: PHOTOS, context: { collectionDate: null, labName: null } });
}

describe('LabReportDialog: an edit is carried to same-named results (#307)', () => {
  const glucoseRows = () =>
    screen
      .getAllByTestId('lab-result-row')
      .filter((row) => within(row).queryAllByTestId('lab-result-value')[0]?.textContent?.startsWith('Glucose Lvl'));

  async function changeUnit(user: ReturnType<typeof userEvent.setup>, row: HTMLElement, unit: string) {
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const editor = within(row).getByTestId('lab-result-editor');
    await user.click(within(editor).getByRole('combobox', { name: 'Unit' }));
    await user.click(await screen.findByRole('option', { name: unit }));
    await user.click(within(row).getByRole('button', { name: 'Save' }));
  }

  it('a unit change on one date updates the same-named results on the other dates', async () => {
    const intake = glucoseTrendIntake();
    const { api, user } = setup({ existing: [intake] });
    await screen.findByTestId('lab-report-review');
    expect(glucoseRows()).toHaveLength(4);

    const edited = glucoseRows().find((row) => row.getAttribute('data-item-id') === intake.items[0].id)!;
    await changeUnit(user, edited, 'mmol/L');

    await waitFor(() => expect(api.maps).toHaveLength(1));
    expect(api.itemPatches).toHaveLength(1);
    expect(api.itemPatches[0].body).toMatchObject({ value: { unit: 'mmol/L' } });
    // The PATCH comes first, then the map carries only the unit.
    const paths = api.requests.map((request) => request.path);
    expect(paths.findIndex((path) => path.endsWith('/map'))).toBeGreaterThan(paths.findIndex((path) => path.includes('/items/')));
    expect(api.requests.find((request) => request.path.endsWith('/map'))?.body).toEqual({ itemId: intake.items[0].id, unit: 'mmol/L' });

    const notice = await screen.findByTestId('lab-report-map-notice');
    expect(notice).toHaveTextContent('Updated 2 other results named “Glucose Lvl”');

    const stored = api.intakes.get('lab-intake-1')!.items;
    expect(stored.slice(0, 3).map((item) => item.value.unit)).toEqual(['mmol/L', 'mmol/L', 'mmol/L']);
    // The one the user had already edited, and a different name, are untouched.
    expect(stored[3].value.unit).toBe('mg/dL');
    expect(stored[4].value.unit).toBe('%');
  });

  it('an edit of a result with no same-named results is not carried anywhere', async () => {
    const intake = glucoseTrendIntake();
    const { api, user } = setup({ existing: [intake] });
    await screen.findByTestId('lab-report-review');
    const a1c = screen.getAllByTestId('lab-result-row').find((row) => row.getAttribute('data-item-id') === intake.items[4].id)!;
    await changeUnit(user, a1c, 'mmol/mol');
    await waitFor(() => expect(api.itemPatches).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('lab-result-editor')).not.toBeInTheDocument());
    expect(api.maps).toHaveLength(0);
    expect(screen.queryByTestId('lab-report-map-notice')).not.toBeInTheDocument();
  });

  it('warns when some same-named results could not take the unit', async () => {
    const intake = glucoseTrendIntake();
    const reason = 'value is outside what Fasting glucose allows';
    const { api, user } = setup({
      existing: [intake],
      mapRefusal: (item) => (item.id === intake.items[2].id ? reason : null),
    });
    await screen.findByTestId('lab-report-review');
    const edited = glucoseRows().find((row) => row.getAttribute('data-item-id') === intake.items[0].id)!;
    await changeUnit(user, edited, 'mmol/L');
    await waitFor(() => expect(api.maps).toHaveLength(1));
    const notice = await screen.findByTestId('lab-report-map-notice');
    expect(notice).toHaveTextContent('Updated 1 other result named “Glucose Lvl”. 1 could not be updated');
    expect(notice).toHaveTextContent(reason);
  });
});

describe('LabReportDialog: already-saved results (#308)', () => {
  const hint = () => screen.getByTestId('lab-report-save-hint');
  const bar = () => screen.getByTestId('lab-report-duplicates');

  /** Resolve the unmatched row and accept the rest, so only the duplicate decisions block Save. */
  async function resolveRest(user: ReturnType<typeof userEvent.setup>, accept: string) {
    await user.click(within(rowFor('Lipoprotein (a)')).getByRole('button', { name: 'Reject' }));
    await user.click(within(dialog()).getByRole('button', { name: accept }));
  }

  it('marks each duplicate row with the date and blocks Save until it is decided; Save again lets it save', async () => {
    const { api, user, onSaved } = await openReview({ duplicates: cholesterolDuplicate });
    const row = rowFor('Cholesterol, Total');
    await waitFor(() => expect(row).toHaveAttribute('data-duplicate', 'true'));
    expect(within(row).getByTestId('lab-result-already-saved')).toHaveTextContent('Already saved · Sep 15, 2026');
    expect(rowFor('HDL Cholesterol')).toHaveAttribute('data-duplicate', 'false');
    expect(bar()).toHaveTextContent('1 result is already saved');
    // The long list and "Save anyway" are gone.
    expect(screen.queryByText(/Saving creates a second copy/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).not.toBeInTheDocument();

    await resolveRest(user, 'Accept all (6)');
    await waitFor(() => expect(hint()).toHaveTextContent('Decide on 1 already-saved result: skip it or save it again'));
    expect(saveButton()).toBeDisabled();

    await user.click(within(row).getByRole('button', { name: 'Save again Cholesterol, Total' }));
    expect(within(row).getByRole('button', { name: 'Save again Cholesterol, Total' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(row).getByTestId('lab-result-already-saved')).toHaveTextContent('will be saved again');
    expect(screen.queryByTestId('lab-report-duplicates')).not.toBeInTheDocument();
    expect(screen.getByTestId('lab-report-duplicate-summary')).toHaveTextContent('1 will be saved again');
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(hint()).toHaveTextContent('6 results will be saved');

    await user.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.applied).toBe(1);
  });

  it('Skip rejects the duplicate (persisted); Restore makes it undecided again', async () => {
    const { api, user } = await openReview({ duplicates: cholesterolDuplicate });
    const row = rowFor('Cholesterol, Total');
    const id = row.getAttribute('data-item-id')!;
    await waitFor(() => expect(row).toHaveAttribute('data-duplicate', 'true'));

    await user.click(within(row).getByRole('button', { name: 'Skip Cholesterol, Total' }));
    await waitFor(() => expect(api.itemPatches).toContainEqual({ itemId: id, body: { status: 'rejected' } }));
    await screen.findByText('Rejected (1)');
    await waitFor(() => expect(screen.queryByTestId('lab-report-duplicates')).not.toBeInTheDocument());
    expect(await screen.findByTestId('lab-report-duplicate-summary')).toHaveTextContent('1 skipped');

    await user.click(screen.getByText('Rejected (1)'));
    await user.click(within(rowFor('Cholesterol, Total')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(rowFor('Cholesterol, Total')).toHaveAttribute('data-duplicate', 'true'));
    expect(bar()).toHaveTextContent('1 result is already saved');
    expect(screen.queryByTestId('lab-report-duplicate-summary')).not.toBeInTheDocument();
  });

  it('"Skip all" rejects every duplicate, one after another', async () => {
    const { api, user } = await openReview({ duplicates: duplicatesOf('total_cholesterol', 'hdl_cholesterol', 'triglycerides') });
    await waitFor(() => expect(bar()).toHaveTextContent('3 results are already saved'));
    const ids = ['Cholesterol, Total', 'HDL Cholesterol', 'Triglycerides'].map((name) => rowFor(name).getAttribute('data-item-id'));

    await user.click(within(bar()).getByRole('button', { name: `${SKIP_ALL_LABEL} 3` }));
    await waitFor(() => expect(screen.queryByTestId('lab-report-duplicates')).not.toBeInTheDocument());
    expect(api.itemPatches.filter((patch) => patch.body.status === 'rejected').map((patch) => patch.itemId)).toEqual(ids);
    expect(await screen.findByText('Rejected (3)')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('lab-report-duplicate-summary')).toHaveTextContent('3 skipped'));

    await resolveRest(user, 'Accept all (3)');
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('"Save all again" keeps every duplicate; one can still be skipped after', async () => {
    const { user } = await openReview({ duplicates: duplicatesOf('total_cholesterol', 'hdl_cholesterol', 'triglycerides') });
    await waitFor(() => expect(bar()).toHaveTextContent('3 results are already saved'));
    await user.click(within(bar()).getByRole('button', { name: 'Save all 3 again' }));
    expect(screen.queryByTestId('lab-report-duplicates')).not.toBeInTheDocument();
    expect(screen.getByTestId('lab-report-duplicate-summary')).toHaveTextContent('3 will be saved again');

    await user.click(within(rowFor('HDL Cholesterol')).getByRole('button', { name: 'Skip HDL Cholesterol' }));
    await waitFor(() => expect(screen.getByTestId('lab-report-duplicate-summary')).toHaveTextContent('1 skipped · 2 will be saved again'));

    await resolveRest(user, 'Accept all (5)');
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('drops a decision once the result is no longer a duplicate', async () => {
    let reported = true;
    const { user } = await openReview({ duplicates: (intake) => (reported ? cholesterolDuplicate(intake) : []) });
    const row = rowFor('Cholesterol, Total');
    await waitFor(() => expect(row).toHaveAttribute('data-duplicate', 'true'));
    await user.click(within(row).getByRole('button', { name: 'Save again Cholesterol, Total' }));
    expect(screen.getByTestId('lab-report-duplicate-summary')).toHaveTextContent('1 will be saved again');

    // An edit changes what would be saved; the re-check no longer reports it.
    reported = false;
    await user.click(within(rowFor('HDL Cholesterol')).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(rowFor('Cholesterol, Total')).toHaveAttribute('data-duplicate', 'false'));
    expect(screen.queryByTestId('lab-report-duplicate-summary')).not.toBeInTheDocument();

    // Reported again later: undecided, not silently kept.
    reported = true;
    await user.click(within(rowFor('Glucose')).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(bar()).toHaveTextContent('1 result is already saved'));
    expect(within(rowFor('Cholesterol, Total')).getByRole('button', { name: 'Save again Cholesterol, Total' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

/** The panel plus a second unmatched result and a suggested one (#311). */
function unmatchedIntake() {
  const intake = readyIntake();
  intake.items.push(
    labItem(labValue({ analyteKey: null, nameAsPrinted: 'Homocysteine', value: 9, unit: 'µmol/L', panel: 'other', match: 'unmatched' }), {
      uncertain: true,
    }),
    labItem(labValue({ analyteKey: 'apob', nameAsPrinted: 'Apo-B', value: 90, unit: 'mg/dL', panel: 'lipids', match: 'suggested' })),
  );
  return intake;
}

describe('LabReportDialog: reject unmatched (#311)', () => {
  const rejectRequests = (api: { requests: { path: string }[] }) =>
    api.requests.filter((request) => request.path.endsWith('/reject-unmatched'));

  it('counts the unmatched results and rejects only those after the confirmation', async () => {
    const { api, user } = setup({ existing: [unmatchedIntake()] });
    await screen.findByTestId('lab-report-review');
    const toolbar = screen.getByTestId('lab-review-toolbar');
    const button = within(toolbar).getByRole('button', { name: 'Reject unmatched (2)' });

    // Cancel leaves everything as it was.
    await user.click(button);
    let confirm = await screen.findByRole('dialog', { name: 'Reject 2 results that are not in the lab catalog?' });
    expect(confirm).toHaveTextContent('They can be restored one by one from Rejected.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Reject 2 results/ })).not.toBeInTheDocument());
    expect(rejectRequests(api)).toHaveLength(0);

    await user.click(button);
    confirm = await screen.findByRole('dialog', { name: 'Reject 2 results that are not in the lab catalog?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reject unmatched' }));

    await waitFor(() => expect(rejectRequests(api)).toHaveLength(1));
    expect(await screen.findByTestId('lab-report-map-notice')).toHaveTextContent('Rejected 2 unmatched results');
    expect(await screen.findByText('Rejected (2)')).toBeInTheDocument();
    const stored = api.intakes.get('lab-intake-1')!.items;
    expect(stored.filter((item) => item.status === 'rejected').map((item) => item.value.nameAsPrinted).sort()).toEqual([
      'Homocysteine',
      'Lipoprotein (a)',
    ]);
    // The suggested match is left alone.
    expect(stored.find((item) => item.value.nameAsPrinted === 'Apo-B')?.status).toBe('pending');
    // Nothing unmatched is left: the button goes away and saving is unblocked once the rest is accepted.
    expect(within(toolbar).queryByRole('button', { name: /Reject unmatched/ })).not.toBeInTheDocument();
    await user.click(within(dialog()).getByRole('button', { name: 'Accept all (7)' }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('offers the same action in the save hint', async () => {
    const { api, user } = setup({ existing: [unmatchedIntake()] });
    await screen.findByTestId('lab-report-review');
    expect(screen.getByTestId('lab-report-save-hint')).toHaveTextContent('2 results are not in the lab catalog');
    await user.click(screen.getByTestId('lab-report-hint-reject-unmatched'));
    const confirm = await screen.findByRole('dialog', { name: 'Reject 2 results that are not in the lab catalog?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reject unmatched' }));
    await waitFor(() => expect(rejectRequests(api)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('lab-report-hint-reject-unmatched')).not.toBeInTheDocument());
    expect(screen.getByTestId('lab-report-save-hint')).not.toHaveTextContent('not in the lab catalog');
  });

  it('has no button when every result is matched', async () => {
    const intake = readyIntake();
    intake.items = intake.items.filter((item) => item.value.analyteKey !== null);
    setup({ existing: [intake] });
    await screen.findByTestId('lab-report-review');
    expect(screen.queryByRole('button', { name: /Reject unmatched/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('lab-report-hint-reject-unmatched')).not.toBeInTheDocument();
  });
});
