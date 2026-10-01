import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { OPENAI_SPEECH_VOICES } from '../../ai/providers/openai/openai-model-catalog';
import { containsProfanity, guardCoachText } from '../guard/coach-content-guard';
import {
  COACH_INTENSITIES,
  COACH_MOMENTS,
  COACH_PERSONA_IDS,
  COACH_PERSONA_VOICES,
  COACH_PERSONAS,
  assertCoachRegistryComplete,
  coachRegistryProblems,
  type Persona,
} from './index';

// =============================================================================
// Persona registry completeness (E7.2; docs/specs/ai-coach.md §2.3, §5)
// =============================================================================

/** The figures a sample line may carry: none (placeholders only), besides the persona's lexicon. */
const NO_CONTEXT_NUMBERS: number[] = [];

describe('coach persona registry', () => {
  it('holds the seven personas, in gallery order', () => {
    expect(COACH_PERSONAS.map((p) => p.id)).toEqual([...COACH_PERSONA_IDS]);
    expect(COACH_PERSONA_IDS).toEqual(['coach', 'drill_sergeant', 'stoic', 'analyst', 'butler', 'hype', 'nana']);
  });

  it('is complete: no structural problem, and the boot check passes', () => {
    expect(coachRegistryProblems()).toEqual([]);
    expect(() => assertCoachRegistryComplete()).not.toThrow();
  });

  it('the boot check fails fast on a persona missing a moment', () => {
    const broken: Persona = {
      ...COACH_PERSONAS[0],
      sampleLines: { ...COACH_PERSONAS[0].sampleLines, kickoff: { 1: 'x', 2: '', 3: 'x' } },
    };
    expect(() => assertCoachRegistryComplete([broken, ...COACH_PERSONAS.slice(1)])).toThrow(/kickoff at intensity 2/);
  });

  it('the voice list mirrors the OpenAI speech voices', () => {
    expect([...COACH_PERSONA_VOICES]).toEqual([...OPENAI_SPEECH_VOICES]);
  });

  it('defaults follow the spec table', () => {
    const voices = Object.fromEntries(COACH_PERSONAS.map((p) => [p.id, p.voice.byIntensity]));
    expect(voices).toEqual({
      coach: { 1: 'coral', 2: 'coral', 3: 'coral' },
      drill_sergeant: { 1: 'onyx', 2: 'onyx', 3: 'ash' },
      stoic: { 1: 'sage', 2: 'sage', 3: 'sage' },
      analyst: { 1: 'echo', 2: 'echo', 3: 'echo' },
      butler: { 1: 'fable', 2: 'fable', 3: 'fable' },
      hype: { 1: 'verse', 2: 'verse', 3: 'verse' },
      nana: { 1: 'shimmer', 2: 'shimmer', 3: 'shimmer' },
    });
  });

  describe.each(COACH_PERSONAS.map((p) => [p.id, p] as const))('%s', (_id, persona) => {
    it('has a non-empty sample line for every moment at every intensity', () => {
      for (const moment of COACH_MOMENTS) {
        for (const level of COACH_INTENSITIES) {
          expect(persona.sampleLines[moment][level].trim().length).toBeGreaterThan(0);
        }
      }
    });

    it('every sample line passes the content guard in its own register', () => {
      const failures: string[] = [];
      for (const moment of COACH_MOMENTS) {
        for (const level of COACH_INTENSITIES) {
          const profane = persona.profaneIntensities.includes(level);
          const violations = guardCoachText('body', persona.sampleLines[moment][level], {
            personaId: persona.id,
            intensity: level,
            register: { profane },
            lockScreenSafe: true,
            allowedNumbers: NO_CONTEXT_NUMBERS,
          });
          if (violations.length > 0) failures.push(`${moment} L${level}: ${JSON.stringify(violations)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it('a clean level\'s lines also pass in the clean register', () => {
      for (const moment of COACH_MOMENTS) {
        for (const level of COACH_INTENSITIES.filter((l) => !persona.profaneIntensities.includes(l))) {
          expect(containsProfanity(persona.sampleLines[moment][level])).toBe(false);
        }
      }
    });
  });

  it('only Sarge L3 contains profanity, and Sarge L3 is profane throughout', () => {
    for (const persona of COACH_PERSONAS) {
      for (const level of COACH_INTENSITIES) {
        const profaneLines = COACH_MOMENTS.filter((m) => containsProfanity(persona.sampleLines[m][level]));
        if (persona.id === 'drill_sergeant' && level === 3) {
          expect(profaneLines).toEqual([...COACH_MOMENTS]);
        } else {
          expect(profaneLines).toEqual([]);
        }
      }
    }
  });

  it('every persona file is registered (one *.persona.ts per persona)', () => {
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.persona.ts'));
    expect(files).toHaveLength(COACH_PERSONAS.length);
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    for (const file of files) expect(index).toContain(`./${file.replace(/\.ts$/, '')}'`);
  });

  it('persona content attributes no quote to anyone ("as X said")', () => {
    for (const persona of COACH_PERSONAS) {
      expect(JSON.stringify(persona.sampleLines)).not.toMatch(/\b(as \w+ (said|says)|in the words of)\b/i);
    }
  });
});
