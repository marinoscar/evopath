/**
 * User memory fixtures (#325): `GET /api/memories` and its items.
 */
import type { MemoryListView, UserMemory } from '../../../services/memories';

export function memoryId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function mockMemory(overrides: Partial<UserMemory> = {}): UserMemory {
  return {
    id: memoryId(1),
    content: 'Prefers morning workouts',
    category: 'preference',
    source: 'explicit',
    sensitivity: 'normal',
    pinned: false,
    createdAt: '2026-09-28T08:00:00.000Z',
    updatedAt: '2026-09-28T08:00:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

export const mockMemories: UserMemory[] = [
  mockMemory(),
  mockMemory({
    id: memoryId(2),
    content: 'Wants to run a half marathon in the spring',
    category: 'goal',
    source: 'extracted',
  }),
  mockMemory({
    id: memoryId(3),
    content: 'Left shoulder is sore, avoid overhead pressing',
    category: 'constraint_injury',
    source: 'user_edited',
    sensitivity: 'health',
    pinned: true,
  }),
];

export function mockMemoryListView(overrides: Partial<MemoryListView> = {}): MemoryListView {
  const items = overrides.items ?? mockMemories;
  const byCategory: Record<string, number> = {};
  for (const item of items) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  return {
    items,
    settings: { enabled: true, autoExtract: true, allowHealth: true, disclosureSeenAt: '2026-09-01T00:00:00.000Z' },
    policy: { enabled: true, autoExtract: true, maxPerUser: 200 },
    counts: { active: items.length, byCategory },
    ...overrides,
  };
}
