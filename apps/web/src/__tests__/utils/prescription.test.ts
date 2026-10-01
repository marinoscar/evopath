/**
 * formatPrescription (#263): the reps shape is byte-identical to what the
 * plan, Today and the adjusted-workout review rendered before; duration,
 * distance and both read as "30 min", "5 km", "5 km · 30 min", in km or mi.
 */
import { describe, it, expect } from 'vitest';
import {
  formatCardioTarget,
  formatPrescription,
  formatTargetDistance,
  formatTargetDuration,
  isCardioPrescription,
} from '../../utils/prescription';
import { prescription } from '../../utils/planDiff';
import { prescriptionText } from '../../components/training/TodayPlanCard';
import { prescription as adaptedPrescription } from '../../components/training/adapt/adaptationCopy';
import type { TodaySessionExercise } from '../../services/programs';

const reps = { sets: 3, repMin: 8, repMax: 12, targetRpe: null };

describe('formatPrescription', () => {
  describe('reps shape (unchanged output)', () => {
    it('reads a range with a times sign and an en dash', () => {
      expect(formatPrescription(reps)).toBe('3 × 8–12');
    });

    it('reads a single rep target without a range', () => {
      expect(formatPrescription({ ...reps, repMin: 5, repMax: 5 })).toBe('3 × 5');
    });

    it('appends the RPE', () => {
      expect(formatPrescription({ ...reps, targetRpe: 8.5 })).toBe('3 × 8–12 @ RPE 8.5');
    });

    it('keeps the ASCII spelling when asked', () => {
      expect(formatPrescription({ ...reps, targetRpe: 8 }, { ascii: true })).toBe('3 x 8-12 @ RPE 8');
    });

    it('treats null cardio targets as the reps shape', () => {
      expect(formatPrescription({ ...reps, targetDurationSeconds: null, targetDistanceMeters: null })).toBe('3 × 8–12');
    });
  });

  describe('cardio shape', () => {
    const cardio = { sets: null, repMin: null, repMax: null };

    it('reads a duration in minutes', () => {
      expect(formatPrescription({ ...cardio, targetDurationSeconds: 1800 })).toBe('30 min');
    });

    it('reads a distance in km by default', () => {
      expect(formatPrescription({ ...cardio, targetDistanceMeters: 5000 })).toBe('5 km');
    });

    it('reads a distance in miles for an imperial user', () => {
      expect(formatPrescription({ ...cardio, targetDistanceMeters: 5000 }, { distanceUnit: 'mi' })).toBe('3.11 mi');
    });

    it('reads both as distance then time', () => {
      expect(formatPrescription({ ...cardio, targetDistanceMeters: 5000, targetDurationSeconds: 1800 })).toBe('5 km · 30 min');
    });

    it('reads the target as the session total, with the set count after it', () => {
      expect(formatPrescription({ ...cardio, sets: 4, targetDistanceMeters: 400 })).toBe('0.4 km · 4 sets');
      expect(formatPrescription({ ...cardio, sets: 3, targetDurationSeconds: 1800 })).toBe('30 min · 3 sets');
      expect(formatPrescription({ ...cardio, sets: 2, targetDistanceMeters: 5000, targetDurationSeconds: 1800 })).toBe(
        '5 km · 30 min · 2 sets',
      );
      expect(formatPrescription({ ...cardio, sets: 3, targetDurationSeconds: 1800 }, { ascii: true })).toBe('30 min · 3 sets');
      expect(formatPrescription({ ...cardio, sets: 1, targetDurationSeconds: 600 })).toBe('10 min');
      expect(formatPrescription({ ...cardio, sets: null, targetDurationSeconds: 600 })).toBe('10 min');
    });

    it('appends an RPE when set', () => {
      expect(formatPrescription({ ...cardio, targetDurationSeconds: 1200, targetRpe: 6 })).toBe('20 min @ RPE 6');
    });
  });

  it('helpers', () => {
    expect(formatTargetDuration(5400)).toBe('90 min');
    expect(formatTargetDuration(90)).toBe('1:30 min');
    expect(formatTargetDistance(12340)).toBe('12.34 km');
    expect(formatCardioTarget({ targetDurationSeconds: null, targetDistanceMeters: null })).toBeNull();
    expect(isCardioPrescription({ targetDurationSeconds: 60 })).toBe(true);
    expect(isCardioPrescription({ targetDurationSeconds: null, targetDistanceMeters: undefined })).toBe(false);
  });
});

describe('call sites', () => {
  it('the plan history keeps "3 x 8-10 @ RPE 8" and reads cardio rows', () => {
    expect(prescription({ targetSets: 3, repMin: 8, repMax: 10, targetRpe: 8 })).toBe('3 x 8-10 @ RPE 8');
    expect(
      prescription({ targetSets: null, repMin: null, repMax: null, targetRpe: null, targetDurationSeconds: 1800 }),
    ).toBe('30 min');
  });

  it("Today's session keeps \"3 × 8–10 @ RPE 8\" and reads cardio rows in the user's unit", () => {
    const base = {
      sets: 3,
      repMin: 8,
      repMax: 10,
      targetRpe: 8,
      targetDurationSeconds: null,
      targetDistanceMeters: null,
    } as TodaySessionExercise;
    expect(prescriptionText(base)).toBe('3 × 8–10 @ RPE 8');
    const run = { ...base, sets: null, repMin: null, repMax: null, targetRpe: null, targetDistanceMeters: 5000 };
    expect(prescriptionText(run)).toBe('5 km');
    expect(prescriptionText(run, 'mi')).toBe('3.11 mi');
  });

  it('the adjusted-workout review keeps "3 × 8–10 @ RPE 7"', () => {
    expect(adaptedPrescription({ sets: 3, repMin: 8, repMax: 10, targetRpe: 7 })).toBe('3 × 8–10 @ RPE 7');
  });
});
