// Imported first so the telemetry pin runs before LangGraph (and, through it,
// `@langchain/core` and `langsmith`) is loaded.
import { disableFrameworkTelemetry } from './disable-framework-telemetry';

import { readFileSync } from 'node:fs';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { StateGraph } from '@langchain/langgraph';

/** The version of a package, read from that package's own `package.json`. */
export function installedPackageVersion(packageName: string): string {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };

  if (typeof manifest.version !== 'string') {
    throw new Error(`${packageName}/package.json has no version`);
  }

  return manifest.version;
}

/**
 * Loads the orchestration runtime at boot and logs its version.
 *
 * Its job is to make the production build `require()` `@langchain/langgraph`
 * while the application starts: a CommonJS/ESM mismatch in the installed
 * package then fails the container start, not the first training run. It also
 * re-applies the telemetry pin (`disableFrameworkTelemetry`) at boot.
 */
@Injectable()
export class GraphRuntimeInfo implements OnModuleInit {
  private readonly logger = new Logger(GraphRuntimeInfo.name);

  readonly langgraphVersion = installedPackageVersion('@langchain/langgraph');
  readonly coreVersion = installedPackageVersion('@langchain/core');

  onModuleInit(): void {
    disableFrameworkTelemetry();

    if (typeof StateGraph !== 'function') {
      throw new Error('@langchain/langgraph loaded without StateGraph');
    }

    this.logger.log(
      `LangGraph runtime loaded: @langchain/langgraph ${this.langgraphVersion}, ` +
        `@langchain/core ${this.coreVersion}; framework telemetry forced off`,
    );
  }
}
