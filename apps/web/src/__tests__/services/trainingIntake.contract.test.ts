/**
 * The wizard's intake constants are duplicated from the API contract. This
 * reads the API's source (there is no generated OpenAPI file in the tree)
 * and fails when the two drift: the enums and every bound.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  TRAINING_AUTONOMY,
  TRAINING_EXPERIENCE_LEVELS,
  TRAINING_GOAL_TYPES,
  TRAINING_INTAKE_LIMITS,
  TRAINING_LIMITATION_AREAS,
  TRAINING_RUN_STATUSES,
} from '../../services/trainingAgents';

const API = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src/training-agents');
const read = (path: string) => readFileSync(resolve(API, path), 'utf8');

function arrayConst(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`));
  if (!match) throw new Error(`${name} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('TrainingIntake contract', () => {
  const researcher = read('agents/researcher/researcher-context.ts');
  const intake = read('contracts/training-intake.contract.ts');

  it('mirrors the goal, experience and limitation enums', () => {
    expect([...TRAINING_GOAL_TYPES]).toEqual(arrayConst(researcher, 'RESEARCH_GOAL_TYPES'));
    expect([...TRAINING_EXPERIENCE_LEVELS]).toEqual(arrayConst(researcher, 'RESEARCH_EXPERIENCE_LEVELS'));
    expect([...TRAINING_LIMITATION_AREAS]).toEqual(arrayConst(researcher, 'RESEARCH_LIMITATION_AREAS'));
    expect([...TRAINING_AUTONOMY]).toEqual(arrayConst(intake, 'TRAINING_AUTONOMY'));
  });

  it('mirrors every bound of TRAINING_INTAKE_LIMITS', () => {
    const block = intake.match(/export const TRAINING_INTAKE_LIMITS = \{([\s\S]*?)\} as const/)?.[1];
    expect(block).toBeTruthy();
    const normalized = block!.replace(/\s+/g, ' ').replace(/_/g, '');
    const expected = Object.entries(TRAINING_INTAKE_LIMITS)
      .map(([key, value]) =>
        typeof value === 'number'
          ? `${key}: ${value}`
          : `${key}: { ${Object.entries(value)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')} }`,
      );
    for (const line of expected) expect(normalized).toContain(line);
  });

  it('mirrors the run statuses', () => {
    expect([...TRAINING_RUN_STATUSES]).toEqual(arrayConst(read('runtime/training-runs.constants.ts'), 'TRAINING_RUN_STATUSES'));
  });
});
