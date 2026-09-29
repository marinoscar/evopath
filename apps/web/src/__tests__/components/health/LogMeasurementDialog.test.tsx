/**
 * The quick-entry dialog (issue #53, E2.3) against MSW: what it SENDS is
 * asserted, not just what it shows, because the API converts the unit it is
 * given and a wrong unit is a silently wrong weight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { act, fireEvent, render, screen, waitFor, within, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { resetViewportWidth, setViewportWidth } from '../../setup';
import {
  LogMeasurementDialog,
  type LogMeasurementDialogProps,
} from '../../../components/health/LogMeasurementDialog';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import type { HealthProfile, LatestItem } from '../../../services/health';
import { mockHealthProfileEmpty, mockHealthProfileSaved } from '../../mocks/fixtures/health';
import { mockLatest, mockMeasurement } from '../../mocks/fixtures/measurements';
import { toDateTimeLocalValue } from '../../../utils/measurementDates';
import { groupByEntry, type HistoryEntry } from '../../../utils/measurementSeries';

const IMPERIAL: HealthProfile = mockHealthProfileSaved;
const METRIC: HealthProfile = { ...mockHealthProfileSaved, unitSystem: 'metric' };

type Body = {
  measuredAt?: string;
  notes?: string;
  readings: Array<{ metricKey: string; value: number; unit: string; method?: string }>;
};

/** Records every POST body; answers 201 unless `respond` says otherwise. */
function capturePosts(respond?: () => Response | Promise<Response>) {
  const bodies: Body[] = [];
  server.use(
    http.post('*/api/measurements', async ({ request }) => {
      const body = (await request.json()) as Body;
      bodies.push(body);
      if (respond) return respond();
      return HttpResponse.json(
        {
          data: {
            entryId: 'entry-1',
            items: body.readings.map((r) => mockMeasurement(r.metricKey, r.value, { method: r.method ?? 'unspecified' })),
          },
        },
        { status: 201 },
      );
    }),
  );
  return bodies;
}

function renderDialog(
  props: Partial<LogMeasurementDialogProps> = {},
  options: Parameters<typeof render>[1] = {},
) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <LogMeasurementDialog open onClose={onClose} onSaved={onSaved} profile={IMPERIAL} {...props} />,
    options,
  );
  return { ...utils, onSaved, onClose, user };
}

async function field(name: string) {
  return screen.findByRole('textbox', { name });
}

const save = () => screen.getByRole('button', { name: 'Save' });

describe('LogMeasurementDialog', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });

  afterEach(() => {
    act(() => resetViewportWidth());
  });

  it('focuses Weight and shows the imperial unit', async () => {
    renderDialog();
    const weight = await field('Weight');
    await waitFor(() => expect(weight).toHaveFocus());
    expect(within(weight.parentElement!).getByText('lb')).toBeInTheDocument();
    expect(weight).toHaveAttribute('inputmode', 'decimal');
    expect(weight).toHaveAttribute('enterkeyhint', 'done');
  });

  it('logs a weight with type + Enter, in pounds, and closes', async () => {
    const bodies = capturePosts();
    const { user, onSaved, onClose } = renderDialog();
    await field('Weight');

    await user.keyboard('208.4{Enter}');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodies).toEqual([{ readings: [{ metricKey: 'weight', value: 208.4, unit: 'lb' }] }]);
    expect(onSaved).toHaveBeenCalledWith([expect.objectContaining({ metricKey: 'weight' })]);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('sends kilograms for a metric user', async () => {
    const bodies = capturePosts();
    const { user, onClose } = renderDialog({ profile: METRIC });
    await user.type(await field('Weight'), '80{Enter}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodies[0].readings).toEqual([{ metricKey: 'weight', value: 80, unit: 'kg' }]);
  });

  it('accepts a decimal comma', async () => {
    const bodies = capturePosts();
    const { user, onClose } = renderDialog();
    await user.type(await field('Weight'), '208,4{Enter}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodies[0].readings[0].value).toBe(208.4);
  });

  it('sends weight, body fat and waist as one entry of three readings', async () => {
    const bodies = capturePosts();
    const { user, onClose } = renderDialog({ profile: METRIC });
    await user.type(await field('Weight'), '80');
    await user.type(screen.getByRole('textbox', { name: 'Body fat' }), '22.5');
    await user.type(screen.getByRole('textbox', { name: 'Waist' }), '84');
    await user.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodies).toHaveLength(1);
    expect(bodies[0].readings).toEqual([
      { metricKey: 'weight', value: 80, unit: 'kg' },
      { metricKey: 'body_fat_pct', value: 22.5, unit: '%' },
      { metricKey: 'waist_circumference', value: 84, unit: 'cm' },
    ]);
  });

  it('sends blood pressure 128/84 as two readings', async () => {
    const bodies = capturePosts();
    const { user, onClose } = renderDialog();
    await field('Weight');
    await user.type(screen.getByRole('textbox', { name: 'Systolic' }), '128');
    await user.type(screen.getByRole('textbox', { name: 'Diastolic' }), '84');
    await user.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodies[0].readings).toEqual([
      { metricKey: 'bp_systolic', value: 128, unit: 'mmHg' },
      { metricKey: 'bp_diastolic', value: 84, unit: 'mmHg' },
    ]);
  });

  describe('validation', () => {
    it('blocks a weight outside the bounds and sends nothing', async () => {
      const bodies = capturePosts();
      const { user, onClose } = renderDialog({ profile: METRIC });
      await user.type(await field('Weight'), '5{Enter}');

      expect(await screen.findByText('Enter a value between 20 and 500 kg')).toBeInTheDocument();
      expect(save()).toBeDisabled();
      expect(bodies).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('checks bounds on blur, in the displayed unit', async () => {
      const { user } = renderDialog();
      await user.type(await field('Weight'), '40');
      await user.tab();
      expect(await screen.findByText('Enter a value between 44.1 and 1102.3 lb')).toBeInTheDocument();
    });

    it('requires systolic above diastolic', async () => {
      const bodies = capturePosts();
      const { user } = renderDialog();
      await field('Weight');
      await user.type(screen.getByRole('textbox', { name: 'Systolic' }), '80');
      await user.type(screen.getByRole('textbox', { name: 'Diastolic' }), '90');
      await user.click(save());
      expect(await screen.findByText('Systolic must be higher than diastolic')).toBeInTheDocument();
      expect(bodies).toHaveLength(0);
    });

    it('requires both blood-pressure numbers', async () => {
      const bodies = capturePosts();
      const { user } = renderDialog();
      await field('Weight');
      await user.type(screen.getByRole('textbox', { name: 'Systolic' }), '120');
      await user.click(save());
      expect(await screen.findByText('Enter both numbers')).toBeInTheDocument();
      expect(bodies).toHaveLength(0);
    });

    it('requires at least one value', async () => {
      const bodies = capturePosts();
      const { user } = renderDialog();
      await field('Weight');
      await user.click(save());
      expect(await screen.findByText('Enter at least one value')).toBeInTheDocument();
      expect(bodies).toHaveLength(0);

      // Typing clears the form error and re-enables Save.
      await user.type(screen.getByRole('textbox', { name: 'Weight' }), '2');
      expect(screen.queryByText('Enter at least one value')).toBeNull();
      expect(save()).toBeEnabled();
    });

    it.each(['1e3', 'Infinity', '-80', 'abc'])('rejects %j as not a number', async (text) => {
      const bodies = capturePosts();
      const { user } = renderDialog();
      await user.type(await field('Weight'), `${text}{Enter}`);
      expect(await screen.findByText('Enter a number')).toBeInTheDocument();
      expect(bodies).toHaveLength(0);
    });
  });

  describe('soft warning', () => {
    const latest: LatestItem[] = mockLatest({ weight: { latest: mockMeasurement('weight', 80) } });

    it('asks before saving a value far from the latest, and Save anyway submits', async () => {
      const bodies = capturePosts();
      const { user, onClose } = renderDialog({ profile: METRIC, latest });
      await user.type(await field('Weight'), '120{Enter}');

      expect(
        await screen.findByText('This is 50% different from your last entry (80.0 kg). Check the unit.'),
      ).toBeInTheDocument();
      expect(bodies).toHaveLength(0);

      await user.click(screen.getByRole('button', { name: 'Save anyway' }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(bodies).toHaveLength(1);
      expect(bodies[0].readings[0]).toEqual({ metricKey: 'weight', value: 120, unit: 'kg' });
    });

    it('Keep editing dismisses the warning and keeps the values', async () => {
      const bodies = capturePosts();
      const { user } = renderDialog({ profile: METRIC, latest });
      await user.type(await field('Weight'), '120{Enter}');
      await user.click(await screen.findByRole('button', { name: 'Keep editing' }));

      expect(screen.queryByText(/different from your last entry/)).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Weight' })).toHaveValue('120');
      expect(bodies).toHaveLength(0);
    });

    it('does not warn within 25%', async () => {
      const bodies = capturePosts();
      const { user, onClose } = renderDialog({ profile: METRIC, latest });
      await user.type(await field('Weight'), '82{Enter}');
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(bodies).toHaveLength(1);
    });

    it('compares in canonical units (a pound value against a kilogram reading)', async () => {
      capturePosts();
      const { user, onClose } = renderDialog({ profile: IMPERIAL, latest });
      // 176.4 lb is 80.0 kg: no warning.
      await user.type(await field('Weight'), '176.4{Enter}');
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
  });

  describe('details', () => {
    it('sends the chosen method and preselects the latest one', async () => {
      const bodies = capturePosts();
      const latest = mockLatest({
        body_fat_pct: { latest: mockMeasurement('body_fat_pct', 28, { method: 'smart_scale' }) },
      });
      const { user, onClose } = renderDialog({ latest });
      await field('Weight');
      await user.type(screen.getByRole('textbox', { name: 'Body fat' }), '27.8');
      await user.click(screen.getByRole('button', { name: 'Details' }));

      const select = await screen.findByRole('combobox', { name: 'Body fat method' });
      expect(select).toHaveTextContent('Smart scale');
      await user.click(save());
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(bodies[0].readings).toEqual([
        { metricKey: 'body_fat_pct', value: 27.8, unit: '%', method: 'smart_scale' },
      ]);
    });

    it('offers the metric methods and omits unspecified', async () => {
      const bodies = capturePosts();
      const { user, onClose } = renderDialog();
      await field('Weight');
      await user.type(screen.getByRole('textbox', { name: 'Body fat' }), '27.8');
      await user.type(screen.getByRole('textbox', { name: 'Waist' }), '33');
      await user.click(screen.getByRole('button', { name: 'Details' }));

      await user.click(await screen.findByRole('combobox', { name: 'Body fat method' }));
      const listbox = await screen.findByRole('listbox');
      expect(within(listbox).queryByRole('option', { name: 'Tape measure' })).toBeNull();
      await user.click(within(listbox).getByRole('option', { name: 'Smart scale' }));

      await user.click(save());
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(bodies[0].readings).toEqual([
        { metricKey: 'body_fat_pct', value: 27.8, unit: '%', method: 'smart_scale' },
        { metricKey: 'waist_circumference', value: 33, unit: 'in' },
      ]);
    });

    it('omits measuredAt when the time is untouched and sends the picked local time as an ISO instant', async () => {
      const bodies = capturePosts();
      const { user, onClose } = renderDialog();
      await user.type(await field('Weight'), '180');
      await user.click(screen.getByRole('button', { name: 'Details' }));

      const picked = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      picked.setSeconds(0, 0);
      const input = await screen.findByLabelText('Date and time');
      fireEvent.change(input, { target: { value: toDateTimeLocalValue(picked) } });
      await user.type(screen.getByRole('textbox', { name: 'Note' }), '  after run  ');

      await user.click(save());
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(bodies[0].measuredAt).toBe(picked.toISOString());
      expect(bodies[0].notes).toBe('after run');
    });

    it('refuses a future time before submit', async () => {
      const bodies = capturePosts();
      const { user } = renderDialog();
      await user.type(await field('Weight'), '180');
      await user.click(screen.getByRole('button', { name: 'Details' }));

      const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
      fireEvent.change(await screen.findByLabelText('Date and time'), {
        target: { value: toDateTimeLocalValue(future) },
      });
      await user.click(save());
      expect(await screen.findByText('The time cannot be in the future')).toBeInTheDocument();
      expect(bodies).toHaveLength(0);
    });

    it('caps the note at 500 characters', async () => {
      const { user } = renderDialog();
      await field('Weight');
      await user.click(screen.getByRole('button', { name: 'Details' }));
      expect(await screen.findByRole('textbox', { name: 'Note' })).toHaveAttribute('maxlength', '500');
    });
  });

  describe('failures', () => {
    it('shows server 400 messages under their fields', async () => {
      capturePosts(() =>
        HttpResponse.json(
          {
            message: 'Validation failed',
            details: {
              issues: [{ path: 'readings.0.value', message: 'value is outside the allowed range for weight' }],
            },
          },
          { status: 400 },
        ),
      );
      const { user, onClose } = renderDialog();
      await user.type(await field('Weight'), '200{Enter}');
      expect(await screen.findByText('value is outside the allowed range for weight')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('shows the unavailable message on a 403', async () => {
      capturePosts(() => HttpResponse.json({ message: 'Forbidden' }, { status: 403 }));
      const { user } = renderDialog();
      await user.type(await field('Weight'), '200{Enter}');
      expect(await screen.findByText('Health data is not available for your account')).toBeInTheDocument();
    });

    it('keeps the typed values on a network failure and Retry resends', async () => {
      let fail = true;
      const bodies = capturePosts(() =>
        fail
          ? HttpResponse.error()
          : HttpResponse.json({ data: { entryId: 'e', items: [] } }, { status: 201 }),
      );
      const { user, onClose } = renderDialog();
      await user.type(await field('Weight'), '200{Enter}');

      const alert = await screen.findByText('Could not save. Check your connection and try again.');
      expect(alert).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Weight' })).toHaveValue('200');
      expect(onClose).not.toHaveBeenCalled();

      fail = false;
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
    });

    it('ignores a second submit while saving and disables the inputs', async () => {
      const bodies = capturePosts(async () => {
        await delay(100);
        return HttpResponse.json({ data: { entryId: 'e', items: [] } }, { status: 201 });
      });
      const { user, onClose } = renderDialog();
      const weight = await field('Weight');
      await user.type(weight, '200');
      fireEvent.submit(weight.closest('form')!);
      fireEvent.submit(weight.closest('form')!);

      expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
      expect(weight).toBeDisabled();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(bodies).toHaveLength(1);
    });

    it('shows an inline error and disables Save when the catalog fails', async () => {
      server.use(
        http.get('*/api/measurements/metrics', () => HttpResponse.json({ message: 'Boom' }, { status: 500 })),
      );
      renderDialog();
      expect(await screen.findByText(/Could not load the list of measurements/)).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Weight' })).toBeNull();
      expect(save()).toBeDisabled();
    });
  });

  it('hints at metric units when the profile is missing', async () => {
    renderDialog({ profile: mockHealthProfileEmpty });
    await field('Weight');
    expect(screen.getByText(/Using metric units/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change in Health Profile' })).toHaveAttribute(
      'href',
      '/settings/health-profile',
    );
    expect(within(screen.getByRole('textbox', { name: 'Weight' }).parentElement!).getByText('kg')).toBeInTheDocument();
  });

  it('shows no hint for a saved profile', async () => {
    renderDialog();
    await field('Weight');
    expect(screen.queryByText(/Using metric units/)).toBeNull();
  });

  it('focuses the requested metric', async () => {
    renderDialog({ focusMetric: 'resting_hr' });
    const hr = await field('Resting heart rate');
    await waitFor(() => expect(hr).toHaveFocus());
  });

  it('does not open without health_data:write', () => {
    renderDialog(
      {},
      { wrapperOptions: { user: { ...mockUser, permissions: ['health_data:read'] } } },
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', async () => {
    const { user, onClose } = renderDialog();
    await field('Weight');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('is full-screen on a phone', async () => {
    act(() => setViewportWidth(375));
    renderDialog();
    await field('Weight');
    expect(document.querySelector('.MuiDialog-paperFullScreen')).not.toBeNull();
  });

  it('is not full-screen on a desktop', async () => {
    renderDialog();
    await field('Weight');
    expect(document.querySelector('.MuiDialog-paperFullScreen')).toBeNull();
  });

  it('has no axe violations', async () => {
    renderDialog();
    await field('Weight');
    const results = await axe(screen.getByRole('dialog'), {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

// =============================================================================
// Edit mode (issue #60, E2.5)
// =============================================================================

type PatchBody = {
  measuredAt?: string;
  notes?: string | null;
  readings?: Array<{ metricKey: string; value: number; unit: string; method?: string }>;
};

/** Records every PATCH; answers 200 (echo) unless `respond` says otherwise. */
function capturePatches(respond?: () => Response) {
  const calls: Array<{ entryId: string; body: PatchBody }> = [];
  server.use(
    http.patch('*/api/measurements/entries/:entryId', async ({ request, params }) => {
      const body = (await request.json()) as PatchBody;
      calls.push({ entryId: String(params.entryId), body });
      if (respond) return respond();
      return HttpResponse.json({
        data: {
          entryId: String(params.entryId),
          items: (body.readings ?? []).map((r) => mockMeasurement(r.metricKey, r.value, { revision: 2, edited: true })),
        },
      });
    }),
  );
  return calls;
}

const AT = '2026-09-20T08:30:00.000Z';

function weightEntry(overrides: Partial<Parameters<typeof mockMeasurement>[2]> = {}): HistoryEntry {
  return groupByEntry([
    mockMeasurement('weight', 80, { entryId: 'entry-w', measuredAt: AT, method: 'scale', notes: 'Morning', ...overrides }),
  ])[0];
}

function renderEdit(entry: HistoryEntry, props: Partial<LogMeasurementDialogProps> = {}) {
  return renderDialog({ entry, profile: METRIC, ...props });
}

describe('LogMeasurementDialog in edit mode', () => {
  beforeEach(() => {
    resetMeasurementCatalogCache();
  });

  it('is titled "Edit entry" and prefills only the entry\'s metrics, method, time and note', async () => {
    const entry = groupByEntry([
      mockMeasurement('weight', 80, { entryId: 'e', measuredAt: AT, method: 'scale', notes: 'Morning' }),
      mockMeasurement('body_fat_pct', 27.8, { entryId: 'e', measuredAt: AT, method: 'smart_scale', notes: 'Morning' }),
    ])[0];
    renderEdit(entry);
    expect(await screen.findByRole('dialog', { name: 'Edit entry' })).toBeInTheDocument();
    expect(await field('Weight')).toHaveValue('80.0');
    expect(screen.getByRole('textbox', { name: 'Body fat' })).toHaveValue('27.8');
    expect(screen.queryByRole('textbox', { name: 'Waist' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Systolic' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Resting heart rate' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Weight method' })).toHaveTextContent('Scale');
    expect(screen.getByRole('combobox', { name: 'Body fat method' })).toHaveTextContent('Smart scale');
    expect(screen.getByLabelText('Date and time')).toHaveValue(toDateTimeLocalValue(new Date(AT)));
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Morning');
  });

  it('prefills in the user unit (imperial)', async () => {
    renderEdit(weightEntry({ value: 94.5327 }), { profile: IMPERIAL });
    expect(await field('Weight')).toHaveValue('208.4');
  });

  it('PATCHes only the changed value, shows "Was …", and reports the saved items', async () => {
    const calls = capturePatches();
    const { user, onSaved, onClose } = renderEdit(weightEntry());
    const weight = await field('Weight');
    await user.clear(weight);
    await user.type(weight, '81');
    expect(screen.getByText('Was 80.0 kg')).toBeInTheDocument();
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual([
      { entryId: 'entry-w', body: { readings: [{ metricKey: 'weight', value: 81, unit: 'kg' }] } },
    ]);
    expect(onSaved).toHaveBeenCalledWith([expect.objectContaining({ metricKey: 'weight', value: 81 })]);
  });

  it('a note-only edit sends only the note and no reading', async () => {
    const calls = capturePatches();
    const { user, onClose } = renderEdit(weightEntry());
    const note = await screen.findByRole('textbox', { name: 'Note' });
    await user.clear(note);
    await user.type(note, 'Evening');
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.map((c) => c.body)).toEqual([{ notes: 'Evening' }]);
  });

  it('clearing the note sends notes: null', async () => {
    const calls = capturePatches();
    const { user, onClose } = renderEdit(weightEntry());
    await user.clear(await screen.findByRole('textbox', { name: 'Note' }));
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.map((c) => c.body)).toEqual([{ notes: null }]);
  });

  it('a method-only change sends the stored canonical value, never a re-rounded one', async () => {
    const calls = capturePatches();
    const { user, onClose } = renderEdit(weightEntry({ value: 94.5327 }), { profile: IMPERIAL });
    await field('Weight');
    await user.click(screen.getByRole('combobox', { name: 'Weight method' }));
    await user.click(await screen.findByRole('option', { name: 'Smart scale' }));
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.map((c) => c.body)).toEqual([
      { readings: [{ metricKey: 'weight', value: 94.5327, unit: 'kg', method: 'smart_scale' }] },
    ]);
  });

  it('saving an unchanged form closes without a request', async () => {
    const calls = capturePatches();
    const { user, onClose, onSaved } = renderEdit(weightEntry());
    await field('Weight');
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a value typed back to the original is not a change', async () => {
    const calls = capturePatches();
    const { user, onClose } = renderEdit(weightEntry());
    const weight = await field('Weight');
    await user.clear(weight);
    await user.type(weight, '80');
    expect(screen.queryByText(/^Was /)).toBeNull();
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual([]);
  });

  it('refuses an emptied value (a reading cannot be removed by editing)', async () => {
    const calls = capturePatches();
    const { user } = renderEdit(weightEntry());
    await user.clear(await field('Weight'));
    await user.click(save());
    expect(await screen.findByText('Enter a value')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('keeps the blood-pressure rule on an edited pair', async () => {
    const calls = capturePatches();
    const entry = groupByEntry([
      mockMeasurement('bp_systolic', 128, { entryId: 'bp', measuredAt: AT }),
      mockMeasurement('bp_diastolic', 84, { entryId: 'bp', measuredAt: AT }),
    ])[0];
    const { user } = renderEdit(entry);
    const systolic = await field('Systolic');
    await waitFor(() => expect(systolic).toHaveFocus());
    await user.clear(systolic);
    await user.type(systolic, '80');
    await user.click(save());
    expect(await screen.findByText('Systolic must be higher than diastolic')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('on 404 closes and reports the entry as gone', async () => {
    capturePatches(() => HttpResponse.json({ message: 'Not found' }, { status: 404 }));
    const onStale = vi.fn();
    const { user, onClose, onSaved } = renderEdit(weightEntry(), { onStale });
    const weight = await field('Weight');
    await user.clear(weight);
    await user.type(weight, '81');
    await user.click(save());
    await waitFor(() => expect(onStale).toHaveBeenCalledWith('gone'));
    expect(onClose).toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('on 409 closes and asks the caller to reload', async () => {
    capturePatches(() => HttpResponse.json({ message: 'Conflict' }, { status: 409 }));
    const onStale = vi.fn();
    const { user } = renderEdit(weightEntry(), { onStale });
    const weight = await field('Weight');
    await user.clear(weight);
    await user.type(weight, '81');
    await user.click(save());
    await waitFor(() => expect(onStale).toHaveBeenCalledWith('conflict'));
  });

  it('maps a validation 400 onto the field', async () => {
    capturePatches(() =>
      HttpResponse.json(
        {
          message: 'Validation failed',
          details: { issues: [{ path: 'readings.0.value', message: 'value is outside the allowed range' }] },
        },
        { status: 400 },
      ),
    );
    const { user } = renderEdit(weightEntry());
    const weight = await field('Weight');
    await user.clear(weight);
    await user.type(weight, '81');
    await user.click(save());
    expect(await screen.findByText('value is outside the allowed range')).toBeInTheDocument();
  });
});
