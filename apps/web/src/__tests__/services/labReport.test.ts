/**
 * `services/labReport.ts` (H4, #188): the duplicates route, the presentation
 * helpers (panel grouping, attention, unresolved, alias search, range text)
 * and how a refused apply is read; #305: per-result dates (grouping, the
 * effective date, the edit payload), the high-confidence count and the
 * saved message for several entries; #307: the map route and its message.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  analyteMatches,
  effectiveDate,
  emptyLabResult,
  formatLabDate,
  getLabReportDuplicates,
  groupByDate,
  groupByPanel,
  isHighConfidencePending,
  isUnresolved,
  labApplyRefusal,
  foldPrintedName,
  labEditChange,
  labMappedMessage,
  labPropagatedMessage,
  labResultPayload,
  mapLabResult,
  labSavedMessage,
  needsAttention,
  referenceRangeText,
  sameNamedOthers,
  type LabReportValue,
} from '../../services/labReport';
import { LAB_METRICS, labItem, labValue, panelItems } from '../mocks/fixtures/labReportIntake';

describe('labReport service', () => {
  it('reads the duplicate warning for an intake', async () => {
    let path = '';
    server.use(
      http.get('*/api/measurements/lab-reports/:id/duplicates', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ data: { intakeId: 'a b', checkedDate: '2026-09-15', collectionDate: '2026-09-15', duplicates: [] } });
      }),
    );
    const result = await getLabReportDuplicates('a b');
    expect(path).toBe('/api/measurements/lab-reports/a%20b/duplicates');
    expect(result.duplicates).toEqual([]);
  });

  it('groups by panel in catalog panel order; an unknown or missing panel is Other', () => {
    const items = [
      labItem(labValue({ panel: 'glycemic' })),
      labItem(labValue({ panel: null })),
      labItem(labValue({ panel: 'lipids' })),
      labItem(labValue({ panel: 'thyroid' })),
    ];
    expect(groupByPanel(items).map((group) => [group.panel, group.items.length])).toEqual([
      ['lipids', 1],
      ['glycemic', 1],
      ['thyroid', 1],
      ['other', 1],
    ]);
  });

  it('marks unmatched, suggested, unsure and low-confidence results for attention', () => {
    const [cholesterol, , , , lpa] = panelItems();
    expect(needsAttention(cholesterol)).toBe(false);
    expect(needsAttention(lpa)).toBe(true);
    expect(needsAttention(labItem(labValue({ analyteKey: 'hba1c', match: 'suggested' })))).toBe(true);
    expect(needsAttention(labItem(labValue({ analyteKey: 'hba1c' }), { confidence: 'low' }))).toBe(true);
    expect(isUnresolved(lpa)).toBe(true);
    expect(isUnresolved({ ...lpa, status: 'rejected' })).toBe(false);
  });

  it('finds an analyte by label, key or alias, case-insensitively', () => {
    const apob = LAB_METRICS.find((m) => m.key === 'apob')!;
    expect(analyteMatches(apob, 'apo b')).toBe(true);
    expect(analyteMatches(apob, 'APOLIPO')).toBe(true);
    expect(analyteMatches(apob, 'glucose')).toBe(false);
  });

  it('writes the range as limits, else the printed text', () => {
    expect(referenceRangeText(labValue({ referenceLow: 70.27031, referenceHigh: 99.0991 }))).toBe('70.2703–99.0991');
    expect(referenceRangeText(labValue({ referenceHigh: 200 }))).toBe('≤ 200');
    expect(referenceRangeText(labValue({ referenceLow: 39 }))).toBe('≥ 39');
    expect(referenceRangeText(labValue({ referenceText: 'negative' }))).toBe('negative');
    expect(referenceRangeText(labValue({}))).toBeNull();
  });

  it('leaves the server-owned match and panel out of an edit', () => {
    const payload = labResultPayload(labValue({ analyteKey: 'tsh', value: 2, panel: 'thyroid', match: 'matched' }));
    expect(payload).not.toHaveProperty('match');
    expect(payload).not.toHaveProperty('panel');
    expect(payload).toMatchObject({ analyteKey: 'tsh', value: 2 });
  });

  it('reads the apply refusals', () => {
    expect(
      labApplyRefusal(new ApiError('x', 409, 'CONFLICT', { reason: 'UNRESOLVED_ANALYTES', itemIds: ['a', 'b'], count: 2 })),
    ).toEqual({ kind: 'unresolved', itemIds: ['a', 'b'] });
    expect(labApplyRefusal(new ApiError('x', 400, 'BAD_REQUEST', { reason: 'PENDING_ITEMS', count: 1 }))).toEqual({ kind: 'pending' });
    expect(
      labApplyRefusal(
        new ApiError('x', 400, 'VALIDATION_ERROR', {
          issues: [
            { path: 'items.a.value.value', message: 'HDL cholesterol has no numeric value; enter one or reject it' },
            { path: 'items.b.value.value', message: 'HDL cholesterol has no numeric value; enter one or reject it' },
          ],
        }),
      ),
    ).toEqual({ kind: 'issues', messages: ['HDL cholesterol has no numeric value; enter one or reject it'] });
    const other = new Error('offline');
    expect(labApplyRefusal(other)).toEqual({ kind: 'other', error: other });
  });

  describe('per-result dates (#305)', () => {
    const dated = (date: string | null, name: string) => labItem(labValue({ nameAsPrinted: name, collectionDate: date }));

    it('groups by effective date, newest first, the undated group last', () => {
      const items = [dated('2023-04-06', 'a'), dated(null, 'b'), dated('2025-11-19', 'c'), dated('2023-04-06', 'd')];
      expect(groupByDate(items, null).map((g) => [g.date, g.items.map((i) => i.value.nameAsPrinted)])).toEqual([
        ['2025-11-19', ['c']],
        ['2023-04-06', ['a', 'd']],
        [null, ['b']],
      ]);
      // With a report date, an undated result joins that date's group.
      expect(groupByDate(items, '2025-11-19').map((g) => [g.date, g.items.length])).toEqual([
        ['2025-11-19', 2],
        ['2023-04-06', 2],
      ]);
    });

    it('reads a draft from before #305 (no collectionDate) as undated', () => {
      const old = { ...labValue({}) } as Partial<LabReportValue>;
      delete old.collectionDate;
      expect(effectiveDate(old as LabReportValue, '2026-09-15')).toBe('2026-09-15');
      expect(effectiveDate(old as LabReportValue, null)).toBeNull();
      expect(labResultPayload(old as LabReportValue).collectionDate).toBeNull();
    });

    it('sends the date on an edit and starts an added value without one', () => {
      expect(labResultPayload(labValue({ collectionDate: '2024-01-02' }))).toMatchObject({ collectionDate: '2024-01-02' });
      expect(emptyLabResult().collectionDate).toBeNull();
    });

    it('formats a calendar date without moving it', () => {
      expect(formatLabDate('2025-11-19')).toBe('Nov 19, 2025');
      expect(formatLabDate('not a date')).toBe('not a date');
    });
  });

  it('counts only pending, high-confidence, sure results as high confidence', () => {
    const base = labValue({});
    expect(isHighConfidencePending(labItem(base))).toBe(true);
    expect(isHighConfidencePending(labItem(base, { confidence: 'medium' }))).toBe(false);
    expect(isHighConfidencePending(labItem(base, { uncertain: true }))).toBe(false);
    expect(isHighConfidencePending(labItem(base, { status: 'accepted' }))).toBe(false);
  });

  it('says how many results and dates were saved', () => {
    const items = (n: number) => Array.from({ length: n }, () => ({}) as never);
    expect(labSavedMessage({ items: [] })).toBe('Nothing was saved');
    expect(labSavedMessage({ items: items(7) })).toBe('Saved 7 lab results to Health');
    expect(labSavedMessage({ items: items(1), entries: [{ entryId: 'e', collectionDate: null, items: [] }] })).toBe(
      'Saved 1 lab result to Health',
    );
    const entries = Array.from({ length: 5 }, (_, i) => ({ entryId: `e${i}`, collectionDate: `2025-0${i + 1}-01`, items: [] }));
    expect(labSavedMessage({ items: items(85), entries })).toBe('Saved 85 results on 5 dates');
  });

  it('maps a result through the map route and unwraps the envelope (#307)', async () => {
    let path = '';
    let body: unknown;
    const mapped = labItem(labValue({ analyteKey: 'chol_hdl_ratio', nameAsPrinted: 'Chol/HDL Ratio', match: 'user_mapped' }));
    server.use(
      http.post('*/api/measurements/lab-reports/:id/map', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({ data: { items: [mapped], skipped: [{ itemId: 'x', message: 'nope' }] } });
      }),
    );
    const result = await mapLabResult('a b', 'item-1', { analyteKey: 'chol_hdl_ratio' });
    expect(path).toBe('/api/measurements/lab-reports/a%20b/map');
    expect(body).toEqual({ itemId: 'item-1', analyteKey: 'chol_hdl_ratio' });
    expect(result.items).toEqual([mapped]);
    expect(result.skipped).toEqual([{ itemId: 'x', message: 'nope' }]);
  });

  it('says how many same-named results were mapped and how many were not (#307)', () => {
    const items = (n: number) => Array.from({ length: n }, () => labItem(labValue({})));
    const skipped = (n: number) => Array.from({ length: n }, (_, i) => ({ itemId: `s${i}`, message: 'unit' }));
    const label = 'Cholesterol/HDL ratio';
    expect(labMappedMessage({ items: items(1), skipped: [] }, 'Chol/HDL Ratio', label)).toBeNull();
    expect(labMappedMessage({ items: items(5), skipped: [] }, 'Chol/HDL Ratio', label)).toEqual({
      message: 'Mapped 5 results named “Chol/HDL Ratio” to Cholesterol/HDL ratio',
      severity: 'success',
    });
    expect(labMappedMessage({ items: items(1), skipped: skipped(2) }, 'Chol/HDL Ratio', label)).toEqual({
      message: 'Mapped “Chol/HDL Ratio” to Cholesterol/HDL ratio. 2 could not be mapped',
      severity: 'warning',
    });
    expect(labMappedMessage({ items: items(3), skipped: skipped(1) }, null, label)?.message).toBe(
      'Mapped 3 results to Cholesterol/HDL ratio. 1 could not be mapped',
    );
  });

  it('sends only the changes it is given to the map route (#307)', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('*/api/measurements/lab-reports/:id/map', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ data: { items: [], skipped: [] } });
      }),
    );
    await mapLabResult('i', 'item-1', { unit: 'mmol/L' });
    await mapLabResult('i', 'item-1', { analyteKey: 'fasting_glucose', unit: 'mmol/L' });
    expect(bodies).toEqual([
      { itemId: 'item-1', unit: 'mmol/L' },
      { itemId: 'item-1', analyteKey: 'fasting_glucose', unit: 'mmol/L' },
    ]);
  });

  it('finds the same-named results an edit should be carried to (#307)', () => {
    const edited = labItem(labValue({ nameAsPrinted: '  Glucose  Lvl ' }));
    const same = labItem(labValue({ nameAsPrinted: 'glucose lvl' }));
    const rejected = labItem(labValue({ nameAsPrinted: 'Glucose Lvl' }), { status: 'rejected' });
    const other = labItem(labValue({ nameAsPrinted: 'Glucose' }));
    expect(foldPrintedName('  Glucose  Lvl ')).toBe('glucose lvl');
    expect(sameNamedOthers([edited, same, rejected, other], edited).map((item) => item.id)).toEqual([same.id]);
    expect(sameNamedOthers([edited, same], labItem(labValue({ nameAsPrinted: null })))).toEqual([]);
  });

  it('reads the analyte and unit change an edit makes (#307)', () => {
    const before = { analyteKey: 'fasting_glucose', unit: 'mg/dL' };
    expect(labEditChange(before, { analyteKey: 'fasting_glucose', unit: 'mg/dL' })).toBeNull();
    expect(labEditChange(before, { analyteKey: 'fasting_glucose', unit: 'mmol/L' })).toEqual({ unit: 'mmol/L' });
    expect(labEditChange(before, { analyteKey: 'hba1c', unit: 'mg/dL' })).toEqual({ analyteKey: 'hba1c' });
    expect(labEditChange(before, { analyteKey: 'hba1c', unit: '%' })).toEqual({ analyteKey: 'hba1c', unit: '%' });
    expect(labEditChange(before, { analyteKey: null, unit: null })).toBeNull();
  });

  it('says how many other same-named results an edit updated (#307)', () => {
    const edited = labItem(labValue({}));
    const others = (n: number) => Array.from({ length: n }, () => labItem(labValue({})));
    expect(labPropagatedMessage({ items: [edited], skipped: [] }, edited.id, 'Glucose Lvl')).toBeNull();
    expect(labPropagatedMessage({ items: [edited, ...others(4)], skipped: [] }, edited.id, 'Glucose Lvl')).toEqual({
      message: 'Updated 4 other results named “Glucose Lvl”',
      severity: 'success',
    });
    expect(
      labPropagatedMessage({ items: others(1), skipped: [{ itemId: 's', message: 'unit' }] }, edited.id, 'Glucose Lvl'),
    ).toEqual({ message: 'Updated 1 other result named “Glucose Lvl”. 1 could not be updated', severity: 'warning' });
  });
});
