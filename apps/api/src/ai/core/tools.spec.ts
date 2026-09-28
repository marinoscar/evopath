import { z } from 'zod';

import { defineTool, isFunctionTool } from './tools';

const weather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: z.object({ city: z.string().min(1), unit: z.enum(['c', 'f']) }),
  execute: ({ city, unit }, ctx) => ({ city, unit, temperature: 21, userId: ctx.userId }),
});

describe('defineTool', () => {
  it('produces a function tool that keeps the Zod schema', () => {
    expect(weather.tool).toMatchObject({
      type: 'function',
      name: 'get_weather',
      description: 'Current weather for a city',
      strict: true,
    });
    expect(weather.tool.parameters.safeParse({ city: 'Paris', unit: 'c' }).success).toBe(true);
    expect(isFunctionTool(weather.tool)).toBe(true);
    expect(isFunctionTool({ type: 'web_search' })).toBe(false);
  });

  it('honours an explicit strict: false', () => {
    const loose = defineTool({
      name: 'loose',
      description: 'x',
      parameters: z.object({}),
      strict: false,
      execute: () => null,
    });

    expect(loose.tool.strict).toBe(false);
  });

  it('execute() is always async and receives the context', async () => {
    const result = weather.execute({ city: 'Paris', unit: 'c' }, { userId: 'u1' });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ city: 'Paris', unit: 'c', temperature: 21, userId: 'u1' });
  });

  describe('parseArguments', () => {
    it('parses valid JSON arguments', () => {
      expect(weather.parseArguments('{"city":"Oslo","unit":"f"}')).toEqual({
        success: true,
        data: { city: 'Oslo', unit: 'f' },
      });
    });

    it('treats an empty string as no arguments', () => {
      const noArgs = defineTool({
        name: 'now',
        description: 'x',
        parameters: z.object({}),
        execute: () => Date.now(),
      });

      expect(noArgs.parseArguments('')).toEqual({ success: true, data: {} });
    });

    it('returns (not throws) an error message for invalid JSON', () => {
      const result = weather.parseArguments('{city: Oslo');

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain('not valid JSON');
    });

    it('returns (not throws) the failing paths for a schema mismatch', () => {
      const result = weather.parseArguments('{"city":"","unit":"k"}');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('get_weather');
        expect(result.error).toContain('city');
        expect(result.error).toContain('unit');
      }
    });
  });

  it('rejects a provider-unsafe name at definition time', () => {
    expect(() =>
      defineTool({ name: 'get weather!', description: 'x', parameters: z.object({}), execute: () => 1 }),
    ).toThrow(TypeError);
  });

  it('rejects non-object parameters at definition time', () => {
    expect(() =>
      defineTool({ name: 'bad', description: 'x', parameters: z.string(), execute: () => 1 }),
    ).toThrow(/object schema/);
  });
});
