// =============================================================================
// Framework telemetry is off: the training graphs make no outbound request
// =============================================================================
//
// `@langchain/core` depends on `langsmith`, whose tracer posts every run
// (prompts and outputs included) to a LangChain-hosted endpoint whenever a
// tracing variable reads "true". This deployment never traces to LangSmith, so
// `disableFrameworkTelemetry` forces the switches off in code. This suite sets
// every switch on, with a dummy key, AFTER the module is loaded, spies on every
// outbound path (global `fetch`, `http`/`https` `request` and `get`), runs the
// create graph with nodes that call the (fake) model, and the evaluate graph
// through an interrupt and its resume, and asserts nothing left the process.
//
// A positive control proves the spies would have seen a request.
// =============================================================================

import http from 'node:http';
import https from 'node:https';

import {
  FORCED_OFF_FLAGS,
  REMOVED_VARIABLES,
  disableFrameworkTelemetry,
} from '../../src/training-agents/disable-framework-telemetry';
import { GraphRuntimeInfo } from '../../src/training-agents/graph-runtime-info';
import { createNodeContextHarness } from '../../src/training-agents/testing/node-context-harness';
import { AGENT_NODES, agentScripts, agentsCalled } from './agent-graph-support';

const TRACING_ENV = {
  LANGSMITH_TRACING: 'true',
  LANGSMITH_TRACING_V2: 'true',
  LANGCHAIN_TRACING: 'true',
  LANGCHAIN_TRACING_V2: 'true',
  LANGSMITH_OTEL_ENABLED: 'true',
  LANGCHAIN_CALLBACKS_BACKGROUND: 'true',
  LANGSMITH_API_KEY: 'ls-dummy-key',
  LANGCHAIN_API_KEY: 'ls-dummy-key',
  LANGSMITH_ENDPOINT: 'https://api.smith.langchain.com',
} as const;

describe('framework telemetry is forced off for the training graphs', () => {
  const saved: Record<string, string | undefined> = {};
  const outbound: string[] = [];
  const spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    for (const name of Object.keys(TRACING_ENV)) saved[name] = process.env[name];
    outbound.length = 0;

    const record = (kind: string) =>
      jest.fn((target: unknown) => {
        outbound.push(`${kind} ${typeof target === 'string' ? target : JSON.stringify(target)}`);
        throw new Error(`blocked outbound ${kind}`);
      });

    spies.push(
      jest.spyOn(globalThis, 'fetch').mockImplementation(((target: unknown) => {
        try {
          return record('fetch')(target);
        } catch (error) {
          return Promise.reject(error);
        }
      }) as never),
      jest.spyOn(http, 'request').mockImplementation(record('http.request') as never),
      jest.spyOn(http, 'get').mockImplementation(record('http.get') as never),
      jest.spyOn(https, 'request').mockImplementation(record('https.request') as never),
      jest.spyOn(https, 'get').mockImplementation(record('https.get') as never),
    );
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('the spies see a request when one is made (positive control)', async () => {
    await expect(fetch('https://api.smith.langchain.com/runs')).rejects.toThrow(/blocked outbound/);
    expect(() => https.request('https://api.smith.langchain.com/runs')).toThrow(/blocked outbound/);
    expect(() => http.get('http://example.invalid/')).toThrow(/blocked outbound/);

    expect(outbound).toEqual([
      'fetch https://api.smith.langchain.com/runs',
      'https.request https://api.smith.langchain.com/runs',
      'http.get http://example.invalid/',
    ]);
  });

  it('runs the create graph with model calls, and the evaluate graph through an interrupt and resume, sending nothing', async () => {
    Object.assign(process.env, TRACING_ENV);

    const create = createNodeContextHarness({ kind: 'create', scripts: agentScripts({ rejections: 1 }) });
    const created = await create.runGraph({ input: {}, nodes: AGENT_NODES });

    expect(created.state.outcome?.status).toBe('completed');
    expect(agentsCalled(create.runtime.fake.calls)).toEqual(['researcher', 'planner', 'critic', 'planner', 'critic']);

    // Building the graph re-applied the pin: whatever was set is off again.
    for (const flag of FORCED_OFF_FLAGS) expect(process.env[flag]).toBe('false');
    for (const name of REMOVED_VARIABLES) expect(process.env[name]).toBeUndefined();

    Object.assign(process.env, TRACING_ENV);
    const evaluate = createNodeContextHarness({ kind: 'evaluate', scripts: agentScripts() });
    const paused = await evaluate.runGraph({ input: { input: { autonomy: 'ask_first' } }, nodes: AGENT_NODES });
    expect(paused.interrupt?.kind).toBe('approval');

    // Tracing is switched on again mid-run; the resumed graph re-pins it.
    Object.assign(process.env, TRACING_ENV);
    const resumed = await evaluate.runGraph({ resume: { decision: 'approve' }, nodes: AGENT_NODES });
    expect(resumed.state.outcome).toMatchObject({ status: 'completed' });

    // Let anything a tracer queued in the background reach the network.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(outbound).toEqual([]);
    for (const flag of FORCED_OFF_FLAGS) expect(process.env[flag]).toBe('false');
    expect(process.env.LANGCHAIN_CALLBACKS_BACKGROUND).toBe('false');
  });

  it('GraphRuntimeInfo forces the flags off at boot', () => {
    Object.assign(process.env, TRACING_ENV);

    new GraphRuntimeInfo().onModuleInit();

    expect(process.env.LANGSMITH_TRACING).toBe('false');
    expect(process.env.LANGCHAIN_TRACING_V2).toBe('false');
    expect(process.env.LANGSMITH_API_KEY).toBeUndefined();
    expect(process.env.LANGSMITH_ENDPOINT).toBeUndefined();
  });

  it('disableFrameworkTelemetry is idempotent and leaves unrelated variables alone', () => {
    const env: NodeJS.ProcessEnv = { ...TRACING_ENV, UNRELATED: 'keep' };

    disableFrameworkTelemetry(env);
    const once = { ...env };
    disableFrameworkTelemetry(env);

    expect(env).toEqual(once);
    expect(env.UNRELATED).toBe('keep');
  });
});
