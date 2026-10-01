/**
 * `usePhotoIntake` against the MSW network. Real timers with a 10 ms
 * interval, as `useAiRun.test.ts` does: the same timeout chain as the 2 s
 * default.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  PHOTO_INTAKE_MAX_POLL_FAILURES,
  PHOTO_INTAKE_POLL_INTERVAL_MS,
  usePhotoIntake,
} from '../../hooks/usePhotoIntake';
import type { DraftItemView, PhotoIntakeStatus, PhotoIntakeView } from '../../services/intake';

const FAST = 10;
const T0 = '2026-09-01T00:00:00.000Z';

function item(id: string, extra: Partial<DraftItemView<{ name: string }>> = {}): DraftItemView<{ name: string }> {
  return {
    id,
    kind: 'equipment',
    origin: 'ai',
    status: 'pending',
    confidence: 'high',
    uncertain: false,
    uncertaintyNote: null,
    sourcePhotoIds: ['obj-1'],
    userVerified: false,
    value: { name: id },
    originalAiValue: null,
    sortOrder: 0,
    ...extra,
  };
}

function intake(status: PhotoIntakeStatus, extra: Partial<PhotoIntakeView<{ name: string }>> = {}): PhotoIntakeView<{ name: string }> {
  return {
    id: 'in-1',
    kind: 'gym_equipment',
    status,
    subjectType: 'gym',
    subjectId: null,
    context: null,
    provider: null,
    modelId: null,
    jobId: null,
    errorCode: null,
    errorMessage: null,
    retention: 'keep',
    retainFiles: true,
    resultMeta: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    photos: [{ id: 'p-1', storageObjectId: 'obj-1', name: 'rack.jpg', sortOrder: 0, healthDocumentId: null, retention: null }],
    items: [],
    ...extra,
  };
}

/** Answer successive GET /intakes/:id with `answers`, repeating the last. */
function script(answers: (PhotoIntakeView<{ name: string }> | number)[]) {
  const reads: string[] = [];
  server.use(
    http.get('*/api/intakes/:id', ({ params }) => {
      reads.push(String(params.id));
      const answer = answers[Math.min(reads.length - 1, answers.length - 1)];
      if (typeof answer === 'number') {
        return HttpResponse.json({ code: 'ERR', message: `status ${answer}` }, { status: answer });
      }
      return HttpResponse.json({ data: answer });
    }),
  );
  return reads;
}

describe('usePhotoIntake', () => {
  it('defaults to a 2 s poll', () => {
    expect(PHOTO_INTAKE_POLL_INTERVAL_MS).toBe(2000);
  });

  it('loads the intake and exposes items and photos; does not poll a ready intake', async () => {
    const reads = script([intake('ready', { items: [item('a')] })]);
    const { result } = renderHook(() => usePhotoIntake<{ name: string }>('in-1', { intervalMs: FAST }));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((entry) => entry.id)).toEqual(['a']);
    expect(result.current.photos[0].name).toBe('rack.jpg');
    expect(result.current.isScanning).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, FAST * 5));
    expect(reads).toHaveLength(1);
  });

  it('polls while scanning and stops once ready, firing onScanSettled once', async () => {
    const reads = script([intake('scanning'), intake('scanning'), intake('ready', { items: [item('a')] })]);
    const onScanSettled = vi.fn();
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST, onScanSettled }));
    await waitFor(() => expect(result.current.intake?.status).toBe('ready'));
    expect(result.current.items).toHaveLength(1);
    expect(onScanSettled).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, FAST * 5));
    expect(reads).toHaveLength(3);
  });

  it('tolerates transient poll failures (stale) and recovers', async () => {
    script([intake('scanning'), 503, 503, intake('ready')]);
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.intake?.status).toBe('ready'));
    expect(result.current.stale).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it(`gives up after ${PHOTO_INTAKE_MAX_POLL_FAILURES} consecutive transient failures`, async () => {
    const reads = script([intake('scanning'), 503]);
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.stale).toBe(true);
    expect(result.current.intake?.status).toBe('scanning');
    await new Promise((resolve) => setTimeout(resolve, FAST * 10));
    expect(reads).toHaveLength(1 + PHOTO_INTAKE_MAX_POLL_FAILURES);
  });

  it('stops at once on a 404 while polling', async () => {
    const reads = script([intake('scanning'), 404]);
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.error?.status).toBe(404));
    await new Promise((resolve) => setTimeout(resolve, FAST * 5));
    expect(reads).toHaveLength(2);
  });

  it('exposes a failed scan as scanError', async () => {
    script([intake('failed', { errorCode: 'AI_PROVIDER_ERROR', errorMessage: 'The provider failed' })]);
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.scanError).toEqual({ code: 'AI_PROVIDER_ERROR', message: 'The provider failed' }));
  });

  it('analyze posts an empty body (the server picks the model), flips to scanning and polls', async () => {
    let body: unknown = null;
    script([intake('draft'), intake('ready', { items: [item('a')] })]);
    server.use(
      http.post('*/api/intakes/:id/analyze', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { intakeId: 'in-1', jobId: 'job-1' } }, { status: 202 });
      }),
    );
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.intake?.status).toBe('draft'));

    let ok = false;
    await act(async () => {
      ok = await result.current.analyze({ provider: 'openai', modelId: 'gpt-5-mini' });
    });
    expect(ok).toBe(true);
    expect(body).toEqual({});
    expect(result.current.intake).toMatchObject({
      status: 'scanning',
      jobId: 'job-1',
      provider: 'openai',
      modelId: 'gpt-5-mini',
    });
    await waitFor(() => expect(result.current.intake?.status).toBe('ready'));
  });

  it('analyze reports an AI refusal as error (AiErrorAlert-ready)', async () => {
    script([intake('draft')]);
    server.use(
      http.post('*/api/intakes/:id/analyze', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'AI is disabled', details: { reason: 'AI_DISABLED' } },
          { status: 403 },
        ),
      ),
    );
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.intake).not.toBeNull());
    await act(async () => {
      await result.current.analyze();
    });
    expect(result.current.error).toMatchObject({ code: 'AI_DISABLED', status: 403 });
    expect(result.current.intake?.status).toBe('draft');
  });

  it('adopts the server item after edit, accept, reject and restore', async () => {
    script([intake('ready', { items: [item('a'), item('b', { sortOrder: 1 })] })]);
    const patches: unknown[] = [];
    server.use(
      http.patch('*/api/intakes/:id/items/:itemId', async ({ params, request }) => {
        const patch = (await request.json()) as { value?: { name: string }; status?: DraftItemView['status'] };
        patches.push(patch);
        return HttpResponse.json({
          data: item(String(params.itemId), {
            ...(patch.value ? { value: patch.value, originalAiValue: { name: String(params.itemId) } } : {}),
            ...(patch.status ? { status: patch.status } : {}),
            userVerified: patch.status !== 'pending',
          }),
        });
      }),
    );
    const { result } = renderHook(() => usePhotoIntake<{ name: string }>('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await act(async () => result.current.editItem('a', { name: 'Leg press' }));
    expect(result.current.items[0]).toMatchObject({ value: { name: 'Leg press' }, originalAiValue: { name: 'a' }, userVerified: true });

    await act(async () => result.current.acceptItem('a'));
    await act(async () => result.current.rejectItem('b'));
    expect(result.current.items.map((entry) => entry.status)).toEqual(['accepted', 'rejected']);
    await act(async () => result.current.restoreItem('b'));
    expect(result.current.items[1].status).toBe('pending');
    expect(patches).toEqual([
      { value: { name: 'Leg press' } },
      { status: 'accepted' },
      { status: 'rejected' },
      { status: 'pending' },
    ]);
  });

  it('adds, deletes a user item, accepts all and applies', async () => {
    script([intake('ready', { items: [item('a')] })]);
    server.use(
      http.post('*/api/intakes/:id/items', async ({ request }) => {
        const body = (await request.json()) as { kind: string; value: { name: string } };
        return HttpResponse.json(
          {
            data: item('u1', { origin: 'user', status: 'accepted', confidence: null, userVerified: true, value: body.value, sortOrder: 5 }),
          },
          { status: 201 },
        );
      }),
      http.delete('*/api/intakes/:id/items/:itemId', () => new HttpResponse(null, { status: 204 })),
      http.post('*/api/intakes/:id/items/accept-all', () =>
        HttpResponse.json({ data: [item('a', { status: 'accepted', userVerified: true })] }),
      ),
      http.post('*/api/intakes/:id/apply', () => HttpResponse.json({ data: { created: 2 } })),
    );
    const { result } = renderHook(() => usePhotoIntake<{ name: string }>('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await act(async () => result.current.addItem('equipment', { name: 'Kettlebell' }));
    expect(result.current.items.map((entry) => entry.id)).toEqual(['a', 'u1']);

    await act(async () => result.current.deleteItem('u1'));
    expect(result.current.items.map((entry) => entry.id)).toEqual(['a']);

    await act(async () => result.current.acceptAll());
    expect(result.current.items[0].status).toBe('accepted');

    let applied: unknown;
    await act(async () => {
      applied = await result.current.apply();
    });
    expect(applied).toEqual({ created: 2 });
    expect(result.current.intake?.status).toBe('applied');
  });

  it('surfaces a refused apply (pending items) as error', async () => {
    script([intake('ready', { items: [item('a')] })]);
    server.use(
      http.post('*/api/intakes/:id/apply', () =>
        HttpResponse.json({ code: 'PENDING_ITEMS', message: '1 item still needs review', details: { count: 1 } }, { status: 400 }),
      ),
    );
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    let applied: unknown = 'x';
    await act(async () => {
      applied = await result.current.apply();
    });
    expect(applied).toBeUndefined();
    expect(result.current.error).toMatchObject({ status: 400, message: '1 item still needs review' });
    expect(result.current.intake?.status).toBe('ready');
  });

  it('setRetainFiles PATCHes the choice and adopts the answer; a refusal puts it back (#185)', async () => {
    script([intake('draft')]);
    const patches: unknown[] = [];
    let refuse = false;
    server.use(
      http.patch('*/api/intakes/:id', async ({ request }) => {
        const body = (await request.json()) as { retainFiles: boolean };
        patches.push(body);
        if (refuse) return HttpResponse.json({ code: 'INTAKE_APPLIED', message: 'Already applied' }, { status: 409 });
        return HttpResponse.json({
          data: intake('draft', {
            retainFiles: body.retainFiles,
            retention: body.retainFiles ? 'keep' : 'delete_after_processing',
          }),
        });
      }),
    );
    const { result } = renderHook(() => usePhotoIntake('in-1', { intervalMs: FAST }));
    await waitFor(() => expect(result.current.intake?.retainFiles).toBe(true));

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.setRetainFiles(false);
    });
    expect(ok).toBe(true);
    expect(patches).toEqual([{ retainFiles: false }]);
    expect(result.current.intake).toMatchObject({ retainFiles: false, retention: 'delete_after_processing' });

    refuse = true;
    await act(async () => {
      ok = await result.current.setRetainFiles(true);
    });
    expect(ok).toBe(false);
    expect(result.current.error?.message).toBe('Already applied');
    expect(result.current.intake).toMatchObject({ retainFiles: false, retention: 'delete_after_processing' });
  });

  it('does nothing without an intake id', () => {
    const { result } = renderHook(() => usePhotoIntake(null));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.intake).toBeNull();
    expect(result.current.items).toEqual([]);
  });
});
