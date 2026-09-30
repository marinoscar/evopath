import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCORE_TOLERANCE, personaDrift, regressions, updateRequested, writeBaseline, type PipelineBaseline } from './baselines';

const baseline = (good: { raw: number | null; shipped: number | null }, ids = ['a']): PipelineBaseline => ({
  suite: 'training-plan-quality',
  mode: 'pipeline',
  personas: Object.fromEntries(ids.map((id) => [id, { good, passRate: 1 }])),
  overall: { passRate: 1, meanRaw: 1, meanShipped: 1 },
});

describe('baselines', () => {
  it('are rewritten only with EVAL_UPDATE_BASELINE=1', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'eval-baseline-')), 'pipeline.json');

    expect(updateRequested({})).toBe(false);
    expect(updateRequested({ EVAL_UPDATE_BASELINE: 'true' })).toBe(false);
    expect(() => writeBaseline(path, { a: 1 }, {})).toThrow('EVAL_UPDATE_BASELINE=1');
    expect(existsSync(path)).toBe(false);

    writeBaseline(path, { a: 1 }, { EVAL_UPDATE_BASELINE: '1' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
  });

  it('flags a score below the baseline by more than the tolerance and nothing else', () => {
    const base = baseline({ raw: 0.9, shipped: 1 });

    expect(regressions(baseline({ raw: 0.9 - SCORE_TOLERANCE / 2, shipped: 1 }), base)).toEqual([]);
    expect(regressions(baseline({ raw: 0.95, shipped: 1 }), base)).toEqual([]);
    expect(regressions(baseline({ raw: 0.8, shipped: 0.9 }), base)).toEqual([
      { id: 'a', layer: 'raw', baseline: 0.9, current: 0.8, delta: -0.1 },
      { id: 'a', layer: 'shipped', baseline: 1, current: 0.9, delta: -0.1 },
    ]);
  });

  it('reports personas added to or removed from the set', () => {
    expect(personaDrift(baseline({ raw: 1, shipped: 1 }, ['a', 'b']), baseline({ raw: 1, shipped: 1 }, ['a', 'c']))).toEqual({ added: ['b'], removed: ['c'] });
  });
});
