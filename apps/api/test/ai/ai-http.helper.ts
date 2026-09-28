// =============================================================================
// A full-AppModule test app whose AI runtime is the #432 harness (issue #433)
// =============================================================================
//
// The real `AiService`, `AiRunsService` and `AiConfigService` built by
// `createAiRuntimeHarness` (over `FakeAiProvider` registered as `openai` and
// in-memory key/model/run tables) are substituted into the Nest container, so
// an HTTP request exercises the real controller, the real guards
// (`AiEnabledGuard`, JWT, `ai:use`), the real gate pipeline and the real
// run state machine — and "the key never left" is checked against the fake's
// own recorded calls.
//
// The app LISTENS on an ephemeral port (not just `inject`), because the
// disconnect test needs a real socket it can close mid-stream.
// =============================================================================

import type { AddressInfo } from 'node:net';

import { AiConfigService, type AiPolicy } from '../../src/ai/config/ai-config.service';
import { AiService } from '../../src/ai/runtime/ai.service';
import { AiRunsService } from '../../src/ai/runtime/ai-runs.service';
import { AiOutputWriter } from '../../src/ai/storage/ai-output-writer';
import { AiStorageInputResolver } from '../../src/ai/storage/ai-storage-input.resolver';
import {
  createAiRuntimeHarness,
  HARNESS_OTHER_USER,
  HARNESS_ORG_KEY,
  HARNESS_USER_KEY,
  type AiRuntimeHarness,
  type AiRuntimeHarnessOptions,
} from '../../src/ai/testing/ai-runtime-harness';
import type { FakeAiScript } from '../../src/ai/testing/fake-ai-provider';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

export const OTHER_USER_KEY = 'sk-other-user-key-never-leak-4242';
/** Every key a response or frame must never contain. */
export const ALL_KEYS = [HARNESS_USER_KEY, HARNESS_ORG_KEY, OTHER_USER_KEY];

export interface AiHttpTestApp {
  context: TestContext;
  harness: AiRuntimeHarness;
  baseUrl: string;
  /** Replace the fake provider's script for the next calls. */
  script(next: FakeAiScript | undefined): void;
  /** Delay (ms) the fake waits before each streamed event. */
  setDelay(ms: number): void;
  /** Restore a clean runtime between tests. */
  reset(): void;
  close(): Promise<void>;
}

const BASE_POLICY: Pick<AiPolicy, 'enabled' | 'keyPolicy' | 'logPromptContent' | 'limits'> & {
  defaults: AiPolicy['defaults'];
} = {
  enabled: true,
  keyPolicy: 'byok',
  logPromptContent: false,
  defaults: { allowBackgroundRuns: true, allowRealtime: false },
  // #450: no rate limits unless a test sets them.
  limits: {},
};

export async function createAiHttpTestApp(opts: AiRuntimeHarnessOptions = {}): Promise<AiHttpTestApp> {
  let current: FakeAiScript | undefined;

  const harness = createAiRuntimeHarness({
    ...opts,
    fake: {
      ...opts.fake,
      // Indirection, so each test can script the fake without a new app.
      responses: (req, ctx) => {
        if (typeof current === 'function') return current(req, ctx);
        if (Array.isArray(current)) {
          const next = current.shift();
          if (!next) throw new Error('script exhausted');
          return next;
        }
        return { outputText: `fake: ${typeof req.input === 'string' ? req.input : 'items'}` };
      },
    },
  });

  const context = await createTestApp({
    useMockDatabase: true,
    overrideProviders: [
      { provide: AiService, useValue: harness.ai },
      { provide: AiRunsService, useValue: harness.runs },
      { provide: AiConfigService, useValue: harness.aiConfig },
      // #437: the harness's in-memory object storage, so the image routes and
      // the `ai.image.generate` handler read and write the same objects.
      { provide: AiStorageInputResolver, useValue: harness.inputs },
      { provide: AiOutputWriter, useValue: harness.outputs },
    ],
  });

  await context.app.listen(0, '127.0.0.1');
  const { port } = context.app.getHttpServer().address() as AddressInfo;

  const fakeOptions = (harness.fake as unknown as { options: { delayMs?: number } }).options;

  return {
    context,
    harness,
    baseUrl: `http://127.0.0.1:${port}`,
    script(next) {
      current = next;
    },
    setDelay(ms) {
      fakeOptions.delayMs = ms;
    },
    reset() {
      resetPrismaMock();
      setupBaseMocks();
      current = undefined;
      fakeOptions.delayMs = 0;
      harness.fake.reset();
      harness.usageEvents.length = 0;
      harness.runRows.length = 0;
      harness.enqueued.length = 0;
      harness.storage.reset();
      harness.setOrgKey(null);
      harness.removeUserKeys(HARNESS_OTHER_USER);
      harness.setPolicy({ ...BASE_POLICY, defaults: { ...BASE_POLICY.defaults }, limits: {} });
    },
    close: () => closeTestApp(context),
  };
}

/** One parsed SSE frame. Comment lines (`: ping`) are kept as `{ comment }`. */
export interface ParsedFrame {
  event?: string;
  data?: any;
  comment?: string;
}

/** Parses a complete `text/event-stream` body. */
export function parseSse(body: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];

  for (const block of body.split('\n\n')) {
    if (!block.trim()) continue;

    const frame: ParsedFrame = {};
    const data: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) frame.comment = line.slice(1).trim();
      else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }

    if (data.length > 0) frame.data = JSON.parse(data.join('\n'));
    frames.push(frame);
  }

  return frames;
}
