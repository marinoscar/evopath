import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import type { PrismaService } from '../../prisma/prisma.service';
import { LAB_METRIC_KEYS } from '../metric-registry';
import { biomarkerSummaryQuerySchema } from './dto/biomarker-summary.dto';
import { BiomarkersService } from './biomarkers.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

let seq = 0;

/** A ranked row as the window-function query returns it. */
function ranked(metricKey: string, rn: number, total: number, overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    metric_key: metricKey,
    value: 100,
    measured_at: new Date(Date.UTC(2026, 8, 20 - rn)),
    flag: null,
    reference_low: null,
    reference_high: null,
    reference_text: null,
    rn,
    total,
    ...overrides,
  };
}

const query = (raw: Record<string, string> = {}) => biomarkerSummaryQuerySchema.parse(raw);

/** The SQL text and parameter values of the one `$queryRaw` call. */
function sqlOf(prisma: MockPrismaService): { text: string; values: unknown[] } {
  const calls = (prisma.$queryRaw as jest.Mock).mock.calls;
  expect(calls).toHaveLength(1);
  const sql = calls[0][0];
  return { text: sql.text ?? sql.sql, values: sql.values };
}

describe('BiomarkersService', () => {
  let service: BiomarkersService;
  let prisma: MockPrismaService;

  beforeEach(() => {
    prisma = createMockPrismaService();
    service = new BiomarkersService(prisma as unknown as PrismaService);
  });

  it('runs one owner-scoped query over active lab rows, ranked newest first, top two per analyte', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    await service.summary(USER_ID, query());

    const { text, values } = sqlOf(prisma);
    expect(text).toMatch(/user_id = \$1::uuid/);
    expect(text).toContain('superseded_at IS NULL');
    expect(text).toContain('deleted_at IS NULL');
    expect(text).toMatch(/PARTITION BY metric_key\s+ORDER BY measured_at DESC, created_at DESC, id DESC/);
    expect(text).toContain('rn <= 2');
    expect(values).toEqual([USER_ID, ...LAB_METRIC_KEYS]);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  it('builds latest, previous and delta per analyte, in catalog order, only analytes with values', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      // Returned out of catalog order on purpose.
      ranked('hba1c', 1, 1, { value: 5.6, flag: 'normal', reference_high: 5.6, reference_text: '<5.7' }),
      ranked('ldl_cholesterol', 2, 3, { value: 140.1, flag: 'high', reference_low: 0, reference_high: 99 }),
      ranked('ldl_cholesterol', 1, 3, { value: 120.3, flag: 'high', reference_low: 0, reference_high: 129 }),
    ]);

    const { items } = await service.summary(USER_ID, query());

    expect(items.map((item) => item.analyteKey)).toEqual(['ldl_cholesterol', 'hba1c']);

    const [ldl, hba1c] = items;
    expect(ldl).toMatchObject({
      analyteKey: 'ldl_cholesterol',
      label: 'LDL cholesterol',
      panel: 'lipids',
      unit: 'mg/dL',
      count: 3,
      delta: -19.8,
    });
    expect(ldl.latest).toEqual({
      measurementId: expect.any(String),
      value: 120.3,
      measuredAt: '2026-09-19T00:00:00.000Z',
      flag: 'high',
      referenceLow: 0,
      referenceHigh: 129,
      referenceText: null,
    });
    expect(ldl.previous).toMatchObject({ value: 140.1, referenceHigh: 99, measuredAt: '2026-09-18T00:00:00.000Z' });

    expect(hba1c).toMatchObject({ unit: '%', panel: 'glycemic', count: 1, previous: null, delta: null });
    expect(hba1c.latest).toMatchObject({ value: 5.6, referenceHigh: 5.6, referenceText: '<5.7', flag: 'normal' });
  });

  it('returns no items when the caller has no lab results', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    await expect(service.summary(USER_ID, query())).resolves.toEqual({ items: [] });
  });

  it('panel narrows the query to that panel\'s analytes', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([ranked('tsh', 1, 1)]);

    const { items } = await service.summary(USER_ID, query({ panel: 'thyroid' }));

    expect(sqlOf(prisma).values).toEqual([USER_ID, 'tsh', 'free_t4', 'free_t3']);
    expect(items.map((item) => item.analyteKey)).toEqual(['tsh']);
  });

  it('outOfRange keeps analytes whose LATEST flag is low, high or critical', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      ranked('total_cholesterol', 1, 2, { flag: 'normal' }),
      ranked('total_cholesterol', 2, 2, { flag: 'high' }),
      ranked('ldl_cholesterol', 1, 1, { flag: 'high' }),
      ranked('hdl_cholesterol', 1, 1, { flag: 'low' }),
      ranked('triglycerides', 1, 1, { flag: 'critical' }),
      ranked('fasting_glucose', 1, 1, { flag: 'unknown' }),
      ranked('hba1c', 1, 1, { flag: null }),
    ]);

    const { items } = await service.summary(USER_ID, query({ outOfRange: 'true' }));

    expect(items.map((item) => item.analyteKey)).toEqual(['ldl_cholesterol', 'hdl_cholesterol', 'triglycerides']);
  });

  it('outOfRange=false keeps everything', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      ranked('ldl_cholesterol', 1, 1, { flag: 'normal' }),
      ranked('hba1c', 1, 1, { flag: 'high' }),
    ]);

    const { items } = await service.summary(USER_ID, query({ outOfRange: 'false' }));

    expect(items).toHaveLength(2);
  });

  it('a delta of zero is 0, and float noise is rounded to 4 decimals', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      ranked('ldl_cholesterol', 1, 2, { value: 0.3 }),
      ranked('ldl_cholesterol', 2, 2, { value: 0.1 }),
      ranked('hdl_cholesterol', 1, 2, { value: 50 }),
      ranked('hdl_cholesterol', 2, 2, { value: 50 }),
    ]);

    const { items } = await service.summary(USER_ID, query());

    expect(items.map((item) => item.delta)).toEqual([0.2, 0]);
  });

  describe('query schema', () => {
    it('refuses an unknown panel, a non-boolean outOfRange and unknown keys', () => {
      expect(biomarkerSummaryQuerySchema.safeParse({ panel: 'urine' }).success).toBe(false);
      expect(biomarkerSummaryQuerySchema.safeParse({ outOfRange: 'yes' }).success).toBe(false);
      expect(biomarkerSummaryQuerySchema.safeParse({ metricKey: 'ldl_cholesterol' }).success).toBe(false);
    });

    it('defaults outOfRange to false', () => {
      expect(query()).toEqual({ outOfRange: false });
    });
  });
});
