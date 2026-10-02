// =============================================================================
// Metric registry — the vocabulary of the `measurements` table (E2.2, #50)
// =============================================================================
//
// `measurements.metric_key`, `.method` and `.unit` are plain strings on
// purpose: this file (plus the Zod schemas built on it) owns the vocabulary,
// so a new metric or method needs no migration — the same reason `Job.type` is
// a string.
//
// Every value is STORED in the metric's canonical unit. The API converts once
// on write (`toCanonical`), rounds to 4 decimals, and publishes the factors in
// `GET /api/measurements/metrics` (`catalogView`) so the web app never keeps a
// second copy of them.
//
// Conversion is affine: canonical = value x `factor` + `offset` (offset 0 for
// every unit but HbA1c in mmol/mol, whose IFCC/NGSP master equation has an
// intercept). Both numbers are published, so a client converts without code.
//
// LAB ANALYTES (H3, #187) use the US conventional unit as canonical (mg/dL,
// ng/mL, U/L, 10^3/uL ...), whatever the user's unit system: labs outside the
// US report either convention, so the stored unit is one fixed choice per
// analyte and SI units are accepted alternatives. The factors are
// analyte-specific where molar mass matters (glucose, cholesterol ...).
//
// LAB UNIT PREFERENCE (#234). Each analyte also names its `siUnit` (one of
// its units, the canonical one when SI and conventional agree) and that
// unit's display `decimals`. The user's `labUnits` preference picks the unit
// a lab value is SHOWN in ({@link labDisplayUnit}, {@link toDisplayUnit});
// storage stays canonical.
//
// Deliberately free of Nest and Prisma imports: it is pure data plus pure
// functions, trivially unit-testable, and importable from any later feature
// (check-ins, photo intake) without pulling in a module.
// =============================================================================

export const METRIC_CATEGORIES = ['body', 'vital', 'wellness', 'lab'] as const;
export type MetricCategory = (typeof METRIC_CATEGORIES)[number];

/** The panel a lab analyte is grouped under (display grouping only). */
export const LAB_PANELS = ['lipids', 'glycemic', 'cbc', 'cmp', 'thyroid', 'iron', 'other'] as const;
export type LabPanel = (typeof LAB_PANELS)[number];

/**
 * How a value was physically measured (VISION §18). One shared list; each
 * metric allows a subset. Order is display order.
 */
export const MEASUREMENT_METHODS = [
  { key: 'unspecified', label: 'Not specified' },
  { key: 'scale', label: 'Scale' },
  { key: 'smart_scale', label: 'Smart scale' },
  { key: 'bia', label: 'Bioelectrical impedance (BIA)' },
  { key: 'dexa', label: 'DEXA scan' },
  { key: 'air_displacement', label: 'Air displacement' },
  { key: 'skinfold', label: 'Skinfold calipers' },
  { key: 'hydrostatic', label: 'Hydrostatic weighing' },
  { key: 'tape', label: 'Tape measure' },
  { key: 'bp_cuff', label: 'Blood-pressure cuff' },
  { key: 'manual_pulse', label: 'Manual pulse' },
  { key: 'wearable', label: 'Wearable' },
  { key: 'clinical', label: 'Clinical' },
  { key: 'self_report', label: 'Self-report' },
  { key: 'other', label: 'Other' },
  { key: 'lab', label: 'Laboratory test' },
  { key: 'point_of_care', label: 'Point-of-care or home test' },
] as const;

export type MeasurementMethod = (typeof MEASUREMENT_METHODS)[number]['key'];

/** The method a reading gets when the client names none. */
export const DEFAULT_METHOD: MeasurementMethod = 'unspecified';

/**
 * How a value entered the system — never the same thing as `method`. Only
 * server code sets it: `manual` for everything written through
 * `/api/measurements`; `ai` when an accepted photo-intake draft is applied.
 */
export const MEASUREMENT_ORIGINS = ['manual', 'calculated', 'ai', 'device'] as const;
export type MeasurementOrigin = (typeof MEASUREMENT_ORIGINS)[number];

export interface MetricUnitDef {
  unit: string;
  /** Multiply a value in `unit` by this (then add `offset`) to get the canonical unit. */
  factor: number;
  /** Added after `factor`; omitted = 0. Only HbA1c in mmol/mol has one. */
  offset?: number;
  label: string;
  /**
   * Display precision of a value shown in this unit (#234). Omitted = the
   * metric's `decimals` (which is the canonical unit's precision).
   */
  decimals?: number;
}

export interface MetricScaleDef {
  min: number;
  max: number;
  lowLabel: string;
  highLabel: string;
}

export interface MetricDef {
  key: string;
  label: string;
  category: MetricCategory;
  canonicalUnit: string;
  units: readonly MetricUnitDef[];
  displayUnit: { metric: string; imperial: string };
  /** Hard bounds, inclusive, in the canonical unit. */
  min: number;
  max: number;
  /** Display precision. */
  decimals: number;
  methods: readonly MeasurementMethod[];
  scale?: MetricScaleDef;
  /** One value per local day (check-in scores); stored with `localDate`. */
  daily: boolean;
  /** Lab analytes only: the panel it is shown under. */
  panel?: LabPanel;
  /** Lab analytes only: other names labs print, matched by {@link resolveLabAnalyte}. */
  aliases?: readonly string[];
  /**
   * Lab analytes only (#234): the unit shown when the user prefers SI lab
   * units. Always one of `units`; equals `canonicalUnit` when SI and US
   * conventional agree (U/L, mmol/L electrolytes, %).
   */
  siUnit?: string;
}

const BODY_WEIGHT_METHODS = ['unspecified', 'scale', 'smart_scale', 'clinical', 'other'] as const;
const BODY_FAT_METHODS = [
  'unspecified',
  'smart_scale',
  'bia',
  'skinfold',
  'dexa',
  'air_displacement',
  'hydrostatic',
  'other',
] as const;
const WAIST_METHODS = ['unspecified', 'tape', 'other'] as const;
const BP_METHODS = ['unspecified', 'bp_cuff', 'clinical', 'wearable', 'other'] as const;
const RESTING_HR_METHODS = ['unspecified', 'wearable', 'bp_cuff', 'manual_pulse', 'other'] as const;
/** Average heart rate and HRV come from wearables (Health Connect, epic #276). */
const HEART_RATE_AVG_METHODS = ['unspecified', 'wearable', 'other'] as const;
const HRV_METHODS = ['unspecified', 'wearable', 'other'] as const;
const WELLNESS_METHODS = ['self_report'] as const;

const SCORE_UNITS = [{ unit: 'score', factor: 1, label: 'score' }] as const;
const SCORE_DISPLAY = { metric: 'score', imperial: 'score' } as const;

function wellness(
  key: string,
  label: string,
  lowLabel: string,
  highLabel: string,
): MetricDef {
  return {
    key,
    label,
    category: 'wellness',
    canonicalUnit: 'score',
    units: SCORE_UNITS,
    displayUnit: SCORE_DISPLAY,
    min: 1,
    max: 5,
    decimals: 0,
    methods: WELLNESS_METHODS,
    scale: { min: 1, max: 5, lowLabel, highLabel },
    daily: true,
  };
}

const LAB_METHODS = ['unspecified', 'lab', 'point_of_care', 'clinical', 'other'] as const;

/** `1 / x`, named so each factor reads as the published SI -> conventional ratio. */
const per = (x: number) => 1 / x;

interface LabSpec {
  label: string;
  panel: LabPanel;
  /** The canonical (US conventional) unit; always the first entry of `units`. */
  unit: string;
  /** Accepted alternatives: unit -> factor to the canonical unit (or `[factor, offset]`). */
  alt?: Readonly<Record<string, number | readonly [number, number]>>;
  /**
   * The SI unit (#234) and its display precision: one of `alt`. Omitted =
   * SI and US conventional agree, so the canonical unit is shown either way.
   */
  si?: readonly [unit: string, decimals: number];
  min: number;
  max: number;
  decimals: number;
  aliases: readonly string[];
}

function lab(key: string, spec: LabSpec): MetricDef {
  const alternatives = Object.entries(spec.alt ?? {}).map(([unit, conversion]): MetricUnitDef => {
    const def: MetricUnitDef =
      typeof conversion === 'number'
        ? { unit, factor: conversion, label: unit }
        : { unit, factor: conversion[0], offset: conversion[1], label: unit };
    return spec.si?.[0] === unit ? { ...def, decimals: spec.si[1] } : def;
  });

  if (spec.si && !alternatives.some((unit) => unit.unit === spec.si![0])) {
    throw new Error(`Lab ${key}: SI unit ${spec.si[0]} is not one of its units`);
  }

  return {
    key,
    label: spec.label,
    category: 'lab',
    canonicalUnit: spec.unit,
    units: [{ unit: spec.unit, factor: 1, label: spec.unit }, ...alternatives],
    // Lab units do not follow the metric/imperial preference (see the header).
    displayUnit: { metric: spec.unit, imperial: spec.unit },
    min: spec.min,
    max: spec.max,
    decimals: spec.decimals,
    methods: LAB_METHODS,
    daily: false,
    panel: spec.panel,
    aliases: spec.aliases,
    siUnit: spec.si?.[0] ?? spec.unit,
  };
}

// Molar-mass factors (SI -> conventional), each the reciprocal of the usual
// conventional -> SI factor printed on lab reports.
const CHOLESTEROL_MMOL = per(0.02586); // 38.67 mg/dL per mmol/L
const TRIGLYCERIDE_MMOL = per(0.01129); // 88.57 mg/dL per mmol/L
const GLUCOSE_MMOL = per(0.0555); // 18.02 mg/dL per mmol/L (180.16 g/mol)
const IRON_UMOL = 5.585; // ug/dL per umol/L (55.85 g/mol)
const KATAL_U = 60; // 1 ukat/L = 60 U/L (umol/min)
/** HbA1c: NGSP % = IFCC mmol/mol / 10.929 + 2.15 (the IFCC-NGSP master equation). */
const HBA1C_IFCC: readonly [number, number] = [per(10.929), 2.15];

/**
 * The lab catalog (H3, #187), appended after the check-in scores. Panel
 * order, then analyte order within the panel, is display order.
 */
const LAB_METRICS: readonly MetricDef[] = [
  // --- Lipids ---------------------------------------------------------------
  lab('total_cholesterol', {
    label: 'Total cholesterol', panel: 'lipids', unit: 'mg/dL', alt: { 'mmol/L': CHOLESTEROL_MMOL }, si: ['mmol/L', 2],
    min: 0, max: 1000, decimals: 0,
    aliases: ['Cholesterol', 'Cholesterol, total', 'TC', 'Serum cholesterol', 'CHOL'],
  }),
  lab('ldl_cholesterol', {
    label: 'LDL cholesterol', panel: 'lipids', unit: 'mg/dL', alt: { 'mmol/L': CHOLESTEROL_MMOL }, si: ['mmol/L', 2],
    min: 0, max: 1000, decimals: 0,
    aliases: ['LDL', 'LDL-C', 'LDL Cholesterol', 'LDL Chol Calc', 'LDL cholesterol calculated', 'Low density lipoprotein', 'Low-density lipoprotein cholesterol'],
  }),
  lab('hdl_cholesterol', {
    label: 'HDL cholesterol', panel: 'lipids', unit: 'mg/dL', alt: { 'mmol/L': CHOLESTEROL_MMOL }, si: ['mmol/L', 2],
    min: 0, max: 300, decimals: 0,
    aliases: ['HDL', 'HDL-C', 'HDL Cholesterol', 'High density lipoprotein', 'High-density lipoprotein cholesterol'],
  }),
  lab('triglycerides', {
    label: 'Triglycerides', panel: 'lipids', unit: 'mg/dL', alt: { 'mmol/L': TRIGLYCERIDE_MMOL }, si: ['mmol/L', 2],
    min: 0, max: 10000, decimals: 0,
    aliases: ['TG', 'TRIG', 'Triglyceride', 'Triglycerides, serum'],
  }),
  lab('non_hdl_cholesterol', {
    label: 'Non-HDL cholesterol', panel: 'lipids', unit: 'mg/dL', alt: { 'mmol/L': CHOLESTEROL_MMOL }, si: ['mmol/L', 2],
    min: 0, max: 1000, decimals: 0,
    aliases: ['Non-HDL', 'Non HDL-C', 'Non-HDL Cholesterol'],
  }),
  lab('apob', {
    label: 'Apolipoprotein B', panel: 'lipids', unit: 'mg/dL', alt: { 'g/L': 100 }, si: ['g/L', 2],
    min: 0, max: 500, decimals: 0,
    aliases: ['ApoB', 'Apo B', 'Apo-B', 'Apolipoprotein B-100', 'Apolipoprotein B100'],
  }),

  // --- Glycemic ---------------------------------------------------------------
  lab('fasting_glucose', {
    label: 'Fasting glucose', panel: 'glycemic', unit: 'mg/dL', alt: { 'mmol/L': GLUCOSE_MMOL }, si: ['mmol/L', 1],
    min: 0, max: 2000, decimals: 0,
    aliases: ['Glucose', 'Glucose, fasting', 'FPG', 'Fasting plasma glucose', 'Fasting blood glucose', 'FBG', 'Blood sugar', 'GLU'],
  }),
  lab('hba1c', {
    label: 'HbA1c', panel: 'glycemic', unit: '%', alt: { 'mmol/mol': HBA1C_IFCC }, si: ['mmol/mol', 0],
    min: 3, max: 25, decimals: 1,
    aliases: ['A1c', 'Hemoglobin A1c', 'Haemoglobin A1c', 'Glycated hemoglobin', 'Glycated haemoglobin', 'Glycosylated hemoglobin', 'Hb A1c', 'HgbA1c'],
  }),
  lab('fasting_insulin', {
    label: 'Fasting insulin', panel: 'glycemic', unit: 'µIU/mL', alt: { 'mIU/L': 1, 'pmol/L': per(6) }, si: ['pmol/L', 0],
    min: 0, max: 1000, decimals: 1,
    aliases: ['Insulin', 'Insulin, fasting', 'Serum insulin'],
  }),

  // --- Complete blood count ---------------------------------------------------
  lab('hemoglobin', {
    label: 'Hemoglobin', panel: 'cbc', unit: 'g/dL', alt: { 'g/L': 0.1, 'mmol/L': 1.611 }, si: ['g/L', 0],
    min: 0, max: 30, decimals: 1,
    aliases: ['Hgb', 'Hb', 'Haemoglobin', 'HGB'],
  }),
  lab('hematocrit', {
    label: 'Hematocrit', panel: 'cbc', unit: '%', alt: { 'L/L': 100 }, si: ['L/L', 2],
    min: 0, max: 100, decimals: 1,
    aliases: ['Hct', 'Haematocrit', 'Packed cell volume', 'PCV'],
  }),
  lab('rbc_count', {
    label: 'Red blood cells', panel: 'cbc', unit: '10^6/µL', alt: { '10^12/L': 1 }, si: ['10^12/L', 2],
    min: 0, max: 15, decimals: 2,
    aliases: ['RBC', 'Red blood cell count', 'Erythrocytes', 'Red cell count', 'Erythrocyte count'],
  }),
  lab('wbc_count', {
    label: 'White blood cells', panel: 'cbc', unit: '10^3/µL', alt: { '10^9/L': 1 }, si: ['10^9/L', 1],
    min: 0, max: 500, decimals: 1,
    aliases: ['WBC', 'White blood cell count', 'Leukocytes', 'White cell count', 'Leukocyte count'],
  }),
  lab('platelet_count', {
    label: 'Platelets', panel: 'cbc', unit: '10^3/µL', alt: { '10^9/L': 1 }, si: ['10^9/L', 0],
    min: 0, max: 3000, decimals: 0,
    aliases: ['PLT', 'Platelet count', 'Thrombocytes'],
  }),
  lab('mcv', {
    label: 'Mean corpuscular volume', panel: 'cbc', unit: 'fL',
    min: 0, max: 200, decimals: 0,
    aliases: ['MCV', 'Mean cell volume'],
  }),

  // --- Metabolic panel, liver and kidney ------------------------------------
  lab('alt', {
    label: 'ALT', panel: 'cmp', unit: 'U/L', alt: { 'IU/L': 1, 'µkat/L': KATAL_U },
    min: 0, max: 10000, decimals: 0,
    aliases: ['Alanine aminotransferase', 'Alanine transaminase', 'SGPT', 'ALAT', 'GPT'],
  }),
  lab('ast', {
    label: 'AST', panel: 'cmp', unit: 'U/L', alt: { 'IU/L': 1, 'µkat/L': KATAL_U },
    min: 0, max: 10000, decimals: 0,
    aliases: ['Aspartate aminotransferase', 'Aspartate transaminase', 'SGOT', 'ASAT', 'GOT'],
  }),
  lab('alp', {
    label: 'Alkaline phosphatase', panel: 'cmp', unit: 'U/L', alt: { 'IU/L': 1, 'µkat/L': KATAL_U },
    min: 0, max: 10000, decimals: 0,
    aliases: ['ALP', 'Alk Phos', 'ALKP'],
  }),
  lab('total_bilirubin', {
    label: 'Total bilirubin', panel: 'cmp', unit: 'mg/dL', alt: { 'µmol/L': per(17.1) }, si: ['µmol/L', 0],
    min: 0, max: 50, decimals: 1,
    aliases: ['Bilirubin', 'Bilirubin, total', 'TBIL', 'T. Bili', 'Total bili'],
  }),
  lab('albumin', {
    label: 'Albumin', panel: 'cmp', unit: 'g/dL', alt: { 'g/L': 0.1 }, si: ['g/L', 0],
    min: 0, max: 10, decimals: 1,
    aliases: ['ALB', 'Serum albumin'],
  }),
  lab('creatinine', {
    label: 'Creatinine', panel: 'cmp', unit: 'mg/dL', alt: { 'µmol/L': per(88.42) }, si: ['µmol/L', 0],
    min: 0, max: 30, decimals: 2,
    aliases: ['CREA', 'Creat', 'Serum creatinine', 'Creatinine, serum', 'SCr'],
  }),
  lab('egfr', {
    label: 'eGFR', panel: 'cmp', unit: 'mL/min/1.73m²',
    min: 0, max: 250, decimals: 0,
    aliases: ['Estimated GFR', 'Estimated glomerular filtration rate', 'GFR estimated', 'eGFR non-African American', 'eGFR CKD-EPI'],
  }),
  lab('bun', {
    label: 'Blood urea nitrogen', panel: 'cmp', unit: 'mg/dL', alt: { 'mmol/L': per(0.357) }, si: ['mmol/L', 1],
    min: 0, max: 300, decimals: 0,
    aliases: ['BUN', 'Urea nitrogen', 'Urea nitrogen, blood'],
  }),
  lab('sodium', {
    label: 'Sodium', panel: 'cmp', unit: 'mmol/L', alt: { 'mEq/L': 1 },
    min: 80, max: 200, decimals: 0,
    aliases: ['Na', 'Na+', 'Serum sodium'],
  }),
  lab('potassium', {
    label: 'Potassium', panel: 'cmp', unit: 'mmol/L', alt: { 'mEq/L': 1 },
    min: 1, max: 12, decimals: 1,
    aliases: ['K', 'K+', 'Serum potassium'],
  }),

  // --- Thyroid ------------------------------------------------------------------
  lab('tsh', {
    label: 'TSH', panel: 'thyroid', unit: 'mIU/L', alt: { 'µIU/mL': 1 },
    min: 0, max: 500, decimals: 2,
    aliases: ['Thyroid stimulating hormone', 'Thyroid-stimulating hormone', 'Thyrotropin', 'TSH, 3rd generation'],
  }),
  lab('free_t4', {
    label: 'Free T4', panel: 'thyroid', unit: 'ng/dL', alt: { 'pmol/L': per(12.87) }, si: ['pmol/L', 1],
    min: 0, max: 10, decimals: 2,
    aliases: ['FT4', 'Free thyroxine', 'Thyroxine, free', 'T4, free'],
  }),
  lab('free_t3', {
    label: 'Free T3', panel: 'thyroid', unit: 'pg/mL', alt: { 'pmol/L': per(1.536) }, si: ['pmol/L', 1],
    min: 0, max: 30, decimals: 1,
    aliases: ['FT3', 'Free triiodothyronine', 'Triiodothyronine, free', 'T3, free'],
  }),

  // --- Iron -------------------------------------------------------------------------
  lab('ferritin', {
    label: 'Ferritin', panel: 'iron', unit: 'ng/mL', alt: { 'µg/L': 1 }, si: ['µg/L', 0],
    min: 0, max: 100000, decimals: 0,
    aliases: ['FERR', 'Serum ferritin'],
  }),
  lab('serum_iron', {
    label: 'Iron', panel: 'iron', unit: 'µg/dL', alt: { 'µmol/L': IRON_UMOL }, si: ['µmol/L', 1],
    min: 0, max: 1000, decimals: 0,
    aliases: ['Iron', 'Fe', 'Iron, serum', 'Iron, total', 'Serum iron'],
  }),
  lab('tibc', {
    label: 'Total iron-binding capacity', panel: 'iron', unit: 'µg/dL', alt: { 'µmol/L': IRON_UMOL }, si: ['µmol/L', 0],
    min: 0, max: 1500, decimals: 0,
    aliases: ['TIBC', 'Iron binding capacity', 'Total iron binding capacity'],
  }),
  lab('transferrin_saturation', {
    label: 'Transferrin saturation', panel: 'iron', unit: '%',
    min: 0, max: 100, decimals: 0,
    aliases: ['TSAT', 'Iron saturation', '% saturation', 'Transferrin sat', 'Saturation of transferrin'],
  }),

  // --- Other ------------------------------------------------------------------------
  lab('vitamin_d_25oh', {
    label: '25-OH vitamin D', panel: 'other', unit: 'ng/mL', alt: { 'nmol/L': per(2.496) }, si: ['nmol/L', 0],
    min: 0, max: 300, decimals: 0,
    aliases: ['Vitamin D', 'Vitamin D, 25-hydroxy', '25-hydroxyvitamin D', '25(OH)D', '25-OH D', 'Calcidiol', 'Vit D'],
  }),
  lab('vitamin_b12', {
    label: 'Vitamin B12', panel: 'other', unit: 'pg/mL', alt: { 'pmol/L': per(0.7378) }, si: ['pmol/L', 0],
    min: 0, max: 10000, decimals: 0,
    aliases: ['B12', 'Vit B12', 'Cobalamin', 'Cyanocobalamin'],
  }),
  lab('hs_crp', {
    label: 'hs-CRP', panel: 'other', unit: 'mg/L', alt: { 'mg/dL': 10 },
    min: 0, max: 500, decimals: 1,
    aliases: ['hsCRP', 'High-sensitivity C-reactive protein', 'High sensitivity CRP', 'C-reactive protein, high sensitivity', 'CRP, cardiac'],
  }),
  lab('testosterone_total', {
    label: 'Total testosterone', panel: 'other', unit: 'ng/dL', alt: { 'nmol/L': per(0.03467) }, si: ['nmol/L', 1],
    min: 0, max: 5000, decimals: 0,
    aliases: ['Testosterone', 'Testosterone, total', 'Serum testosterone'],
  }),
  lab('testosterone_free', {
    label: 'Free testosterone', panel: 'other', unit: 'pg/mL', alt: { 'pmol/L': per(3.467), 'ng/dL': 10 }, si: ['pmol/L', 0],
    min: 0, max: 1000, decimals: 1,
    aliases: ['Testosterone, free', 'Free T'],
  }),
  lab('cortisol', {
    label: 'Cortisol', panel: 'other', unit: 'µg/dL', alt: { 'nmol/L': per(27.59) }, si: ['nmol/L', 0],
    min: 0, max: 200, decimals: 1,
    aliases: ['Cortisol, serum', 'Serum cortisol', 'Cortisol, AM', 'Morning cortisol'],
  }),
  lab('uric_acid', {
    label: 'Uric acid', panel: 'other', unit: 'mg/dL', alt: { 'µmol/L': per(59.48) }, si: ['µmol/L', 0],
    min: 0, max: 30, decimals: 1,
    aliases: ['Urate', 'Serum uric acid', 'Uric acid, serum'],
  }),
];

/**
 * The epic's ten metrics (plus the two Health Connect heart metrics, #276), then the lab catalog, in display order. Appending a
 * metric here is the whole of "add a metric"; renaming a `key` is not allowed
 * once rows carry it (it is stored).
 */
export const METRICS = [
  {
    key: 'weight',
    label: 'Weight',
    category: 'body',
    canonicalUnit: 'kg',
    units: [
      { unit: 'kg', factor: 1, label: 'kg' },
      { unit: 'lb', factor: 0.45359237, label: 'lb' },
    ],
    displayUnit: { metric: 'kg', imperial: 'lb' },
    min: 20,
    max: 500,
    decimals: 1,
    methods: BODY_WEIGHT_METHODS,
    daily: false,
  },
  {
    key: 'body_fat_pct',
    label: 'Body fat',
    category: 'body',
    canonicalUnit: '%',
    units: [{ unit: '%', factor: 1, label: '%' }],
    displayUnit: { metric: '%', imperial: '%' },
    min: 2,
    max: 70,
    decimals: 1,
    methods: BODY_FAT_METHODS,
    daily: false,
  },
  {
    key: 'waist_circumference',
    label: 'Waist',
    category: 'body',
    canonicalUnit: 'cm',
    units: [
      { unit: 'cm', factor: 1, label: 'cm' },
      { unit: 'in', factor: 2.54, label: 'in' },
    ],
    displayUnit: { metric: 'cm', imperial: 'in' },
    min: 30,
    max: 250,
    decimals: 1,
    methods: WAIST_METHODS,
    daily: false,
  },
  {
    key: 'bp_systolic',
    label: 'Systolic pressure',
    category: 'vital',
    canonicalUnit: 'mmHg',
    units: [{ unit: 'mmHg', factor: 1, label: 'mmHg' }],
    displayUnit: { metric: 'mmHg', imperial: 'mmHg' },
    min: 60,
    max: 260,
    decimals: 0,
    methods: BP_METHODS,
    daily: false,
  },
  {
    key: 'bp_diastolic',
    label: 'Diastolic pressure',
    category: 'vital',
    canonicalUnit: 'mmHg',
    units: [{ unit: 'mmHg', factor: 1, label: 'mmHg' }],
    displayUnit: { metric: 'mmHg', imperial: 'mmHg' },
    min: 30,
    max: 160,
    decimals: 0,
    methods: BP_METHODS,
    daily: false,
  },
  {
    key: 'resting_hr',
    label: 'Resting heart rate',
    category: 'vital',
    canonicalUnit: 'bpm',
    units: [{ unit: 'bpm', factor: 1, label: 'bpm' }],
    displayUnit: { metric: 'bpm', imperial: 'bpm' },
    min: 25,
    max: 220,
    decimals: 0,
    methods: RESTING_HR_METHODS,
    daily: false,
  },
  // Epic #276: written by the Android Health Connect sync (origin `device`).
  {
    key: 'heart_rate_avg',
    label: 'Average heart rate',
    category: 'vital',
    canonicalUnit: 'bpm',
    units: [{ unit: 'bpm', factor: 1, label: 'bpm' }],
    displayUnit: { metric: 'bpm', imperial: 'bpm' },
    min: 25,
    max: 250,
    decimals: 0,
    methods: HEART_RATE_AVG_METHODS,
    daily: true,
  },
  {
    key: 'hrv_rmssd',
    label: 'Heart rate variability (RMSSD)',
    category: 'vital',
    canonicalUnit: 'ms',
    units: [{ unit: 'ms', factor: 1, label: 'ms' }],
    displayUnit: { metric: 'ms', imperial: 'ms' },
    min: 1,
    max: 300,
    decimals: 0,
    methods: HRV_METHODS,
    daily: false,
  },
  wellness('energy', 'Energy', 'Drained', 'Energised'),
  wellness('sleep_quality', 'Sleep quality', 'Poor', 'Great'),
  wellness('muscle_soreness', 'Muscle soreness', 'None', 'Severe'),
  wellness('stress', 'Stress', 'Calm', 'Overwhelmed'),
  ...LAB_METRICS,
] as const satisfies readonly MetricDef[];

export type MetricKey = (typeof METRICS)[number]['key'];

/** The blood-pressure pair: submitted together, systolic above diastolic. */
export const BP_SYSTOLIC = 'bp_systolic';
export const BP_DIASTOLIC = 'bp_diastolic';

/**
 * Body and vital metrics, registry order: what `GET /api/measurements` lists
 * by default and what `latest` reports. Lab analytes are written through the
 * same endpoints but listed only on request (`category=lab` or a `metricKey`).
 */
export const MEASUREMENT_METRIC_KEYS: readonly string[] = (METRICS as readonly MetricDef[])
  .filter((metric) => metric.category === 'body' || metric.category === 'vital')
  .map((metric) => metric.key);

/** Every lab analyte key, registry order. */
export const LAB_METRIC_KEYS: readonly string[] = (METRICS as readonly MetricDef[])
  .filter((metric) => metric.category === 'lab')
  .map((metric) => metric.key);

const BY_KEY: ReadonlyMap<string, MetricDef> = new Map(
  (METRICS as readonly MetricDef[]).map((metric) => [metric.key, metric]),
);

const METHOD_LABELS: ReadonlyMap<string, string> = new Map(
  MEASUREMENT_METHODS.map((method) => [method.key, method.label]),
);

/** Decimal places every canonical value is rounded to on write. */
export const CANONICAL_DECIMALS = 4;

/** Thrown by the helpers below; callers map it to a 400 naming the field. */
export class MetricRegistryError extends Error {
  constructor(
    readonly reason: 'unknown_metric' | 'unknown_unit' | 'not_finite',
    message: string,
  ) {
    super(message);
    this.name = 'MetricRegistryError';
  }
}

export function getMetric(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

export function isMetricKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** A body, vital or lab metric: one `/api/measurements` accepts. */
export function isMeasurementMetric(key: string): boolean {
  const metric = BY_KEY.get(key);
  return metric !== undefined && metric.category !== 'wellness';
}

export function isLabMetric(key: string): boolean {
  return BY_KEY.get(key)?.category === 'lab';
}

export function methodsFor(key: string): readonly string[] {
  return BY_KEY.get(key)?.methods ?? [];
}

export function isMethodAllowed(key: string, method: string): boolean {
  return methodsFor(key).includes(method);
}

/**
 * The metric's unit definition for `unit`. Exact match for every metric; a
 * lab analyte also matches case-insensitively and with `u` or Greek mu for
 * the micro sign (`umol/l` is `µmol/L`), because lab reports spell units
 * every way.
 */
export function unitFor(key: string, unit: string): MetricUnitDef | undefined {
  const metric = BY_KEY.get(key);
  if (!metric) return undefined;

  const exact = metric.units.find((candidate) => candidate.unit === unit);
  if (exact || metric.category !== 'lab') return exact;

  const wanted = foldUnit(unit);
  return metric.units.find((candidate) => foldUnit(candidate.unit) === wanted);
}

function foldUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/[\u00b5\u03bc]/g, 'u');
}

export function roundCanonical(value: number): number {
  const scale = 10 ** CANONICAL_DECIMALS;
  const rounded = Math.round(value * scale) / scale;
  // Normalise -0 so it serialises as 0.
  return rounded === 0 ? 0 : rounded;
}

/**
 * Converts `value` in `unit` (omitted = canonical) to the metric's canonical
 * unit, rounded to {@link CANONICAL_DECIMALS}. Throws
 * {@link MetricRegistryError} for an unknown metric or a unit the metric does
 * not allow. Does NOT check bounds: see {@link isWithinBounds}.
 */
export function toCanonical(key: string, value: number, unit?: string): number {
  const metric = BY_KEY.get(key);

  if (!metric) {
    throw new MetricRegistryError('unknown_metric', `Unknown metric ${key}`);
  }

  if (!Number.isFinite(value)) {
    throw new MetricRegistryError('not_finite', 'value must be a finite number');
  }

  const unitDef = unitFor(key, unit ?? metric.canonicalUnit);

  if (!unitDef) {
    throw new MetricRegistryError('unknown_unit', `Unit is not allowed for ${key}`);
  }

  return roundCanonical(value * unitDef.factor + (unitDef.offset ?? 0));
}

/** Canonical value -> `unit`, unrounded (display code rounds to `decimals`). */
export function fromCanonical(key: string, canonicalValue: number, unit: string): number {
  const unitDef = unitFor(key, unit);

  if (!unitDef) {
    throw new MetricRegistryError('unknown_unit', `Unit is not allowed for ${key}`);
  }

  return (canonicalValue - (unitDef.offset ?? 0)) / unitDef.factor;
}

/** The lab-unit preference (#234): US conventional (canonical) or SI. */
export const LAB_UNIT_SYSTEMS = ['conventional', 'si'] as const;
export type LabUnits = (typeof LAB_UNIT_SYSTEMS)[number];
export const DEFAULT_LAB_UNITS: LabUnits = 'conventional';

/**
 * The unit a value of `metric` is shown in under the `labUnits` preference:
 * the SI unit for a lab analyte when `si`, else the canonical unit. Non-lab
 * metrics always answer their canonical unit (they follow `unitSystem`).
 */
export function labDisplayUnit(metric: MetricDef | string, labUnits: LabUnits): string {
  const def = typeof metric === 'string' ? BY_KEY.get(metric) : metric;
  if (!def) throw new MetricRegistryError('unknown_metric', `Unknown metric ${String(metric)}`);
  return labUnits === 'si' && def.siUnit ? def.siUnit : def.canonicalUnit;
}

/** Display precision of a value of `key` shown in `unit`: the unit's own, else the metric's. */
export function unitDecimals(key: string, unit: string): number {
  const metric = BY_KEY.get(key);
  const unitDef = unitFor(key, unit);
  if (!metric || !unitDef) {
    throw new MetricRegistryError('unknown_unit', `Unit is not allowed for ${key}`);
  }
  return unitDef.decimals ?? metric.decimals;
}

/**
 * A canonical value shown in `targetUnit`, rounded to that unit's display
 * precision ({@link unitDecimals}). Display only: never store the result.
 */
export function toDisplayUnit(key: string, canonicalValue: number, targetUnit: string): number {
  const scale = 10 ** unitDecimals(key, targetUnit);
  const rounded = Math.round(fromCanonical(key, canonicalValue, targetUnit) * scale) / scale;
  return rounded === 0 ? 0 : rounded;
}

/** Whether a CANONICAL value lies inside the metric's hard bounds (inclusive). */
export function isWithinBounds(key: string, canonicalValue: number): boolean {
  const metric = BY_KEY.get(key);
  return (
    metric !== undefined &&
    Number.isFinite(canonicalValue) &&
    canonicalValue >= metric.min &&
    canonicalValue <= metric.max
  );
}

export function methodLabel(method: string): string | undefined {
  return METHOD_LABELS.get(method);
}

/**
 * Case-, accent-, space- and punctuation-insensitive form of an analyte name:
 * "LDL-C", "ldl c" and "LDL_C" all fold to `ldlc`.
 */
export function foldAnalyteName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]/g, '');
}

const LAB_BY_NAME: ReadonlyMap<string, MetricDef> = (() => {
  const byName = new Map<string, MetricDef>();
  for (const metric of METRICS as readonly MetricDef[]) {
    if (metric.category !== 'lab') continue;
    for (const name of [metric.key, metric.label, ...(metric.aliases ?? [])]) {
      const folded = foldAnalyteName(name);
      const taken = byName.get(folded);
      if (taken && taken.key !== metric.key) {
        throw new Error(`Lab alias "${name}" names both ${taken.key} and ${metric.key}`);
      }
      byName.set(folded, metric);
    }
  }
  return byName;
})();

/**
 * Words labs and portals wrap around an analyte name without changing what it
 * names ("Glucose Lvl", "Creatinine, Serum", "Albumin (calc)"), as folded
 * token sequences. Tried only at either END of the name, and only kept when
 * what remains still resolves, so "Total cholesterol" and "Bilirubin, Total"
 * (catalog names in their own right) are never stripped.
 */
const LAB_NAME_QUALIFIERS: ReadonlyArray<readonly string[]> = [
  ['whole', 'blood'],
  ['lvl'],
  ['level'],
  ['serum'],
  ['ser'],
  ['plasma'],
  ['blood'],
  ['bld'],
  ['total'],
  ['calc'],
  ['calculated'],
];

/** "Normal Range: 65 - 99 mg/dL" or "Reference range ..." printed in the name cell, and everything after it. */
const PRINTED_RANGE_SUFFIX = /\b(normal|reference|ref\.?)\s*(range|interval)?\s*:.*$/i;

function analyteTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((token) => token.length > 0);
}

const startsWithSeq = (tokens: readonly string[], seq: readonly string[]) =>
  seq.length < tokens.length && seq.every((token, i) => tokens[i] === token);
const endsWithSeq = (tokens: readonly string[], seq: readonly string[]) =>
  seq.length < tokens.length && seq.every((token, i) => tokens[tokens.length - seq.length + i] === token);

/**
 * The shortest-stripping qualifier fallback: every way of removing qualifier
 * tokens from the ends of `tokens`, fewest removals first, until one resolves.
 */
function resolveWithoutQualifiers(tokens: readonly string[]): MetricDef | undefined {
  let frontier: string[][] = [[...tokens]];
  const seen = new Set<string>([tokens.join(' ')]);

  while (frontier.length > 0) {
    const next: string[][] = [];
    for (const current of frontier) {
      for (const qualifier of LAB_NAME_QUALIFIERS) {
        const candidates: string[][] = [];
        if (startsWithSeq(current, qualifier)) candidates.push(current.slice(qualifier.length));
        if (endsWithSeq(current, qualifier)) candidates.push(current.slice(0, current.length - qualifier.length));

        for (const candidate of candidates) {
          const key = candidate.join(' ');
          if (seen.has(key)) continue;
          seen.add(key);
          const match = LAB_BY_NAME.get(candidate.join(''));
          if (match) return match;
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }

  return undefined;
}

/**
 * The lab analyte a report's name refers to: its key, its label or one of its
 * aliases, compared with {@link foldAnalyteName}. When that exact lookup
 * fails, it retries without a printed "Normal Range: ..." tail and without
 * common qualifiers at either end of the name ("Lvl", "Level", "Serum",
 * "Plasma", "Blood", "Total", "(calc)", ...; {@link LAB_NAME_QUALIFIERS}),
 * keeping a stripped form only when it resolves. Undefined when nothing
 * matches (never a guess: an analyte the catalog lacks stays unmatched).
 */
export function resolveLabAnalyte(name: string): MetricDef | undefined {
  const folded = foldAnalyteName(name);
  if (folded === '') return undefined;

  const exact = LAB_BY_NAME.get(folded);
  if (exact) return exact;

  const withoutRange = name.replace(PRINTED_RANGE_SUFFIX, '');
  if (withoutRange !== name) {
    const bare = foldAnalyteName(withoutRange);
    const match = bare === '' ? undefined : LAB_BY_NAME.get(bare);
    if (match) return match;
  }

  const tokens = analyteTokens(withoutRange);
  return tokens.length > 1 ? resolveWithoutQualifiers(tokens) : undefined;
}

export interface MetricCatalogView {
  metrics: Array<{
    key: string;
    label: string;
    category: MetricCategory;
    canonicalUnit: string;
    units: Array<MetricUnitDef & { offset: number; decimals: number }>;
    displayUnit: { metric: string; imperial: string };
    min: number;
    max: number;
    decimals: number;
    methods: string[];
    scale: MetricScaleDef | null;
    daily: boolean;
    panel: LabPanel | null;
    aliases: string[];
    siUnit: string | null;
  }>;
  methods: Array<{ key: string; label: string }>;
}

/** What `GET /api/measurements/metrics` returns: plain, mutable JSON copies. */
export function catalogView(): MetricCatalogView {
  return {
    metrics: (METRICS as readonly MetricDef[]).map((metric) => ({
      key: metric.key,
      label: metric.label,
      category: metric.category,
      canonicalUnit: metric.canonicalUnit,
      units: metric.units.map((unit) => ({
        ...unit,
        offset: unit.offset ?? 0,
        decimals: unit.decimals ?? metric.decimals,
      })),
      displayUnit: { ...metric.displayUnit },
      min: metric.min,
      max: metric.max,
      decimals: metric.decimals,
      methods: [...metric.methods],
      scale: metric.scale ? { ...metric.scale } : null,
      daily: metric.daily,
      panel: metric.panel ?? null,
      aliases: [...(metric.aliases ?? [])],
      siUnit: metric.siUnit ?? null,
    })),
    methods: MEASUREMENT_METHODS.map((method) => ({ key: method.key, label: method.label })),
  };
}
