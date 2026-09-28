// =============================================================================
// AiModule boot (issue #424, epic #419)
// =============================================================================
//
// The AI platform must boot inside the full application, and its core on its
// own with NO database at all — every later AI story (catalog, config, keys)
// layers onto this and must not find a hidden dependency underneath.
// Registering a provider needs no database or network either: since #426 the
// OpenAI adapter self-registers at boot (enabling it and giving it a key is
// runtime configuration, not wiring).
//
// "On its own" targets `AiCoreModule`, not `AiModule`: since #427 `AiModule`
// also imports the catalog, which legitimately needs the database. The claim
// being pinned is about the provider-agnostic core, and that is unchanged —
// provider adapters are checked alongside it, since they must not need the
// database either.
// =============================================================================

import { Test } from '@nestjs/testing';

import { AiModule } from '../../src/ai/ai.module';
import { AiProviderRegistry } from '../../src/ai/core';
import { AiCoreModule } from '../../src/ai/core/ai-core.module';
import { OpenAiProviderModule } from '../../src/ai/providers/openai/openai.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, TestContext } from '../helpers/test-app.helper';

describe('AiModule', () => {
  describe('inside createTestApp()', () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestApp();
    });

    afterAll(async () => {
      await ctx?.app.close();
    });

    it('boots with the built-in providers registered', () => {
      const registry = ctx.app.get(AiProviderRegistry);

      expect(registry).toBeInstanceOf(AiProviderRegistry);
      expect(registry.ids()).toEqual(['openai', 'anthropic', 'gemini', 'azure-openai', 'openai-compatible']);
      // Anthropic and Gemini store no responses, so they declare they cannot chain (#446, #447);
      // the two OpenAI-family adapters declare the same, conservatively, for both API styles (#448).
      expect(registry.supportsPreviousResponseId('openai')).toBe(true);
      expect(registry.supportsPreviousResponseId('anthropic')).toBe(false);
      expect(registry.supportsPreviousResponseId('gemini')).toBe(false);
      expect(registry.supportsPreviousResponseId('azure-openai')).toBe(false);
      expect(registry.supportsPreviousResponseId('openai-compatible')).toBe(false);
    });
  });

  describe('AiCoreModule + provider adapters on their own', () => {
    it('compiles with no PrismaService anywhere in the graph', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AiCoreModule, OpenAiProviderModule],
      }).compile();
      await moduleRef.init();

      expect(moduleRef.get(AiProviderRegistry).ids()).toEqual(['openai']);
      expect(() => moduleRef.get(PrismaService, { strict: false })).toThrow();

      await moduleRef.close();
    });
  });
});
