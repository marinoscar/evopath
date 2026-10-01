import { COACH_NEVER_SEND, COACH_NEVER_SEND_IDS } from '../../src/coach/context/coach-never-send';
import { NEVER_SEND } from '../../src/training-agents/context/never-send';
import { NOW, PAYLOAD, nudgeSignals, setupNudge } from './coach-nudge.fixtures';

// =============================================================================
// The coach's never-send canary (E7.5, #245; spec §2.6, AC 6)
// =============================================================================
//
// One canary per never-send entry, seeded in the source the nudge job could
// plausibly read it from. Two kinds of proof:
//
//   SEEDED   the canary sits in a row or a signals field the job DOES read;
//            it must appear in no model request.
//   UNREAD   the source is a table the job must never touch at all; the
//            recorded Prisma access proves it was not read.
//
// Every id of `COACH_NEVER_SEND` has exactly one row below, so a new entry
// without a canary fails the coverage case. The weekly review (E7.10) and the
// chat (E7.7) extend this file with their own requests.
// =============================================================================

const C = {
  name: 'CANARY-NAME-Zq81',
  email: 'canary-email-Zq82@example.com',
  dob: new Date('1980-02-03T00:00:00Z'),
  painNote: 'CANARY-PAIN-NOTE-Zq83',
  bodyWeight: 913.77,
  bodyFat: 47.71,
  programWorkoutId: '00000000-0000-4000-8000-00000000c0de',
  exerciseId: '00000000-0000-4000-8000-00000000c0df',
  priorBody: 'CANARY-PRIOR-BODY-Zq84',
  audioObject: '00000000-0000-4000-8000-00000000c0e0',
  photoNote: 'CANARY-PHOTO-NOTE-Zq85',
  storageKey: 'ai-outputs/CANARY-KEY-Zq86',
};

/** never-send id -> how it is proven. */
const PROOF: Record<string, { seeded?: string[]; unread?: string[] }> = {
  name: { seeded: [C.name] },
  email: { seeded: [C.email] },
  date_of_birth: { seeded: ['1980-02-03', '1980'] },
  exact_age: { seeded: ['46 years'] },
  check_in_notes: { unread: ['checkIn'] },
  pain_notes: { seeded: [C.painNote], unread: ['workoutSet'] },
  other_free_text: { unread: ['workout', 'measurement'] },
  medications: { unread: ['medication'] },
  labs: { unread: ['labResult', 'measurement', 'healthSummary'] },
  documents_photos: { unread: ['healthDocument', 'storageObject'] },
  storage: { seeded: [C.storageKey, C.audioObject], unread: ['storageObject'] },
  other_gyms: { unread: ['gym'] },
  gym_name: { unread: ['gym'] },
  other_users: { unread: ['user'] },
  ids: { seeded: [C.programWorkoutId, C.exerciseId] },
  progress_photos: { seeded: [C.photoNote], unread: ['progressPhoto'] },
  coach_audio: { seeded: [C.audioObject] },
  body_measurements: { seeded: ['913.77', '47.71'] },
  coach_message_bodies: { seeded: [C.priorBody] },
};

describe('coach never-send canary (ai.coach.nudge)', () => {
  it('COACH_NEVER_SEND extends the training agents\' list', () => {
    for (const entry of NEVER_SEND) expect(COACH_NEVER_SEND_IDS).toContain(entry.id);
    expect(COACH_NEVER_SEND_IDS).toEqual(expect.arrayContaining(['progress_photos', 'coach_audio']));
  });

  it('every never-send entry has a canary proof', () => {
    expect(Object.keys(PROOF).sort()).toEqual([...COACH_NEVER_SEND_IDS].sort());
    for (const entry of COACH_NEVER_SEND) {
      const proof = PROOF[entry.id];
      expect((proof.seeded?.length ?? 0) + (proof.unread?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it('no canary reaches the model request, and no forbidden table is read', async () => {
    const signals = nudgeSignals({
      body: { weightKg: { latest: C.bodyWeight, changePerWeek: -0.4, points: 5 }, bodyFatPct: { latest: C.bodyFat, points: 2 } },
      pain: [
        {
          exerciseId: C.exerciseId,
          slug: 'squat',
          name: 'Squat',
          lastFlaggedOn: '2026-09-30',
          flaggedSessions28d: 1,
          consecutiveFlaggedSessions: 1,
        },
      ],
    });
    signals.sessions[0].programWorkoutId = C.programWorkoutId;
    (signals.pain[0] as Record<string, unknown>).note = C.painNote;

    const t = setupNudge({
      signals,
      dob: C.dob,
      userExtras: { name: C.name, email: C.email, progressPhotos: [{ note: C.photoNote, storageKey: C.storageKey }] },
      historyExtras: { body: C.priorBody, audioStorageObjectId: C.audioObject, data: { storageKey: C.storageKey } },
    });
    await t.handler.run('job-canary', PAYLOAD, NOW);

    expect(t.respondStructured).toHaveBeenCalled();
    const requests = t.respondStructured.mock.calls.map((call) => JSON.stringify(call[0]));
    const leaks: string[] = [];
    for (const [id, proof] of Object.entries(PROOF)) {
      for (const canary of proof.seeded ?? []) {
        if (requests.some((r) => r.includes(canary))) leaks.push(`${id}: ${canary}`);
      }
      for (const model of proof.unread ?? []) {
        if (t.accessedModels.has(model)) leaks.push(`${id}: read prisma.${model}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
