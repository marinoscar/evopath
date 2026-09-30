import { Module } from '@nestjs/common';

import { GraphRuntimeInfo } from './graph-runtime-info';

/**
 * Training agents: the orchestration layer above `AiService`.
 *
 * `@langchain/langgraph` and `@langchain/core` may be imported only under this
 * folder; every model call still goes through `AiService.forUser`. For now the
 * module provides only `GraphRuntimeInfo`, which loads the runtime at boot and
 * logs its version. The spike under `spike/` is deliberately NOT registered
 * here: it is constructed only inside specs.
 */
@Module({
  providers: [GraphRuntimeInfo],
  exports: [GraphRuntimeInfo],
})
export class TrainingAgentsModule {}
