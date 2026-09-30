/**
 * The adaptation sheet's form state and its mapping to the API request.
 * Pure functions: the sheet, the chips and the tests share them.
 */
import {
  ADAPTATION_LIMITS,
  MINUTE_CHOICES,
  type AdaptationDropReason,
  type AdaptationRequest,
  type SorenessLevel,
} from '../../../services/trainingAdaptation';

export type EquipmentChoice = 'gym' | 'only' | 'bodyweight';

export interface AdaptDraft {
  /** A chip value, `'custom'` (then `customMinutes`), or null for "no time limit". */
  minutes: number | 'custom' | null;
  customMinutes: string;
  sore: boolean;
  soreMuscles: string[];
  soreLevel: SorenessLevel;
  equipment: EquipmentChoice;
  equipmentTypeIds: string[];
  lowEnergy: boolean;
  /** `''`: the plan's gym, else the default gym (the API decides). */
  gymId: string;
  freeText: string;
  useReadiness: boolean;
}

export const EMPTY_DRAFT: AdaptDraft = {
  minutes: null,
  customMinutes: '',
  sore: false,
  soreMuscles: [],
  soreLevel: 'mild',
  equipment: 'gym',
  equipmentTypeIds: [],
  lowEnergy: false,
  gymId: '',
  freeText: '',
  useReadiness: true,
};

/** The minutes the draft asks for; NaN for a custom value that is not a number. */
export function draftMinutes(draft: AdaptDraft): number | undefined {
  if (draft.minutes === null) return undefined;
  if (draft.minutes === 'custom') {
    const text = draft.customMinutes.trim();
    return text === '' ? undefined : Number(text);
  }
  return draft.minutes;
}

/**
 * The request the draft stands for. `equipmentGymId` is the gym whose
 * equipment the "Only these" chips listed: sent as `gymId` so the API checks
 * the subset against the gym the user saw.
 */
export function buildRequest(draft: AdaptDraft, equipmentGymId?: string | null): AdaptationRequest {
  const request: AdaptationRequest = { useReadiness: draft.useReadiness };
  const minutes = draftMinutes(draft);
  if (minutes !== undefined) request.minutes = minutes;
  if (draft.sore) request.soreness = { muscles: draft.soreMuscles, level: draft.soreLevel };
  if (draft.lowEnergy) request.lowEnergy = true;
  if (draft.equipment === 'only') request.equipment = { mode: 'only', equipmentTypeIds: draft.equipmentTypeIds };
  if (draft.equipment === 'bodyweight') request.equipment = { mode: 'bodyweight' };
  const gymId = draft.gymId || (draft.equipment === 'only' ? equipmentGymId ?? '' : '');
  if (gymId) request.gymId = gymId;
  const text = draft.freeText.trim();
  if (text) request.freeText = text;
  return request;
}

/** "Adjust again": the sheet starts from what was asked last time. */
export function draftFromRequest(request: Partial<AdaptationRequest> | null | undefined): AdaptDraft {
  if (!request) return EMPTY_DRAFT;
  const minutes = typeof request.minutes === 'number' ? request.minutes : null;
  const preset = minutes !== null && (MINUTE_CHOICES as readonly number[]).includes(minutes);
  const equipment = request.equipment?.mode ?? 'gym';
  return {
    ...EMPTY_DRAFT,
    minutes: minutes === null ? null : preset ? minutes : 'custom',
    customMinutes: minutes !== null && !preset ? String(minutes) : '',
    sore: !!request.soreness,
    soreMuscles: request.soreness?.muscles ?? [],
    soreLevel: request.soreness?.level ?? 'mild',
    equipment,
    equipmentTypeIds: request.equipment?.mode === 'only' ? request.equipment.equipmentTypeIds : [],
    lowEnergy: request.lowEnergy === true,
    gymId: typeof request.gymId === 'string' ? request.gymId : '',
    freeText: typeof request.freeText === 'string' ? request.freeText.slice(0, ADAPTATION_LIMITS.freeTextChars) : '',
    useReadiness: request.useReadiness !== false,
  };
}

export const SORENESS_LABEL: Record<SorenessLevel, string> = { mild: 'Mild', moderate: 'Moderate' };

export const DROP_REASON_LABEL: Record<AdaptationDropReason, string> = {
  time: 'Time',
  sore: 'Sore',
  equipment: 'Equipment',
  energy: 'Energy',
  other: 'Other',
};

/** "30 min, sore chest (mild), only 2 kinds of equipment, low energy". */
export function requestSummary(request: Partial<AdaptationRequest> | null | undefined, humanize: (value: string) => string): string {
  if (!request) return '';
  const parts: string[] = [];
  if (typeof request.minutes === 'number') parts.push(`${request.minutes} min`);
  if (request.soreness) {
    parts.push(`sore ${request.soreness.muscles.map((m) => humanize(m).toLowerCase()).join(', ')} (${request.soreness.level})`);
  }
  if (request.equipment?.mode === 'only') {
    const n = request.equipment.equipmentTypeIds.length;
    parts.push(`only ${n} kind${n === 1 ? '' : 's'} of equipment`);
  }
  if (request.equipment?.mode === 'bodyweight') parts.push('bodyweight only');
  if (request.lowEnergy) parts.push('low energy');
  if (request.gymId) parts.push('another gym');
  return parts.join(', ');
}
