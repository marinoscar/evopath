/**
 * Agent usage (E6.3), the pure parts: the month list and its names, the
 * calls' URLs, the token-cap wording (`TRAINING_RUN_BUDGET_EXCEEDED` through
 * `aiErrors` / `aiErrorText`, the run failure copy and `AiErrorAlert`'s
 * mapping), and the step, role, kind and key labels.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  formatUsageMonth,
  getMonthlyTrainingUsage,
  getTrainingRunUsage,
  selectableUsageMonths,
  utcMonthOf,
} from '../../services/trainingUsage';
import { ApiError } from '../../services/api';
import { TRAINING_RUN_BUDGET_EXCEEDED, toAiErrorInfo } from '../../services/aiErrors';
import { aiCodeText, aiErrorText, tokenCapText } from '../../components/settings/ai/aiErrorText';
import { runErrorCopy } from '../../components/training/runErrors';
import { adaptationFailureCopy } from '../../components/training/adapt/adaptationCopy';
import { aiErrorCopy } from '../../components/ai/AiErrorAlert';
import {
  formatDuration,
  keySourceLabel,
  kindLabel,
  nodeLabel,
  roleLabel,
} from '../../components/training/usage/agentUsageLabels';
import { mockMonthlyUsage, mockRunUsage } from '../mocks/fixtures/trainingUsage';

describe('months', () => {
  it('lists the current UTC month and the 12 before it, newest first', () => {
    const months = selectableUsageMonths(new Date('2026-01-31T23:30:00Z'));
    expect(months).toHaveLength(13);
    expect(months[0]).toBe('2026-01');
    expect(months[1]).toBe('2025-12');
    expect(months[12]).toBe('2025-01');
  });

  it('uses UTC, not the local day', () => {
    expect(utcMonthOf(new Date('2026-10-01T00:30:00Z'))).toBe('2026-10');
    expect(utcMonthOf(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09');
  });

  it('names a month', () => {
    expect(formatUsageMonth('2026-09')).toBe('September 2026');
    expect(formatUsageMonth('nonsense')).toBe('nonsense');
  });
});

describe('calls', () => {
  it('reads one run and one month', async () => {
    const urls: string[] = [];
    server.use(
      http.get('*/api/ai/training/runs/:runId/usage', ({ request }) => {
        urls.push(new URL(request.url).pathname);
        return HttpResponse.json({ data: mockRunUsage() });
      }),
      http.get('*/api/ai/training/usage', ({ request }) => {
        const url = new URL(request.url);
        urls.push(`${url.pathname}${url.search}`);
        return HttpResponse.json({ data: mockMonthlyUsage() });
      }),
    );
    await getTrainingRunUsage('run-1');
    await getMonthlyTrainingUsage('2026-08');
    await getMonthlyTrainingUsage();
    expect(urls).toEqual([
      '/api/ai/training/runs/run-1/usage',
      '/api/ai/training/usage?month=2026-08',
      '/api/ai/training/usage',
    ]);
  });
});

describe('token cap wording', () => {
  it('states the limit and what was used, in tokens', () => {
    expect(tokenCapText({ limitTokens: 20000, usedTokens: 20340 })).toBe(
      'Stopped at your limit of 20,000 tokens per run (used 20,340). Raise it in AI settings.',
    );
    expect(tokenCapText({ limitTokens: 20000 })).toBe('Stopped at your limit of 20,000 tokens per run. Raise it in AI settings.');
    expect(tokenCapText(null)).toBe('Stopped at your per-run token limit. Raise it in AI settings.');
    expect(aiCodeText(TRAINING_RUN_BUDGET_EXCEEDED)).toBe('Stopped at your per-run token limit. Raise it in AI settings.');
  });

  it('reads the code and the numbers from a refusal', () => {
    const err = new ApiError('Token cap', 409, 'CONFLICT', {
      reason: TRAINING_RUN_BUDGET_EXCEEDED,
      limitTokens: 20000,
      usedTokens: 20340,
    });
    const info = toAiErrorInfo(err);
    expect(info).toMatchObject({ code: TRAINING_RUN_BUDGET_EXCEEDED, limitTokens: 20000, usedTokens: 20340 });
    expect(aiErrorText(err, 'fallback')).toBe(
      'Stopped at your limit of 20,000 tokens per run (used 20,340). Raise it in AI settings.',
    );
  });

  it('words a failed run with the numbers and links the agent settings', () => {
    const copy = runErrorCopy(TRAINING_RUN_BUDGET_EXCEEDED, { cap: { limitTokens: 20000, usedTokens: 20340 } });
    expect(copy.title).toBe('Stopped at your token limit');
    expect(copy.body).toBe('Stopped at your limit of 20,000 tokens per run (used 20,340). Raise it in AI settings.');
    expect(copy.action).toEqual({ label: 'Change the limit', to: '/settings/ai/agents' });

    const adapt = adaptationFailureCopy(TRAINING_RUN_BUDGET_EXCEEDED, null, { cap: { limitTokens: 1500, usedTokens: 1612 } });
    expect(adapt.body).toContain('your limit of 1,500 tokens per run (used 1,612)');

    const alert = aiErrorCopy({ code: TRAINING_RUN_BUDGET_EXCEEDED, message: '', limitTokens: 20000, usedTokens: 20340 });
    expect(alert.body).toContain('20,000');
    expect(alert.action?.to).toBe('/settings/ai/agents');
  });
});

describe('labels', () => {
  it('names whose key paid, never calling a keyless server "your key"', () => {
    expect(keySourceLabel('user')).toBe('your key');
    expect(keySourceLabel('org')).toBe("the organisation's key");
    expect(keySourceLabel('none')).toBe('keyless server');
  });

  it('names steps, roles and kinds', () => {
    expect(nodeLabel('plan')).toBe('Planning');
    expect(nodeLabel('critique')).toBe('Critic review');
    expect(nodeLabel(null)).toBe('Not attributed to one step');
    expect(nodeLabel('mystery')).toBe('mystery');
    expect(roleLabel('evaluator')).toBe('Coach');
    expect(roleLabel('unattributed')).toBe('Not attributed to one role');
    expect(kindLabel('adapt')).toBe('Workout adjustments');
  });

  it('formats summed provider time', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(4200)).toBe('4.2 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});
