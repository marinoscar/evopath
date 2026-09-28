// Public surface of the AI runtime facade (issue #432, epic #419).
// Feature code imports from here (or from `ai/core` for the neutral types).
export { AiRuntimeModule } from './ai-runtime.module';
export { AiService } from './ai.service';
export type { AiUserClient } from './ai.service';
export * from './ai-runtime.types';
export {
  AiRunsService,
  AI_RESPONSE_RUN_TYPE,
  AI_IMAGE_GENERATE_TYPE,
  AI_AUDIO_TRANSCRIBE_TYPE,
  AI_AUDIO_SPEECH_TYPE,
  AI_RUN_SUBJECT_TYPE,
} from './ai-runs.service';
