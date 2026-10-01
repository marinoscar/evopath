import {
  describePrescriptionChange,
  formatDistance,
  formatDuration,
  isCardioTrackingMode,
  prescriptionLabel,
  prescriptionMismatch,
  prescriptionShapeOf,
  type PrescriptionFields,
} from './prescription';

const reps = (over: Partial<PrescriptionFields> = {}): PrescriptionFields => ({
  targetSets: 3,
  repMin: 8,
  repMax: 12,
  targetDurationSeconds: null,
  targetDistanceMeters: null,
  ...over,
});

const cardio = (over: Partial<PrescriptionFields> = {}): PrescriptionFields => ({
  targetSets: null,
  repMin: null,
  repMax: null,
  targetDurationSeconds: 1800,
  targetDistanceMeters: null,
  ...over,
});

describe('prescription shapes', () => {
  it('reads the shape from the targets', () => {
    expect(prescriptionShapeOf(reps())).toBe('reps');
    expect(prescriptionShapeOf(cardio())).toBe('cardio');
    expect(prescriptionShapeOf(cardio({ targetDurationSeconds: null, targetDistanceMeters: 5000 }))).toBe('cardio');
  });

  it('knows the cardio tracking modes', () => {
    expect(['weight_reps', 'bodyweight_reps', 'time', 'distance_time'].map(isCardioTrackingMode)).toEqual([false, false, true, true]);
  });

  it.each<[string, string, PrescriptionFields, boolean]>([
    ['weight_reps takes reps', 'weight_reps', reps(), true],
    ['bodyweight_reps takes reps', 'bodyweight_reps', reps(), true],
    ['weight_reps refuses a duration', 'weight_reps', cardio(), false],
    ['bodyweight_reps refuses a distance', 'bodyweight_reps', cardio({ targetDurationSeconds: null, targetDistanceMeters: 2000 }), false],
    ['time takes a duration', 'time', cardio(), true],
    ['time takes a duration with sets', 'time', cardio({ targetSets: 3, targetDurationSeconds: 180 }), true],
    ['time refuses reps', 'time', reps(), false],
    ['time refuses a distance only', 'time', cardio({ targetDurationSeconds: null, targetDistanceMeters: 2000 }), false],
    ['time refuses a duration and a distance', 'time', cardio({ targetDistanceMeters: 2000 }), false],
    ['distance_time takes a duration', 'distance_time', cardio(), true],
    ['distance_time takes a distance', 'distance_time', cardio({ targetDurationSeconds: null, targetDistanceMeters: 5000 }), true],
    ['distance_time takes both', 'distance_time', cardio({ targetDistanceMeters: 5000 }), true],
    ['distance_time refuses reps', 'distance_time', reps(), false],
    ['an unknown mode takes reps only', 'something_new', cardio(), false],
  ])('%s', (_label, mode, fields, fits) => {
    expect(prescriptionMismatch(mode, fields) === null).toBe(fits);
  });
});

describe('prescription labels', () => {
  it.each([
    [45, '45 s'],
    [60, '1 min'],
    [1800, '30 min'],
    [3600, '1 h'],
    [5400, '1 h 30 min'],
  ])('formatDuration(%i) is %s', (seconds, label) => expect(formatDuration(seconds)).toBe(label));

  it.each([
    [800, '800 m'],
    [1000, '1 km'],
    [5000, '5 km'],
    [7500, '7.5 km'],
    [5250, '5.25 km'],
  ])('formatDistance(%i) is %s', (meters, label) => expect(formatDistance(meters)).toBe(label));

  it('labels each shape', () => {
    expect(prescriptionLabel(reps())).toBe('3 x 8-12');
    expect(prescriptionLabel(reps({ repMin: 10, repMax: 10 }))).toBe('3 x 10');
    expect(prescriptionLabel(cardio())).toBe('30 min');
    expect(prescriptionLabel(cardio({ targetDurationSeconds: null, targetDistanceMeters: 5000 }))).toBe('5 km');
    expect(prescriptionLabel(cardio({ targetDistanceMeters: 5000 }))).toBe('30 min, 5 km');
    expect(prescriptionLabel(cardio({ targetSets: 4, targetDurationSeconds: 300 }))).toBe('4 x 5 min');
  });

  it.each<[string, PrescriptionFields, PrescriptionFields, string | null]>([
    ['a longer walk', cardio({ targetDurationSeconds: 1200 }), cardio(), '20 → 30 min'],
    ['a longer run', cardio({ targetDurationSeconds: null, targetDistanceMeters: 5000 }), cardio({ targetDurationSeconds: null, targetDistanceMeters: 7500 }), '5 → 7.5 km'],
    ['time to distance', cardio(), cardio({ targetDurationSeconds: null, targetDistanceMeters: 5000 }), '30 min → 5 km'],
    ['more sets', reps(), reps({ targetSets: 4 }), '3 x 8-12 → 4 x 8-12'],
    ['across an hour', cardio({ targetDurationSeconds: 3000 }), cardio({ targetDurationSeconds: 5400 }), '50 min → 1 h 30 min'],
    ['nothing a person reads', cardio(), cardio({ targetDurationSeconds: 1810 }), null],
  ])('describes %s', (_label, before, after, text) => {
    expect(describePrescriptionChange(before, after)).toBe(text);
  });
});
