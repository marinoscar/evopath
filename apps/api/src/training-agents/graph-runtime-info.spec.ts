import { disableFrameworkTelemetry } from './disable-framework-telemetry';
import { GraphRuntimeInfo, installedPackageVersion } from './graph-runtime-info';

describe('GraphRuntimeInfo', () => {
  it('reads the installed langgraph and core versions from their package.json', () => {
    const info = new GraphRuntimeInfo();

    expect(info.langgraphVersion).toMatch(/^1\.\d+\.\d+$/);
    expect(info.coreVersion).toMatch(/^1\.\d+\.\d+$/);
    expect(installedPackageVersion('@langchain/langgraph')).toBe(info.langgraphVersion);
  });

  it('forces framework tracing off and drops LangSmith credentials, whatever the environment says', () => {
    const env: NodeJS.ProcessEnv = {
      LANGSMITH_TRACING: 'true',
      LANGCHAIN_TRACING_V2: 'true',
      LANGSMITH_API_KEY: 'ls-dummy',
      LANGCHAIN_CALLBACKS_BACKGROUND: 'true',
    };

    disableFrameworkTelemetry(env);

    expect(env).toMatchObject({
      LANGSMITH_TRACING: 'false',
      LANGSMITH_TRACING_V2: 'false',
      LANGCHAIN_TRACING: 'false',
      LANGCHAIN_TRACING_V2: 'false',
      LANGCHAIN_CALLBACKS_BACKGROUND: 'false',
    });
    expect(env.LANGSMITH_API_KEY).toBeUndefined();
  });

  it('re-applies the pin on module init', () => {
    process.env.LANGSMITH_TRACING = 'true';

    new GraphRuntimeInfo().onModuleInit();

    expect(process.env.LANGSMITH_TRACING).toBe('false');
  });
});
