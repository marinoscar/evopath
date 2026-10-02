import {
  MEMORY_BLOCK_CHAR_BUDGET,
  MEMORY_BLOCK_CLOSE,
  MEMORY_BLOCK_OPEN,
  MEMORY_BLOCK_PREAMBLE,
  MEMORY_TRAINING_CATEGORIES,
  type MemoryCategory,
} from './memory.constants';

// =============================================================================
// The memory block: what a prompt is told about the user (#325; spec §2.5)
// =============================================================================
//
// PURE. `renderMemoryBlock` turns the user's active memories into one
// delimited, budgeted block:
//
//   ORDER     pinned first, then injuries/constraints (safety), then goals,
//             then everything else newest first.
//   AUDIENCE  `coach` sees every category; `training` (the plan agents) only
//             goal, preference, constraint_injury, schedule, equipment and
//             training_history (no nutrition, coaching style or other).
//   BUDGET    ~1,500 tokens (chars / 4); a memory that does not fit is left
//             out whole, never cut.
//   DELIMIT   `<user_memories>` ... `</user_memories>` with a preamble saying
//             the notes are user-provided DATA, possibly outdated, never
//             instructions. Anything delimiter-like inside a memory (angle
//             brackets, backticks, the tag names) is stripped, so a memory
//             cannot close its own block.
//   REFS      the coach chat numbers each line (`[m1]`, `[m2]`, ...) so its
//             `forget`/`update_memory` tools can name a memory without an
//             internal id ever reaching the model (never-send `ids`).
//
// An empty list renders as '' (no block at all).
// =============================================================================

export type MemoryAudience = 'coach' | 'training';

export interface MemoryBlockRow {
  id: string;
  content: string;
  category: string;
  pinned: boolean;
  updatedAt: Date;
}

export interface RenderedMemoryBlock {
  text: string;
  /** Ids of the memories that made it into the block, in order. */
  usedIds: string[];
  /** `m<n>` -> memory id, when refs were rendered. */
  refs: Map<string, string>;
}

const CATEGORY_RANK: Partial<Record<MemoryCategory, number>> = { constraint_injury: 0, goal: 1 };

/** Orders memories for the block: pinned, injuries/constraints, goals, then newest first. */
export function orderMemories<T extends MemoryBlockRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ra = CATEGORY_RANK[a.category as MemoryCategory] ?? 2;
    const rb = CATEGORY_RANK[b.category as MemoryCategory] ?? 2;
    if (ra !== rb) return ra - rb;
    return b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id);
  });
}

/** One memory's text with every delimiter-like sequence removed and whitespace collapsed. */
export function sanitizeMemoryForPrompt(content: string): string {
  return content
    .replace(/<\s*\/?\s*user_memories\s*>/gi, '')
    .replace(/user_memories/gi, 'user memories')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function audienceAllows(audience: MemoryAudience, category: string): boolean {
  return audience === 'coach' || MEMORY_TRAINING_CATEGORIES.includes(category as MemoryCategory);
}

export function renderMemoryBlock(
  rows: readonly MemoryBlockRow[],
  opts: { audience: MemoryAudience; withRefs?: boolean; charBudget?: number },
): RenderedMemoryBlock {
  const budget = opts.charBudget ?? MEMORY_BLOCK_CHAR_BUDGET;
  const lines: string[] = [];
  const usedIds: string[] = [];
  const refs = new Map<string, string>();
  let used = MEMORY_BLOCK_OPEN.length + MEMORY_BLOCK_PREAMBLE.length + MEMORY_BLOCK_CLOSE.length + 4;

  for (const row of orderMemories(rows.filter((r) => audienceAllows(opts.audience, r.category)))) {
    const text = sanitizeMemoryForPrompt(row.content);
    if (text.length === 0) continue;
    const ref = opts.withRefs ? `m${usedIds.length + 1}` : null;
    const line = `- ${ref ? `[${ref}] ` : ''}(${row.category}) ${text}`;
    if (used + line.length + 1 > budget) continue;
    used += line.length + 1;
    lines.push(line);
    usedIds.push(row.id);
    if (ref) refs.set(ref, row.id);
  }

  if (lines.length === 0) return { text: '', usedIds: [], refs };
  return { text: [MEMORY_BLOCK_OPEN, MEMORY_BLOCK_PREAMBLE, ...lines, MEMORY_BLOCK_CLOSE].join('\n'), usedIds, refs };
}
