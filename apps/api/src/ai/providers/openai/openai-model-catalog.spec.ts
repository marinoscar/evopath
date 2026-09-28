import { AiCapability, aiModelCapabilitiesSchema } from '../../core/capabilities';
import { classifyOpenAiModel, OPENAI_CLASSIFIER_RULES } from './openai-model-catalog';

const REASONING: AiCapability[] = [
  'responses',
  'reasoning',
  'tools',
  'hosted_tools',
  'structured_output',
  'streaming',
  'vision_input',
  'file_input',
];
const CHAT: AiCapability[] = ['responses', 'tools', 'hosted_tools', 'structured_output', 'streaming', 'vision_input', 'file_input'];

describe('classifyOpenAiModel', () => {
  // ~20 real ids (snapshots included) -> the capability set expected.
  const table: Array<[string, AiCapability[]]> = [
    ['gpt-5', REASONING],
    ['gpt-5-mini', REASONING],
    ['gpt-5-nano-2025-08-07', REASONING],
    ['gpt-5.1', REASONING],
    ['gpt-5-codex', REASONING],
    ['gpt-5-chat-latest', CHAT],
    ['o3', REASONING],
    ['o4-mini-2025-04-16', REASONING],
    ['o1-pro', REASONING],
    ['o3-mini', ['responses', 'reasoning', 'tools', 'structured_output', 'streaming']],
    ['gpt-4.1', CHAT],
    ['gpt-4.1-mini-2025-04-14', CHAT],
    ['gpt-4o', CHAT],
    ['gpt-4o-mini-2024-07-18', CHAT],
    ['gpt-4-turbo', ['responses', 'tools', 'streaming', 'vision_input']],
    ['gpt-4', ['responses', 'tools', 'streaming']],
    ['gpt-3.5-turbo-0125', ['responses', 'tools', 'streaming']],
    ['gpt-image-1', ['image_generation', 'image_edit']],
    ['dall-e-2', ['image_generation', 'image_edit']],
    ['dall-e-3', ['image_generation']],
    ['gpt-4o-transcribe', ['audio_transcription']],
    ['whisper-1', ['audio_transcription']],
    ['gpt-4o-mini-tts', ['audio_speech']],
    ['tts-1-hd', ['audio_speech']],
    ['text-embedding-3-small', ['embeddings']],
    ['gpt-4o-realtime-preview-2024-12-17', ['realtime']],
    ['gpt-realtime', ['realtime']],
  ];

  it.each(table)('%s', (id, expected) => {
    const caps = classifyOpenAiModel(id);

    expect(caps).not.toBeNull();
    expect(aiModelCapabilitiesSchema.safeParse(caps).success).toBe(true);
    expect([...(caps?.capabilities ?? [])].sort()).toEqual([...expected].sort());
  });

  it.each([
    'davinci-002',
    'babbage-002',
    'omni-moderation-latest',
    'gpt-4o-audio-preview',
    'gpt-4o-mini-search-preview',
    'computer-use-preview',
    'gpt-3.5-turbo-instruct',
    'llama-3-70b',
    'some-future-model',
    '',
  ])('%s is unclassified (null)', (id) => {
    expect(classifyOpenAiModel(id)).toBeNull();
  });

  it('declares reasoning efforts only for reasoning models', () => {
    expect(classifyOpenAiModel('gpt-5')?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(classifyOpenAiModel('o3')?.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(classifyOpenAiModel('gpt-4o')?.reasoningEfforts).toBeUndefined();
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(classifyOpenAiModel('  GPT-4o ')).toEqual(classifyOpenAiModel('gpt-4o'));
  });

  it('returns a copy the caller may mutate without corrupting the table', () => {
    const first = classifyOpenAiModel('gpt-4o');

    first?.capabilities.push('realtime');

    expect(classifyOpenAiModel('gpt-4o')?.capabilities).not.toContain('realtime');
  });

  it('every non-null rule is schema-valid', () => {
    for (const rule of OPENAI_CLASSIFIER_RULES) {
      if (rule.capabilities) {
        expect(aiModelCapabilitiesSchema.safeParse(rule.capabilities).success).toBe(true);
      }
    }
  });

  it('accepts a custom rule list (first match wins)', () => {
    const rules = [
      { match: /^x-/, capabilities: null },
      { match: /^x-model/, capabilities: { capabilities: ['responses' as const], inputModalities: ['text' as const], outputModalities: ['text' as const] } },
    ];

    expect(classifyOpenAiModel('x-model', rules)).toBeNull();
  });
});
