import {
  catalogView,
  foldAnalyteName,
  fromCanonical,
  getMetric,
  isLabMetric,
  LAB_METRIC_KEYS,
  LAB_PANELS,
  MEASUREMENT_METHODS,
  resolveLabAnalyte,
  toCanonical,
  unitFor,
} from './metric-registry';

// =============================================================================
// The lab catalog (H3, #187): keys, panels, canonical units, conversions
// pinned on published reference values, and alias lookup.
// =============================================================================

describe('lab catalog', () => {
  const PANELS: Record<string, string[]> = {
    lipids: [
      'total_cholesterol',
      'ldl_cholesterol',
      'hdl_cholesterol',
      'triglycerides',
      'non_hdl_cholesterol',
      'apob',
    ],
    glycemic: ['fasting_glucose', 'hba1c', 'fasting_insulin'],
    cbc: ['hemoglobin', 'hematocrit', 'rbc_count', 'wbc_count', 'platelet_count', 'mcv'],
    cmp: [
      'alt',
      'ast',
      'alp',
      'total_bilirubin',
      'albumin',
      'creatinine',
      'egfr',
      'bun',
      'sodium',
      'potassium',
    ],
    thyroid: ['tsh', 'free_t4', 'free_t3'],
    iron: ['ferritin', 'serum_iron', 'tibc', 'transferrin_saturation'],
    other: [
      'vitamin_d_25oh',
      'vitamin_b12',
      'hs_crp',
      'testosterone_total',
      'testosterone_free',
      'cortisol',
      'uric_acid',
    ],
  };

  it('has exactly the issue catalog, panel by panel, in order (keys are permanent)', () => {
    expect(LAB_METRIC_KEYS).toEqual(LAB_PANELS.flatMap((panel) => PANELS[panel]));
    for (const panel of LAB_PANELS) {
      expect(LAB_METRIC_KEYS.filter((key) => getMetric(key)!.panel === panel)).toEqual(PANELS[panel]);
    }
  });

  it.each(LAB_METRIC_KEYS)('%s is a well-formed lab entry', (key) => {
    const metric = getMetric(key)!;

    expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(isLabMetric(key)).toBe(true);
    expect(metric.category).toBe('lab');
    expect(metric.daily).toBe(false);
    expect(metric.scale).toBeUndefined();
    expect(metric.units[0]).toMatchObject({ unit: metric.canonicalUnit, factor: 1 });
    expect(metric.units[0].offset ?? 0).toBe(0);
    expect(metric.displayUnit).toEqual({ metric: metric.canonicalUnit, imperial: metric.canonicalUnit });
    expect(metric.min).toBeLessThan(metric.max);
    expect(Number.isInteger(metric.decimals)).toBe(true);
    expect(metric.methods).toEqual(['unspecified', 'lab', 'point_of_care', 'clinical', 'other']);
    expect(metric.aliases!.length).toBeGreaterThan(0);
    expect(new Set(metric.units.map((u) => u.unit)).size).toBe(metric.units.length);
    for (const unit of metric.units) {
      expect(unit.unit.length).toBeLessThanOrEqual(16);
      expect(Number.isFinite(unit.factor) && unit.factor > 0).toBe(true);
    }
  });

  it('only uses methods from the shared vocabulary', () => {
    const vocabulary = new Set<string>(MEASUREMENT_METHODS.map((m) => m.key));
    for (const key of LAB_METRIC_KEYS) {
      for (const method of getMetric(key)!.methods) expect(vocabulary.has(method)).toBe(true);
    }
  });

  it('uses the US conventional unit as canonical', () => {
    const canonical = Object.fromEntries(LAB_METRIC_KEYS.map((key) => [key, getMetric(key)!.canonicalUnit]));
    expect(canonical).toMatchObject({
      total_cholesterol: 'mg/dL',
      triglycerides: 'mg/dL',
      fasting_glucose: 'mg/dL',
      hba1c: '%',
      creatinine: 'mg/dL',
      bun: 'mg/dL',
      hemoglobin: 'g/dL',
      platelet_count: '10^3/µL',
      alt: 'U/L',
      tsh: 'mIU/L',
      ferritin: 'ng/mL',
      serum_iron: 'µg/dL',
      vitamin_d_25oh: 'ng/mL',
      vitamin_b12: 'pg/mL',
      testosterone_total: 'ng/dL',
      hs_crp: 'mg/L',
    });
  });

  describe('conversions, pinned on known values', () => {
    // key | canonical value | alternative unit | the same value in that unit | decimals compared
    const KNOWN: Array<[string, number, string, number, number]> = [
      ['fasting_glucose', 100, 'mmol/L', 5.55, 2],
      ['fasting_glucose', 126, 'mmol/L', 7.0, 1],
      ['total_cholesterol', 200, 'mmol/L', 5.17, 2],
      ['ldl_cholesterol', 100, 'mmol/L', 2.59, 2],
      ['hdl_cholesterol', 40, 'mmol/L', 1.03, 2],
      ['non_hdl_cholesterol', 130, 'mmol/L', 3.36, 2],
      ['triglycerides', 150, 'mmol/L', 1.69, 2],
      ['apob', 90, 'g/L', 0.9, 2],
      ['hba1c', 6.5, 'mmol/mol', 48, 0],
      ['hba1c', 7.0, 'mmol/mol', 53, 0],
      ['hba1c', 5.7, 'mmol/mol', 39, 0],
      ['fasting_insulin', 10, 'pmol/L', 60, 0],
      ['fasting_insulin', 10, 'mIU/L', 10, 0],
      ['hemoglobin', 14, 'g/L', 140, 0],
      ['hemoglobin', 14.5, 'mmol/L', 9.0, 1],
      ['hematocrit', 45, 'L/L', 0.45, 2],
      ['rbc_count', 5, '10^12/L', 5, 2],
      ['wbc_count', 6.5, '10^9/L', 6.5, 1],
      ['platelet_count', 250, '10^9/L', 250, 0],
      ['alt', 60, 'µkat/L', 1, 2],
      ['ast', 30, 'IU/L', 30, 0],
      ['alp', 120, 'µkat/L', 2, 2],
      ['total_bilirubin', 1, 'µmol/L', 17.1, 1],
      ['albumin', 4, 'g/L', 40, 0],
      ['creatinine', 1, 'µmol/L', 88.42, 2],
      ['bun', 14, 'mmol/L', 5.0, 1],
      ['sodium', 140, 'mEq/L', 140, 0],
      ['potassium', 4.2, 'mEq/L', 4.2, 1],
      ['tsh', 2.5, 'µIU/mL', 2.5, 2],
      ['free_t4', 1.2, 'pmol/L', 15.4, 1],
      ['free_t3', 3.2, 'pmol/L', 4.9, 1],
      ['ferritin', 100, 'µg/L', 100, 0],
      ['serum_iron', 100, 'µmol/L', 17.9, 1],
      ['tibc', 300, 'µmol/L', 53.7, 1],
      ['vitamin_d_25oh', 30, 'nmol/L', 74.9, 1],
      ['vitamin_b12', 300, 'pmol/L', 221.3, 1],
      ['hs_crp', 3, 'mg/dL', 0.3, 1],
      ['testosterone_total', 500, 'nmol/L', 17.3, 1],
      ['testosterone_free', 100, 'pmol/L', 346.7, 1],
      ['testosterone_free', 100, 'ng/dL', 10, 1],
      ['cortisol', 20, 'nmol/L', 551.8, 1],
      ['uric_acid', 6, 'µmol/L', 356.9, 1],
    ];

    it.each(KNOWN)('%s %d canonical = %d in %s... (and back)', (key, canonical, unit, inUnit, decimals) => {
      expect(fromCanonical(key, canonical, unit).toFixed(decimals)).toBe(inUnit.toFixed(decimals));
      // Back to canonical from the rounded SI value lands within the rounding.
      const back = toCanonical(key, inUnit, unit);
      const tolerance = Math.abs(toCanonical(key, inUnit + 0.5 * 10 ** -decimals, unit) - back) + 1e-4;
      expect(Math.abs(back - canonical)).toBeLessThanOrEqual(tolerance);
    });

    it('converts glucose 5.55 mmol/L to 100 mg/dL and HbA1c 48 mmol/mol to 6.5 %', () => {
      expect(Math.round(toCanonical('fasting_glucose', 5.55, 'mmol/L'))).toBe(100);
      expect(toCanonical('hba1c', 48, 'mmol/mol').toFixed(1)).toBe('6.5');
      // The IFCC-NGSP master equation has an intercept: it is not a pure factor.
      expect(getMetric('hba1c')!.units[1].offset).toBe(2.15);
    });

    it('round-trips every alternative unit within the canonical rounding', () => {
      for (const key of LAB_METRIC_KEYS) {
        const metric = getMetric(key)!;
        for (const unit of metric.units) {
          for (const canonical of [metric.max / 7, metric.max / 3]) {
            const shown = fromCanonical(key, canonical, unit.unit);
            const back = fromCanonical(key, toCanonical(key, shown, unit.unit), unit.unit);
            // Canonical storage rounds to 4 decimals: at most half of that, scaled by the factor.
            expect(Math.abs(back - shown)).toBeLessThanOrEqual(0.5e-4 / unit.factor + 1e-9);
          }
        }
      }
    });

    it('matches lab spellings of a unit (case, u or mu for micro) for labs only', () => {
      expect(unitFor('creatinine', 'umol/l')?.unit).toBe('µmol/L');
      expect(unitFor('creatinine', 'μmol/L')?.unit).toBe('µmol/L');
      expect(unitFor('fasting_glucose', 'MMOL/L')?.unit).toBe('mmol/L');
      expect(toCanonical('creatinine', 88.42, 'umol/L')).toBe(1);
      expect(unitFor('weight', 'KG')).toBeUndefined();
      expect(unitFor('fasting_glucose', 'g/L')).toBeUndefined();
    });
  });

  describe('resolveLabAnalyte', () => {
    it.each([
      ['LDL-C', 'ldl_cholesterol'],
      ['LDL Cholesterol', 'ldl_cholesterol'],
      ['Low density lipoprotein', 'ldl_cholesterol'],
      ['low-density lipoprotein cholesterol', 'ldl_cholesterol'],
      ['  ldl_cholesterol ', 'ldl_cholesterol'],
      ['HDL-C', 'hdl_cholesterol'],
      ['Cholesterol, Total', 'total_cholesterol'],
      ['Non-HDL Cholesterol', 'non_hdl_cholesterol'],
      ['Apo B', 'apob'],
      ['TRIGLYCERIDES', 'triglycerides'],
      ['Glucose, Fasting', 'fasting_glucose'],
      ['Hemoglobin A1c', 'hba1c'],
      ['HbA1c', 'hba1c'],
      ['Hgb', 'hemoglobin'],
      ['Haemoglobin', 'hemoglobin'],
      ['PLT', 'platelet_count'],
      ['SGPT', 'alt'],
      ['S.G.O.T.', 'ast'],
      ['Alk. Phos.', 'alp'],
      ['eGFR', 'egfr'],
      ['BUN', 'bun'],
      ['Na+', 'sodium'],
      ['TSH', 'tsh'],
      ['Free T4', 'free_t4'],
      ['FT3', 'free_t3'],
      ['TIBC', 'tibc'],
      ['% Saturation', 'transferrin_saturation'],
      ['25(OH)D', 'vitamin_d_25oh'],
      ['Vitamin D, 25-Hydroxy', 'vitamin_d_25oh'],
      ['hsCRP', 'hs_crp'],
      ['Testosterone, Total', 'testosterone_total'],
      ['Testosterone, Free', 'testosterone_free'],
      ['Uric Acid', 'uric_acid'],
    ])('resolves %p to %s', (name, key) => {
      expect(resolveLabAnalyte(name)?.key).toBe(key);
    });

    it('never guesses', () => {
      expect(resolveLabAnalyte('')).toBeUndefined();
      expect(resolveLabAnalyte('---')).toBeUndefined();
      expect(resolveLabAnalyte('Lipoprotein(a)')).toBeUndefined();
      expect(resolveLabAnalyte('weight')).toBeUndefined();
      expect(resolveLabAnalyte('energy')).toBeUndefined();
    });

    it('folds case, accents, spaces and punctuation', () => {
      expect(foldAnalyteName('LDL-C')).toBe('ldlc');
      expect(foldAnalyteName('Hémoglobine A1c')).toBe('hemoglobinea1c');
    });

    it('has no alias shared by two analytes (loading would throw)', () => {
      const owner = new Map<string, string>();
      for (const key of LAB_METRIC_KEYS) {
        const metric = getMetric(key)!;
        for (const name of [key, metric.label, ...metric.aliases!]) {
          const folded = foldAnalyteName(name);
          expect([undefined, key]).toContain(owner.get(folded));
          owner.set(folded, key);
        }
      }
    });
  });

  it('publishes panel, aliases and offsets in the catalog; null/empty/0 elsewhere', () => {
    const byKey = new Map(catalogView().metrics.map((m) => [m.key, m]));

    expect(byKey.get('ldl_cholesterol')).toMatchObject({
      category: 'lab',
      panel: 'lipids',
      canonicalUnit: 'mg/dL',
    });
    expect(byKey.get('ldl_cholesterol')!.aliases).toContain('LDL-C');
    expect(byKey.get('hba1c')!.units).toEqual([
      { unit: '%', factor: 1, offset: 0, label: '%' },
      { unit: 'mmol/mol', factor: 1 / 10.929, offset: 2.15, label: 'mmol/mol' },
    ]);
    expect(byKey.get('weight')).toMatchObject({ panel: null, aliases: [] });
    expect(byKey.get('weight')!.units.every((u) => u.offset === 0)).toBe(true);
  });
});
