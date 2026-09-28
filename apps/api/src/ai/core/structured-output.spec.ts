import { z } from 'zod';

import { AiError } from './ai-error';
import { parseStructured, toJsonSchema } from './structured-output';

const Answer = z.object({
  answer: z.string().describe('The answer'),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.enum(['a', 'b'])),
  note: z.string().nullable(),
});

function catchAiError(fn: () => unknown): AiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return err as AiError;
  }
  throw new Error('expected an AiError');
}

describe('toJsonSchema', () => {
  it('produces a closed object schema with every key required and no $schema marker', () => {
    const json = toJsonSchema(Answer);

    expect(json.$schema).toBeUndefined();
    expect(json).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['answer', 'confidence', 'tags', 'note'],
      properties: {
        answer: { type: 'string', description: 'The answer' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    });
  });

  it('closes nested objects too', () => {
    const json = toJsonSchema(z.object({ inner: z.object({ x: z.number() }) }));

    expect((json.properties as Record<string, Record<string, unknown>>).inner.additionalProperties).toBe(false);
  });

  it('surfaces an unrepresentable schema as AI_INVALID_REQUEST', () => {
    const err = catchAiError(() => toJsonSchema(z.object({ when: z.date() })));

    expect(err.code).toBe('AI_INVALID_REQUEST');
  });
});

describe('parseStructured', () => {
  it('returns typed, validated data', () => {
    const parsed = parseStructured(
      Answer,
      JSON.stringify({ answer: '42', confidence: 0.9, tags: ['a'], note: null }),
    );

    expect(parsed).toEqual({ answer: '42', confidence: 0.9, tags: ['a'], note: null });
  });

  it('applies the schema (e.g. strips unknown keys)', () => {
    const parsed = parseStructured(z.object({ a: z.number() }), '{"a":1,"extra":true}');

    expect(parsed).toEqual({ a: 1 });
  });

  it('throws AI_STRUCTURED_OUTPUT_INVALID for non-JSON text, without echoing it', () => {
    const text = 'Sure! Here is your answer: SECRET-USER-CONTENT';
    const err = catchAiError(() => parseStructured(Answer, text));

    expect(err.code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
    expect(err.getStatus()).toBe(502);
    expect(err.toJSON().details.issues).toEqual([
      expect.objectContaining({ path: [], code: 'invalid_json' }),
    ]);
    expect(JSON.stringify(err)).not.toContain('SECRET-USER-CONTENT');
  });

  it('throws AI_STRUCTURED_OUTPUT_INVALID with the Zod issues for a schema mismatch', () => {
    const err = catchAiError(() =>
      parseStructured(Answer, JSON.stringify({ answer: 1, confidence: 2, tags: ['z'], note: null })),
    );

    expect(err.code).toBe('AI_STRUCTURED_OUTPUT_INVALID');

    const issues = err.toJSON().details.issues as Array<{ path: unknown[]; code: string }>;
    const paths = issues.map((issue) => issue.path.join('.'));

    expect(paths).toEqual(expect.arrayContaining(['answer', 'confidence', 'tags.0']));
    expect(issues.every((issue) => typeof issue.code === 'string')).toBe(true);
  });
});
