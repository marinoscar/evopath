/**
 * `services/labReport.ts` (H4, #188): the duplicates route, the presentation
 * helpers (panel grouping, attention, unresolved, alias search, range text)
 * and how a refused apply is read.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  analyteMatches,
  getLabReportDuplicates,
  groupByPanel,
  isUnresolved,
  labApplyRefusal,
  labResultPayload,
  needsAttention,
  referenceRangeText,
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
});
