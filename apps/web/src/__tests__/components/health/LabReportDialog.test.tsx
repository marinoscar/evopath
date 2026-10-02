/**
 * `LabReportDialog` (H4, #188) over the intake kit and a stateful MSW
 * `/api/intakes` for the `lab_report` kind: the upload step with the
 * keep-or-delete choice, the review grouped by panel, highlighting, the
 * unmatched gate and mapping, edits, the report details, the duplicate
 * warning with "Save anyway", apply, and an axe pass on the review.
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

    await waitFor(() => expect(api.itemPatches).toHaveLength(1));
    expect(api.itemPatches[0].body).toMatchObject({ value: { analyteKey: 'apob', nameAsPrinted: 'Lipoprotein (a)', value: 32 } });
    expect(api.itemPatches[0].body.value).not.toHaveProperty('match');

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
