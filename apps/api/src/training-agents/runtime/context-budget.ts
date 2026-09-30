// =============================================================================
// ContextBudget: what to drop when a model input outgrows the model's window
// =============================================================================
//
// Pure and deterministic. `fit` estimates tokens as `ceil(chars / 4)` (chars
// of the section's text, or of its JSON), and while the total exceeds the
// limit it applies the reductions below IN THIS FIXED ORDER, each to every
// section that offers it, re-estimating after each section:
//
//   1. history_rows         history rows per exercise, 6 to 3
//   2. candidate_exercises  the candidate exercise list, 150 to 80 by focus relevance
//   3. older_sessions       older sessions summarised to counts
//   4. evidence_items       evidence brief items beyond the first 8
//   5. optional_profile     optional profile fields
//
// A section declares which reductions it supports and supplies the function
// (the context builder knows what "by focus relevance" means for its rows;
// this file only decides WHEN). If every reduction was applied and the total
// is still over, optional sections are dropped whole, last first. Required
// sections are never reduced away or dropped: if they alone exceed the limit,
// `fit` throws `TrainingContextTooLargeError`.
//
// The limit is the smaller of 70 percent of the window and the window minus
// the output reserved for the answer. The result lists every reduction and
// drop, so the "what will be sent" panel can say what was left out.
// =============================================================================

export const CONTEXT_REDUCTIONS = [
  'history_rows',
  'candidate_exercises',
  'older_sessions',
  'evidence_items',
  'optional_profile',
] as const;

export type ContextReduction = (typeof CONTEXT_REDUCTIONS)[number];

/** The sizes the documented reductions shrink to. The context builder's reducers use them. */
export const CONTEXT_REDUCTION_TARGETS = {
  /** History rows kept per exercise (from 6). */
  historyRowsPerExercise: 3,
  /** Candidate exercises kept, most relevant to the focus first (from 150). */
  candidateExercises: 80,
  /** Evidence brief items kept. */
  evidenceItems: 8,
} as const;

/** The share of the context window a model input may fill. */
export const CONTEXT_FIT_THRESHOLD = 0.7;

/** Characters per estimated token. */
export const CHARS_PER_TOKEN = 4;

export interface ContextSection<T = unknown> {
  /** Stable id (`profile`, `history`, `candidates`, ...). */
  id: string;
  /** A required section is never reduced away or dropped. */
  required: boolean;
  content: T;
  /** The reductions this section supports, each a pure function of its content. */
  reductions?: Partial<Record<ContextReduction, (content: T) => T>>;
}

export interface ContextFitOptions {
  /** The model's context window in tokens. */
  contextWindow: number;
  /** Tokens kept free for the answer. */
  reserveOutput: number;
}

export interface ContextFitStep {
  kind: 'reduced' | 'dropped';
  sectionId: string;
  /** For `reduced`: which reduction. */
  reduction?: ContextReduction;
  beforeTokens: number;
  afterTokens: number;
}

export interface ContextFitResult<T = unknown> {
  /** The sections to send, in the input order, reduced where needed; dropped ones are gone. */
  sections: ContextSection<T>[];
  estimatedTokens: number;
  limitTokens: number;
  /** Every reduction and drop, in the order applied. Empty when it fit as given. */
  steps: ContextFitStep[];
  /** Ids of sections dropped whole. */
  dropped: string[];
}

export class TrainingContextTooLargeError extends Error {
  readonly code = 'TRAINING_CONTEXT_TOO_LARGE';

  constructor(
    readonly requiredTokens: number,
    readonly limitTokens: number,
  ) {
    super(`The required context (${requiredTokens} tokens) exceeds the model's budget (${limitTokens} tokens).`);
    this.name = 'TrainingContextTooLargeError';
  }
}

/** Estimated tokens of one piece of content: `ceil(chars / 4)`. */
export function estimateTokens(content: unknown): number {
  if (content === undefined || content === null) return 0;
  const text = typeof content === 'string' ? content : JSON.stringify(content);

  return Math.ceil((text ?? '').length / CHARS_PER_TOKEN);
}

/** The token limit `fit` fits into. */
export function contextLimit(opts: ContextFitOptions): number {
  return Math.max(
    0,
    Math.min(Math.floor(opts.contextWindow * CONTEXT_FIT_THRESHOLD), opts.contextWindow - opts.reserveOutput),
  );
}

export class ContextBudget {
  fit<T>(input: readonly ContextSection<T>[], opts: ContextFitOptions): ContextFitResult<T> {
    if (!(opts.contextWindow > 0) || opts.reserveOutput < 0) {
      throw new Error('ContextBudget.fit needs a positive contextWindow and a non-negative reserveOutput');
    }

    const limitTokens = contextLimit(opts);
    const sections = input.map((section) => ({ ...section }));
    const tokens = sections.map((section) => estimateTokens(section.content));
    const total = () => tokens.reduce((sum, t, i) => (sections[i] ? sum + t : sum), 0);
    const steps: ContextFitStep[] = [];
    const dropped: string[] = [];

    const requiredTokens = sections.reduce((sum, s, i) => (s.required ? sum + tokens[i] : sum), 0);

    for (const reduction of CONTEXT_REDUCTIONS) {
      for (let i = 0; i < sections.length && total() > limitTokens; i += 1) {
        const reduce = sections[i].reductions?.[reduction];
        if (!reduce) continue;

        const before = tokens[i];
        sections[i] = { ...sections[i], content: reduce(sections[i].content) };
        tokens[i] = estimateTokens(sections[i].content);
        steps.push({ kind: 'reduced', sectionId: sections[i].id, reduction, beforeTokens: before, afterTokens: tokens[i] });
      }
    }

    const kept = sections.map(() => true);
    const keptTotal = () => tokens.reduce((sum, t, i) => (kept[i] ? sum + t : sum), 0);

    for (let i = sections.length - 1; i >= 0 && keptTotal() > limitTokens; i -= 1) {
      if (sections[i].required) continue;
      kept[i] = false;
      dropped.push(sections[i].id);
      steps.push({ kind: 'dropped', sectionId: sections[i].id, beforeTokens: tokens[i], afterTokens: 0 });
    }

    if (keptTotal() > limitTokens) {
      const requiredNow = sections.reduce((sum, s, i) => (s.required ? sum + tokens[i] : sum), 0);
      throw new TrainingContextTooLargeError(Math.min(requiredTokens, requiredNow), limitTokens);
    }

    return {
      sections: sections.filter((_s, i) => kept[i]),
      estimatedTokens: keptTotal(),
      limitTokens,
      steps,
      dropped,
    };
  }
}

/** A reducer keeping the first `n` items of an array. */
export function keepFirst<T>(n: number): (items: T[]) => T[] {
  return (items) => items.slice(0, n);
}

/** A reducer keeping the first `n` rows of every group in a grouped record. */
export function keepFirstPerGroup<T>(n: number): (groups: Record<string, T[]>) => Record<string, T[]> {
  return (groups) => Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.slice(0, n)]));
}
