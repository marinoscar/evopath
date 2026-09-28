// =============================================================================
// AiRunsService (issue #432) — the ai_runs state machine and owner scoping
// =============================================================================

import { NotFoundException } from '@nestjs/common';

import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_OTHER_USER,
  HARNESS_USER,
} from '../testing/ai-runtime-harness';
import { AI_RESPONSE_RUN_TYPE, AI_RUN_SUBJECT_TYPE } from './ai-runs.service';

const request = { provider: 'openai', model: HARNESS_MODEL, input: 'hello' };

async function newRun() {
  const h = createAiRuntimeHarness();
  const handle = await h.runs.create({
    userId: HARNESS_USER,
    provider: 'openai',
    modelId: HARNESS_MODEL,
    request,
  });

  return { h, handle, row: () => h.runRows.find((r) => r.id === handle.runId)! };
}

describe('AiRunsService', () => {
  it('creates a pending row and enqueues its job in one transaction', async () => {
    const { h, handle, row } = await newRun();

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({
      userId: HARNESS_USER,
      status: 'pending',
      provider: 'openai',
      modelId: HARNESS_MODEL,
      request,
      jobId: handle.jobId,
    });
    expect(h.jobs.enqueueWithin).toHaveBeenCalledWith(expect.anything(), {
      type: AI_RESPONSE_RUN_TYPE,
      reason: 'upload',
      subjectType: AI_RUN_SUBJECT_TYPE,
      subjectId: handle.runId,
      payload: { runId: handle.runId },
    });
  });

  describe('get', () => {
    it("returns the owner's run view, without its request", async () => {
      const { h, handle } = await newRun();

      const view = await h.runs.get(HARNESS_USER, handle.runId);

      expect(view).toMatchObject({
        id: handle.runId,
        status: 'pending',
        provider: 'openai',
        modelId: HARNESS_MODEL,
        output: null,
        errorCode: null,
        jobId: handle.jobId,
        completedAt: null,
      });
      expect(view).not.toHaveProperty('request');
      expect(view).not.toHaveProperty('userId');
    });

    it("is a 404 for another user's run and for a malformed id", async () => {
      const { h, handle } = await newRun();

      await expect(h.runs.get(HARNESS_OTHER_USER, handle.runId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(h.runs.get(HARNESS_USER, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancel', () => {
    it('cancels a pending run', async () => {
      const { h, handle } = await newRun();

      const view = await h.runs.cancel(HARNESS_USER, handle.runId);

      expect(view.status).toBe('cancelled');
      expect(view.completedAt).toBeInstanceOf(Date);
    });

    it("cannot cancel another user's run", async () => {
      const { h, handle, row } = await newRun();

      await expect(h.runs.cancel(HARNESS_OTHER_USER, handle.runId)).rejects.toBeInstanceOf(NotFoundException);
      expect(row().status).toBe('pending');
    });

    it('aborts the provider call of a run executing in this process', async () => {
      const { h, handle } = await newRun();
      const controller = new AbortController();

      await h.runs.claim(handle.runId, handle.jobId);
      const detach = h.runs.attach(handle.runId, controller);
      await h.runs.cancel(HARNESS_USER, handle.runId);
      detach();

      expect(controller.signal.aborted).toBe(true);
    });

    it('leaves a finished run unchanged (idempotent)', async () => {
      const { h, handle, row } = await newRun();
      await h.runs.claim(handle.runId, handle.jobId);
      await h.runs.fail(handle.runId, 'AI_KEY_INVALID', 'rejected');

      const view = await h.runs.cancel(HARNESS_USER, handle.runId);

      expect(view.status).toBe('failed');
      expect(row().errorCode).toBe('AI_KEY_INVALID');
    });
  });

  describe('transitions are conditional on the current status', () => {
    it('claim only from pending', async () => {
      const { h, handle } = await newRun();

      expect(await h.runs.claim(handle.runId, handle.jobId)).toBe(true);
      expect(await h.runs.claim(handle.runId, handle.jobId)).toBe(false);
    });

    it('a late completion never overwrites a cancellation', async () => {
      const { h, handle, row } = await newRun();
      await h.runs.claim(handle.runId, handle.jobId);
      await h.runs.cancel(HARNESS_USER, handle.runId);

      const completed = await h.runs.complete(handle.runId, {
        id: 'r',
        provider: 'openai',
        model: HARNESS_MODEL,
        output: [],
        outputText: 'late',
        usage: {},
        finishReason: 'stop',
      });

      expect(completed).toBe(false);
      expect(row().status).toBe('cancelled');
      expect(row().output).toBeNull();
    });

    it('release returns a running run to pending', async () => {
      const { h, handle, row } = await newRun();
      await h.runs.claim(handle.runId, handle.jobId);

      await h.runs.release(handle.runId);

      expect(row().status).toBe('pending');
    });

    it('detach only removes its own controller', async () => {
      const { h, handle } = await newRun();
      const first = new AbortController();
      const second = new AbortController();

      const detachFirst = h.runs.attach(handle.runId, first);
      h.runs.attach(handle.runId, second);
      detachFirst();
      await h.runs.cancel(HARNESS_USER, handle.runId);

      expect(first.signal.aborted).toBe(false);
      expect(second.signal.aborted).toBe(true);
    });
  });
});
