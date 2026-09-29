// =============================================================================
// "Scan gym" (E3.4) test fixtures
// =============================================================================
//
// `gym-scan/*.model-output.json` is what the fake provider answers as the
// model's structured output for the two reference photos in
// `docs/examples/gym-scan/`; `*.expected-drafts.json` is exactly what the
// review screen must receive (the `DraftItemView`s without `id` and
// `sortOrder`). `<photo0>` / `<photo1>` stand for the storage object ids of
// the first / second uploaded photo.
//
// `seedVocabulary()` builds the vocabulary from `prisma/seed-data.ts`, the
// same rows `npm run prisma:seed` writes, for tests without a database.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CAPABILITY_CATALOG, EQUIPMENT_CATALOG } from '../../prisma/seed-data';
import {
  knownCapabilitySlugs,
  type EquipmentVocabulary,
} from '../../src/gyms/scan/equipment-vocabulary';

export const GYM_SCAN_FIXTURE_DIR = join(__dirname, 'gym-scan');

export type GymScanExample = 'cardio-row-wide' | 'leg-curl-placard' | 'both';

export function loadModelOutput(example: GymScanExample): any {
  return JSON.parse(readFileSync(join(GYM_SCAN_FIXTURE_DIR, `${example}.model-output.json`), 'utf8'));
}

/** The expected drafts with `<photoN>` replaced by `photoIds[N]`. */
export function loadExpectedDrafts(example: Exclude<GymScanExample, 'both'>, photoIds: readonly string[]): any[] {
  const raw = readFileSync(join(GYM_SCAN_FIXTURE_DIR, `${example}.expected-drafts.json`), 'utf8');
  return JSON.parse(raw.replace(/<photo(\d+)>/g, (_match, index: string) => photoIds[Number(index)]));
}

export function seedVocabulary(): EquipmentVocabulary {
  const capabilities = [...CAPABILITY_CATALOG]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({ slug: c.slug, name: c.name, movementPattern: c.movementPattern, primaryMuscles: [...c.primaryMuscles] }));
  const vocab: EquipmentVocabulary = { capabilities, equipmentTypes: [] };

  vocab.equipmentTypes = [...EQUIPMENT_CATALOG]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((type) => ({
      slug: type.slug,
      name: type.name,
      category: type.category,
      aliases: [...type.aliases],
      capabilitySlugs: knownCapabilitySlugs(vocab, type.capabilities),
    }));

  return vocab;
}
