import { AiError } from '../core/ai-error';
import { parseStructured, toJsonSchema } from '../core/structured-output';
import { toAiRequest } from './ai-http-request';
import { aiResponseRequestSchema } from './dto/ai-response-request.dto';
import { AI_JSON_SCHEMA_MAX_BYTES, fromJsonSchemaStructuredOutput } from './json-schema-structured-output';

const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};

function invalid(fn: () => unknown): AiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return err as AiError;
  }
  throw new Error('expected an AiError');
}

describe('fromJsonSchemaStructuredOutput', () => {
  it('builds a Zod schema that validates matching output', () => {
    const spec = fromJsonSchemaStructuredOutput({ name: 'answer', jsonSchema: ANSWER_SCHEMA, strict: true });

    expect(spec.name).toBe('answer');
    expect(spec.strict).toBe(true);
    expect(parseStructured(spec.schema, '{"answer":"42","confidence":0.9}')).toEqual({
      answer: '42',
      confidence: 0.9,
    });
  });

  it('rejects output that does not match the schema (502 AI_STRUCTURED_OUTPUT_INVALID)', () => {
    const spec = fromJsonSchemaStructuredOutput({ name: 'answer', jsonSchema: ANSWER_SCHEMA });

    const err = invalid(() => parseStructured(spec.schema, '{"answer":42}'));
    expect(err.code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
    expect(err.getStatus()).toBe(502);
  });

  it('round-trips to the JSON Schema the provider is sent', () => {
    const spec = fromJsonSchemaStructuredOutput({ name: 'answer', jsonSchema: ANSWER_SCHEMA });

    expect(toJsonSchema(spec.schema)).toMatchObject({
      type: 'object',
      properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
      required: ['answer', 'confidence'],
      additionalProperties: false,
    });
  });

  it('resolves local $refs', () => {
    const spec = fromJsonSchemaStructuredOutput({
      name: 'ref',
      jsonSchema: {
        type: 'object',
        properties: { item: { $ref: '#/$defs/item' } },
        required: ['item'],
        $defs: { item: { type: 'string' } },
      },
    });

    expect(parseStructured(spec.schema, '{"item":"x"}')).toEqual({ item: 'x' });
  });

  it('omits strict when the caller did not say', () => {
    expect(fromJsonSchemaStructuredOutput({ name: 'a', jsonSchema: ANSWER_SCHEMA })).not.toHaveProperty('strict');
  });

  it.each([
    ['an unknown type', { type: 'nonsense' }],
    ['an external $ref', { $ref: 'https://example.com/schema.json' }],
  ])('refuses %s with 400 AI_INVALID_REQUEST', (_label, jsonSchema) => {
    const err = invalid(() => fromJsonSchemaStructuredOutput({ name: 'bad', jsonSchema }));

    expect(err.code).toBe('AI_INVALID_REQUEST');
    expect(err.getStatus()).toBe(400);
    expect(err.toJSON().details).toMatchObject({ field: 'structuredOutput.jsonSchema' });
  });

  it('refuses a schema larger than the bound', () => {
    const big = { type: 'object', description: 'x'.repeat(AI_JSON_SCHEMA_MAX_BYTES) };

    expect(invalid(() => fromJsonSchemaStructuredOutput({ name: 'big', jsonSchema: big })).code).toBe(
      'AI_INVALID_REQUEST',
    );
  });
});

describe('aiResponseRequestSchema', () => {
  it('accepts the web Playground body', () => {
    const body = {
      provider: 'openai',
      model: 'gpt-mini',
      input: 'Hello',
      instructions: 'Be brief',
      reasoning: { effort: 'low', summary: 'auto' },
      structuredOutput: { name: 'answer', jsonSchema: ANSWER_SCHEMA, strict: true },
      maxOutputTokens: 256,
      temperature: 0.5,
      previousResponseId: 'resp_1',
    };

    expect(aiResponseRequestSchema.parse(body)).toEqual(body);
  });

  it('accepts media parts by storage object id (#441)', () => {
    expect(
      aiResponseRequestSchema.safeParse({
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: 'Summarise these.' },
              { type: 'image', storageObjectId: '11111111-1111-4111-8111-111111111111', detail: 'high' },
              { type: 'file', storageObjectId: '22222222-2222-4222-8222-222222222222', filename: 'contract.pdf' },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts typed input items with media by URL', () => {
    expect(
      aiResponseRequestSchema.safeParse({
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', url: 'https://example.com/a.png', detail: 'low' },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['function tools', { input: 'x', tools: [{ type: 'function', name: 'f' }] }],
    ['a stream flag', { input: 'x', stream: true }],
    ['an empty prompt', { input: '' }],
    ['no input', { model: 'm' }],
    ['a media part by a malformed storage object id', {
      input: [{ type: 'message', role: 'user', content: [{ type: 'image', storageObjectId: 'abc' }] }],
    }],
    ['a media part with both url and storageObjectId', {
      input: [{ type: 'message', role: 'user', content: [
        { type: 'file', url: 'https://example.com/a.pdf', storageObjectId: '11111111-1111-4111-8111-111111111111' },
      ] }],
    }],
    ['a media part with neither url nor storageObjectId', {
      input: [{ type: 'message', role: 'user', content: [{ type: 'image' }] }],
    }],
    ['a non-http media URL', {
      input: [{ type: 'message', role: 'user', content: [{ type: 'file', url: 'file:///etc/passwd' }] }],
    }],
    ['a bad schema name', { input: 'x', structuredOutput: { name: 'has space', jsonSchema: {} } }],
    ['a non-integer token cap', { input: 'x', maxOutputTokens: 1.5 }],
    ['an out-of-range temperature', { input: 'x', temperature: 3 }],
    ['an unknown reasoning effort', { input: 'x', reasoning: { effort: 'extreme' } }],
  ])('rejects %s', (_label, body) => {
    expect(aiResponseRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('toAiRequest', () => {
  it('copies named fields and converts structured output to Zod', () => {
    const request = toAiRequest(
      aiResponseRequestSchema.parse({
        model: 'm',
        input: 'hi',
        structuredOutput: { name: 'answer', jsonSchema: ANSWER_SCHEMA },
        metadata: { source: 'cli' },
      }),
    );

    expect(request).toMatchObject({ model: 'm', input: 'hi', metadata: { source: 'cli' } });
    expect(request.structuredOutput?.name).toBe('answer');
    expect(typeof request.structuredOutput?.schema.safeParse).toBe('function');
    expect(request).not.toHaveProperty('provider');
    expect(request).not.toHaveProperty('tools');
  });
});
