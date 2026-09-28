import { CanActivate, Injectable } from '@nestjs/common';

import { AiConfigService } from './ai-config.service';

// =============================================================================
// AiEnabledGuard — the kill switch at the HTTP edge (issue #428, epic #419)
// =============================================================================
//
// Applied at CONTROLLER level, with `@UseGuards(AiEnabledGuard)`, on every
// user-facing AI controller under `/api/ai/*` (#431, #433). When `ai.enabled`
// is false it answers `403` with `details.reason: 'AI_DISABLED'` — the
// envelope's top-level `code` is the status-derived `FORBIDDEN`, as for every
// `AiError` (see `ai-error.ts`).
//
// DELIBERATELY NOT APPLIED to:
//   - `/api/admin/ai/*` — an administrator must always be able to turn the
//     platform back on (docs/specs/ai-platform.md §2.19);
//   - `GET /api/ai/config` — it is how a browser LEARNS that AI is off, so it
//     must stay reachable while AI is off.
//
// Order relative to `@Auth()`: put `@UseGuards(AiEnabledGuard)` on the class
// and `@Auth(...)` on the methods, and Nest runs the class guard first. That
// is intentional: "AI is off" is not a secret, and answering it before the
// permission check means a caller without `ai:use` is told the same thing a
// caller with it is.
// =============================================================================

@Injectable()
export class AiEnabledGuard implements CanActivate {
  constructor(private readonly aiConfig: AiConfigService) {}

  async canActivate(): Promise<boolean> {
    await this.aiConfig.assertEnabled();

    return true;
  }
}
