import {
  CONTEXT_REDUCTIONS,
  ContextBudget,
  type ContextFitResult,
  type ContextSection,
  TrainingContextTooLargeError,
  contextLimit,
  estimateTokens,
  keepFirst,
  keepFirstPerGroup,
} from './context-budget';

/** A section of `tokens` estimated tokens (4 chars each). */
const text = (tokens: number) => 'x'.repeat(tokens * 4);

function section(
  id: string,
  tokens: number,
  opts: { required?: boolean; reduces?: Array<[(typeof CONTEXT_REDUCTIONS)[number], number]> } = {},
): ContextSection<string> {
  return {
    id,
    required: opts.required ?? false,
    content: text(tokens),
    reductions: Object.fromEntries((opts.reduces ?? []).map(([reduction, to]) => [reduction, () => text(to)])),
  };
}

// contextWindow 1000, reserveOutput 0 -> limit 700.
const WINDOW = { contextWindow: 1_000, reserveOutput: 0 };

describe('ContextBudget.fit', () => {
  const budget = new ContextBudget();

  it('estimates ceil(chars / 4), strings as is and anything else as JSON', () => {
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens({ a: 1 })).toBe(Math.ceil('{"a":1}'.length / 4));
    expect(estimateTokens(null)).toBe(0);
  });

  it('limits to the smaller of 70 percent of the window and the window minus the reserved output', () => {
    expect(contextLimit({ contextWindow: 1_000, reserveOutput: 0 })).toBe(700);
    expect(contextLimit({ contextWindow: 1_000, reserveOutput: 500 })).toBe(500);
  });

  it('leaves a context that fits untouched', () => {
    const input = [section('profile', 300, { required: true }), section('history', 300, { reduces: [['history_rows', 100]] })];

    const out = budget.fit(input, WINDOW);

    expect(out.steps).toEqual([]);
    expect(out.estimatedTokens).toBe(600);
    expect(out.sections.map((s) => s.content)).toEqual(input.map((s) => s.content));
  });

  it.each([
    // [label, total tokens, expected reductions applied (in order)]
    ['one reduction is enough', 750, ['history_rows']],
    ['two are needed', 900, ['history_rows', 'candidate_exercises']],
    ['all five, in the documented order', 1_200, [...CONTEXT_REDUCTIONS]],
  ])('applies reductions in the fixed order until it fits: %s', (_label, profileTokens, expected) => {
    // Each reduction saves 100 tokens; a 200-token required floor is never touched.
    const input: ContextSection<string>[] = [
      section('floor', 200, { required: true }),
      section('evidence', 100, { reduces: [['evidence_items', 0]] }),
      section('history', 100, { required: true, reduces: [['history_rows', 0]] }),
      section('optional', 100, { reduces: [['optional_profile', 0]] }),
      section('sessions', 100, { reduces: [['older_sessions', 0]] }),
      section('candidates', 100, { reduces: [['candidate_exercises', 0]] }),
      section('pad', (profileTokens as number) - 700, { required: true }),
    ];

    const out = budget.fit(input, WINDOW);

    expect(out.steps.map((s) => s.reduction)).toEqual(expected);
    expect(out.estimatedTokens).toBeLessThanOrEqual(700);
    expect(out.dropped).toEqual([]);
  });

  it('is deterministic: the same input gives the same result', () => {
    const input = () => [
      section('history', 500, { required: true, reduces: [['history_rows', 250]] }),
      section('candidates', 500, { reduces: [['candidate_exercises', 300]] }),
    ];

    const view = (out: ContextFitResult<string>) => ({
      ...out,
      sections: out.sections.map((s) => ({ id: s.id, content: s.content })),
    });

    expect(view(budget.fit(input(), WINDOW))).toEqual(view(budget.fit(input(), WINDOW)));
    expect(budget.fit(input(), WINDOW).steps.map((s) => s.reduction)).toEqual(['history_rows', 'candidate_exercises']);
  });

  it('drops optional sections whole, last first, when every reduction was not enough; never a required one', () => {
    const input = [
      section('profile', 400, { required: true }),
      section('brief', 200),
      section('candidates', 200),
      section('history', 100, { required: true }),
    ];

    const out = budget.fit(input, WINDOW);

    expect(out.dropped).toEqual(['candidates']);
    expect(out.sections.map((s) => s.id)).toEqual(['profile', 'brief', 'history']);
    expect(out.steps).toEqual([{ kind: 'dropped', sectionId: 'candidates', beforeTokens: 200, afterTokens: 0 }]);
    expect(out.estimatedTokens).toBe(700);
  });

  it('throws TrainingContextTooLargeError when the required sections alone exceed the limit', () => {
    const input = [section('profile', 800, { required: true }), section('brief', 50)];

    expect(() => budget.fit(input, WINDOW)).toThrow(TrainingContextTooLargeError);
    try {
      budget.fit(input, WINDOW);
    } catch (error) {
      expect(error).toMatchObject({ code: 'TRAINING_CONTEXT_TOO_LARGE', limitTokens: 700 });
    }
  });

  it('refuses nonsense options', () => {
    expect(() => budget.fit([], { contextWindow: 0, reserveOutput: 0 })).toThrow();
  });
});

describe('reducer helpers', () => {
  it('keepFirst and keepFirstPerGroup trim deterministically', () => {
    expect(keepFirst<number>(2)([1, 2, 3])).toEqual([1, 2]);
    expect(keepFirstPerGroup<number>(3)({ squat: [1, 2, 3, 4, 5, 6], bench: [1] })).toEqual({
      squat: [1, 2, 3],
      bench: [1],
    });
  });
});
