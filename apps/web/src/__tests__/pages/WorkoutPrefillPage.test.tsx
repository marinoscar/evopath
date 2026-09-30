/**
 * `/train/workouts/:workoutId/prefill` (E4.5): the gates (AI off, no vision
 * model, missing permission) with "Continue manually"; resume-or-create of
 * the `workout_prefill` intake; the source selector stored in the context;
 * the disclosure and privacy line; Analyze -> scanning -> review with both
 * reference examples (placard, Imperial notebook); edit/reject/add
 * missing/accept-all; the suggested name applied on click only; "Nothing
 * recognized"; Apply back to the workout with the exercises visible and no
 * set checked; the workout's Photos; 409 ALREADY_APPLIED.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import WorkoutPrefillPage, { NOTHING_RECOGNIZED, PREFILL_PRIVACY_NOTE } from '../../pages/WorkoutPrefillPage';
import WorkoutPage from '../../pages/WorkoutPage';
import { clearPhotoUrlCache } from '../../components/intake/StoragePhotoThumb';
import { mockHealthProfileSaved } from '../mocks/fixtures/health';
import { mockAiFeaturesView, mockBlockedFeatureView } from '../mocks/fixtures/aiFeatures';
import { mockEntry, mockSet, mockWorkout, statefulWorkoutsApi, type WorkoutsApiState } from '../mocks/fixtures/workouts';
import { mockExercise, statefulExercisesApi } from '../mocks/fixtures/exercises';
import {
  NOTEBOOK_DRAFTS,
  NOTEBOOK_RESULT_META,
  PLACARD_DRAFTS,
  PREFILL_PHOTO0,
  mockPrefillIntake,
  mockPrefillPhoto,
  statefulPrefillApi,
  toPrefillItems,
  type PrefillIntakeView,
} from '../mocks/fixtures/workoutPrefill';

const WORKOUT_ID = '00000000-0000-4000-8000-e00000000555';
const PREFILLER = {
  ...mockUser,
  roles: [{ name: 'contributor' }],
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'],
};

let workouts: WorkoutsApiState;

function renderPrefill(options: { user?: typeof mockUser; aiEnabled?: boolean } = {}) {
  return render(
    <Routes>
      <Route path="/train/workouts/:workoutId" element={<WorkoutPage />} />
      <Route path="/train/workouts/:workoutId/prefill" element={<WorkoutPrefillPage />} />
    </Routes>,
    {
      wrapperOptions: {
        route: `/train/workouts/${WORKOUT_ID}/prefill`,
        user: options.user ?? PREFILLER,
        aiEnabled: options.aiEnabled ?? true,
      },
    },
  );
}

const rows = () => screen.getAllByTestId('draft-item-row');
const row = (text: string) => {
  const match = rows().find((entry) => within(entry).queryAllByText(text).length > 0);
  if (!match) throw new Error(`No draft row with "${text}"`);
  return match;
};

function readyIntake(drafts = NOTEBOOK_DRAFTS, extra: Partial<PrefillIntakeView> = {}) {
  return mockPrefillIntake(WORKOUT_ID, {
    status: 'ready',
    provider: 'openai',
    modelId: 'gpt-5-mini',
    context: { workoutId: WORKOUT_ID, sourceHint: 'notebook' },
    photos: [mockPrefillPhoto(PREFILL_PHOTO0, 'notebook-page.jpg')],
    items: toPrefillItems(drafts),
    resultMeta: NOTEBOOK_RESULT_META,
    ...extra,
  });
}

/** The API's apply: append the accepted items as uncompleted sets and attach the photos. */
function applyToWorkouts(intake: PrefillIntakeView) {
  const w = workouts.workouts.find((x) => x.id === WORKOUT_ID);
  if (!w) return;
  for (const item of intake.items.filter((i) => i.status === 'accepted')) {
    const exercise = mockExercise({ slug: item.value.exerciseSlug ?? 'custom-xyz', name: item.value.name });
    w.exercises.push(
      mockEntry(exercise, {
        workoutId: w.id,
        position: w.exercises.length,
        sets: item.value.sets.map((set, i) => mockSet({ ...set, setNumber: i + 1, completed: false })),
      }),
    );
  }
  w.photos = intake.photos.map((p) => ({ id: `wp-${p.id}`, storageObjectId: p.storageObjectId, caption: null, createdAt: '2026-09-29T12:00:00.000Z' }));
}

describe('WorkoutPrefillPage', () => {
  beforeEach(() => {
    clearPhotoUrlCache();
    workouts = statefulWorkoutsApi([mockWorkout({ id: WORKOUT_ID, name: 'Workout' })]);
    statefulExercisesApi();
  });

  it('with AI off shows the notice and Continue manually opens the exercise picker on the workout', async () => {
    const api = statefulPrefillApi();
    const user = userEvent.setup();
    renderPrefill({ aiEnabled: false });

    expect(await screen.findByText('AI is turned off for this app')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue manually' }));
    expect(await screen.findByRole('dialog', { name: 'Add exercises' })).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  it('without an assigned model says so and creates no intake', async () => {
    const api = statefulPrefillApi();
    server.use(
      http.get('*/api/ai/features', () =>
        HttpResponse.json({ data: mockAiFeaturesView({ workout_prefill: mockBlockedFeatureView('workout_prefill', 'missing_capability', 'admin') }) }),
      ),
    );
    renderPrefill();
    expect(
      await screen.findByText("Your administrator hasn't assigned an AI model that can read photos yet."),
    ).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  it('without ai:use (a viewer) explains why and creates no intake', async () => {
    const api = statefulPrefillApi();
    renderPrefill({ user: { ...PREFILLER, permissions: PREFILLER.permissions.filter((p) => p !== 'ai:use') } });
    expect(await screen.findByText('Your account cannot use AI features.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue manually' })).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  it('creates an intake for this workout, stores the source, and shows the disclosure and privacy line', async () => {
    const api = statefulPrefillApi();
    const user = userEvent.setup();
    renderPrefill();

    expect(await screen.findByTestId('prefill-photos')).toBeInTheDocument();
    expect(api.calls[0].path).toBe(
      `/intakes?kind=workout_prefill&subjectId=${WORKOUT_ID}&status=draft%2Cscanning%2Cready&limit=1`,
    );
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'workout_prefill',
      context: { workoutId: WORKOUT_ID },
    });
    expect(screen.getByTestId('ai-vision-disclosure')).toHaveTextContent(
      'These photos will be sent to openai (GPT-5 mini) using your own key.',
    );
    expect(screen.getByText(PREFILL_PRIVACY_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled();

    // Source selector: "Not sure" by default; Notebook is stored in the context.
    const group = screen.getByRole('radiogroup', { name: 'What is in the photos?' });
    expect(within(group).getByRole('radio', { name: 'Not sure' })).toBeChecked();
    await user.click(within(group).getByRole('radio', { name: 'Notebook' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        context: { workoutId: WORKOUT_ID, sourceHint: 'notebook' },
      }),
    );
    expect(within(group).getByRole('radio', { name: 'Notebook' })).toBeChecked();

    // Back to "Not sure" omits the hint (the whole context is replaced).
    await user.click(within(group).getByRole('radio', { name: 'Not sure' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ context: { workoutId: WORKOUT_ID } }),
    );
  });

  it('resumes an unfinished prefill, analyzes and shows the placard draft (Leg curl, High, no sets)', async () => {
    const draft = mockPrefillIntake(WORKOUT_ID, {
      context: { workoutId: WORKOUT_ID, sourceHint: 'machine_placard' },
      photos: [mockPrefillPhoto(PREFILL_PHOTO0, 'leg-curl-placard.jpg')],
    });
    const api = statefulPrefillApi([draft], { scanResult: PLACARD_DRAFTS, scanningReads: 1 });
    const user = userEvent.setup();
    renderPrefill();

    const analyze = await screen.findByRole('button', { name: 'Analyze' });
    expect(screen.getByRole('radio', { name: 'Machine placard' })).toBeChecked();
    await waitFor(() => expect(analyze).toBeEnabled());
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/intakes')).toBe(false);

    await user.click(analyze);
    expect(await screen.findByTestId('prefill-scanning')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Analyzing 1 photo in 1 request.');
    expect(api.calls.find((c) => c.path.endsWith('/analyze'))?.body).toEqual({});

    expect(await screen.findByTestId('prefill-review', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
    const legCurl = row('Leg curl');
    expect(within(legCurl).getByText('High confidence')).toBeInTheDocument();
    expect(within(legCurl).getByText('AI guess')).toBeInTheDocument();
    expect(within(legCurl).getByText('read as: LEG CURL')).toBeInTheDocument();
    expect(within(legCurl).getByText('No sets')).toBeInTheDocument();
    expect(screen.queryByTestId('prefill-suggested-name')).toBeNull();
  }, 15000);

  it('shows the notebook example in lb: five drafts, the low-confidence one included, unit notes visible', async () => {
    server.use(http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })));
    statefulPrefillApi([readyIntake()]);
    renderPrefill();
    await screen.findByTestId('prefill-review');

    expect(rows()).toHaveLength(5);
    await waitFor(() =>
      expect(within(row('Barbell bench press')).getByTestId('exercise-draft-sets')).toHaveTextContent(
        '3 sets: 135 lb × 10, 10, 8',
      ),
    );
    expect(within(row('Incline dumbbell press')).getByTestId('exercise-draft-sets')).toHaveTextContent(
      '50 lb × 12, 12, 12',
    );
    expect(within(row('Triceps pushdown')).getByTestId('exercise-draft-sets')).toHaveTextContent('40 lb × 15, 15');
    expect(within(row('Plank')).getByTestId('exercise-draft-sets')).toHaveTextContent('1 set: 1:00');

    const unreadable = row('Unreadable cable exercise');
    expect(within(unreadable).getByText('Low confidence')).toBeInTheDocument();
    expect(within(unreadable).getByText('read as: Cbl r? 25x12')).toBeInTheDocument();
    expect(within(unreadable).getByText('New custom exercise')).toBeInTheDocument();
    expect(within(unreadable).getByTestId('exercise-draft-sets')).toHaveTextContent('25 lb × 12');

    expect(screen.getAllByText(/Unit not written; assumed lb/)).toHaveLength(4);
    expect(screen.getByTestId('prefill-ignored')).toHaveTextContent('Not used: Push day heading');
  });

  it('sets the suggested name only on click', async () => {
    statefulPrefillApi([readyIntake()]);
    const user = userEvent.setup();
    renderPrefill();
    const button = await screen.findByRole('button', { name: 'Use “Push day” as workout name' });
    expect(workouts.calls.some((c) => c.method === 'PATCH')).toBe(false);

    await user.click(button);
    await waitFor(() =>
      expect(workouts.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Push day' }),
    );
    expect(await screen.findByText('The workout is named “Push day”.')).toBeInTheDocument();
  });

  it('edits sets in the display unit, rejects, adds a missing exercise, accepts all and applies', async () => {
    server.use(http.get('*/api/health-profile', () => HttpResponse.json({ data: mockHealthProfileSaved })));
    const api = statefulPrefillApi([readyIntake()], { onApply: applyToWorkouts });
    const user = userEvent.setup();
    renderPrefill();
    await screen.findByTestId('prefill-review');
    await waitFor(() =>
      expect(within(row('Barbell bench press')).getByTestId('exercise-draft-sets')).toHaveTextContent('135 lb'),
    );

    // Bench: 135 -> 140 lb on the first set.
    const bench = row('Barbell bench press');
    await user.click(within(bench).getByRole('button', { name: 'Edit' }));
    const editor = within(bench).getByTestId('exercise-draft-editor');
    expect(within(editor).getByRole('combobox', { name: 'Exercise' })).toHaveValue('Barbell bench press');
    const weight = within(editor).getByRole('textbox', { name: 'Set 1 weight' });
    expect(weight).toHaveValue('135');
    await user.clear(weight);
    await user.type(weight, '140');
    await user.click(within(bench).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(within(row('Barbell bench press')).getByText('You verified')).toBeInTheDocument());
    const patch = api.calls.find((c) => c.method === 'PATCH' && c.path.includes('/items/'))?.body as {
      value: { exerciseSlug: string; sets: { weightKg: number; reps: number }[] };
    };
    expect(patch.value.exerciseSlug).toBe('barbell_bench_press');
    expect(patch.value.sets[0]).toEqual({ weightKg: 63.503, reps: 10, durationSeconds: null, distanceMeters: null });
    expect(patch.value.sets[1].weightKg).toBe(61.235);
    expect(within(row('Barbell bench press')).getByTestId('draft-item-ai-said')).toHaveTextContent('135 lb × 10, 10, 8');

    // Reject Plank.
    await user.click(within(row('Plank')).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected (1)')).toBeInTheDocument();

    // Add "Cable row" as a new custom exercise.
    await user.click(screen.getByRole('button', { name: 'Add missing item' }));
    const add = screen.getByTestId('draft-item-add');
    await user.click(within(add).getByRole('combobox', { name: 'Exercise' }));
    // The options come from a debounced `GET /exercises`; wait for the library to land so
    // the listbox has stopped re-rendering before the custom option is clicked.
    await screen.findByRole('option', { name: 'Barbell bench press' });
    await user.click(await screen.findByRole('option', { name: 'New custom exercise (type a name)' }));
    await user.type(await within(add).findByRole('textbox', { name: 'Exercise name' }), 'Cable row');
    await user.click(within(add).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/items'))).toBe(true));
    const added = api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/items'))?.body;
    expect(added).toEqual({ kind: 'exercise', value: { exerciseSlug: null, name: 'Cable row', rawText: null, sets: [] } });
    expect(await screen.findByText('You added')).toBeInTheDocument();

    // Apply is disabled while items are pending.
    const apply = screen.getByRole('button', { name: 'Add to workout' });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription(/4 items are still waiting for review/);

    await user.click(screen.getByRole('button', { name: 'Accept all (4)' }));
    const confirm = await screen.findByRole('dialog', { name: 'Accept all 4 items?' });
    expect(confirm).toHaveTextContent('1 item has low confidence');
    await user.click(within(confirm).getByRole('button', { name: 'Accept all' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to workout' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Add to workout' }));

    // Back on the workout: the summary, the exercises, nothing checked, the photo.
    expect(
      await screen.findByText('5 exercises added. Sets are not marked done; check them off as you train.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Unreadable cable exercise')).toBeInTheDocument();
    expect(screen.getByText('Cable row')).toBeInTheDocument();
    expect(screen.queryByText('Plank')).toBeNull();
    for (const check of screen.getAllByRole('button', { name: /^Complete set \d+$/ })) {
      expect(check).toHaveAttribute('aria-pressed', 'false');
    }
    const photos = screen.getByRole('list', { name: 'Workout photos' });
    expect(within(photos).getAllByRole('listitem')).toHaveLength(1);
    expect(api.calls.filter((c) => c.path.endsWith('/apply'))).toHaveLength(1);
  }, 20000);

  it('says "Nothing recognized" when the AI found no exercises, with Continue manually', async () => {
    statefulPrefillApi([readyIntake([], { resultMeta: { ...NOTEBOOK_RESULT_META, suggestedName: null, ignoredNotes: [] } })]);
    const user = userEvent.setup();
    renderPrefill();
    const nothing = await screen.findByTestId('prefill-nothing');
    expect(nothing).toHaveTextContent(NOTHING_RECOGNIZED);
    expect(screen.getByRole('button', { name: 'Add to workout' })).toBeDisabled();
    await user.click(within(nothing).getByRole('button', { name: 'Continue manually' }));
    expect(await screen.findByRole('dialog', { name: 'Add exercises' })).toBeInTheDocument();
  });

  it('shows the API refusal when the prefill was already applied', async () => {
    statefulPrefillApi([readyIntake(PLACARD_DRAFTS)]);
    server.use(
      http.post('*/api/intakes/:id/apply', () =>
        HttpResponse.json(
          { statusCode: 409, code: 'ALREADY_APPLIED', message: 'This intake was already applied' },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPrefill();
    await user.click(await screen.findByRole('button', { name: 'Accept all (1)' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to workout' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Add to workout' }));
    expect(await screen.findByText(/already applied/i)).toBeInTheDocument();
    expect(screen.getByTestId('prefill-review')).toBeInTheDocument();
  });

  it('a failed analysis shows the error with Try again and Continue manually', async () => {
    const api = statefulPrefillApi(
      [mockPrefillIntake(WORKOUT_ID, { status: 'scanning', photos: [mockPrefillPhoto(PREFILL_PHOTO0, 'notebook.jpg')] })],
      { scanResult: { failed: { code: 'AI_STRUCTURED_OUTPUT_INVALID', message: 'The model answer did not match the schema.' } } },
    );
    const user = userEvent.setup();
    renderPrefill();
    const failed = await screen.findByTestId('prefill-failed', {}, { timeout: 5000 });
    expect(failed.querySelector('[data-ai-error-code="AI_STRUCTURED_OUTPUT_INVALID"]')).not.toBeNull();
    expect(within(failed).getByRole('button', { name: 'Continue manually' })).toBeInTheDocument();
    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/analyze'))).toBe(true));
  });

  it('says so when the workout is gone', async () => {
    statefulPrefillApi();
    workouts.workouts = [];
    renderPrefill();
    expect(await screen.findByText('This workout does not exist or was deleted.')).toBeInTheDocument();
  });

  it.each([
    ['review', () => readyIntake(), 'prefill-review'],
    ['photos', () => mockPrefillIntake(WORKOUT_ID, { photos: [mockPrefillPhoto(PREFILL_PHOTO0, 'notebook.jpg')] }), 'prefill-photos'],
  ] as const)('the %s step has no axe violations', async (_step, intake, testId) => {
    statefulPrefillApi([intake()]);
    const { container } = renderPrefill();
    await screen.findByTestId(testId);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
