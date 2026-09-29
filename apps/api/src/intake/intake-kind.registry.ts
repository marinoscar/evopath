import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import type { IntakeKind } from './intake-kind.interface';

// =============================================================================
// IntakeKindRegistry — the registered photo-intake kinds (E3.1)
// =============================================================================
//
// Same idiom as `JobHandlerRegistry`: a kind registers itself in its own
// `onModuleInit`, a duplicate registration replaces the earlier one with a
// warning (the last one wins), and nothing else lists kinds by hand.
// =============================================================================

@Injectable()
export class IntakeKindRegistry {
  private readonly logger = new Logger(IntakeKindRegistry.name);

  private readonly kinds = new Map<string, IntakeKind<any, any>>();

  register(kind: IntakeKind<any, any>): void {
    const existing = this.kinds.get(kind.kind);

    if (existing) {
      this.logger.warn(
        `Duplicate intake kind "${kind.kind}": ${existing.constructor.name} is being replaced by ` +
          `${kind.constructor.name}. The last registration wins.`,
      );
    }

    this.kinds.set(kind.kind, kind);
  }

  get(kind: string): IntakeKind<any, any> | undefined {
    return this.kinds.get(kind);
  }

  /** The kind, or a 400 with `details.reason: 'UNKNOWN_INTAKE_KIND'`. */
  require(kind: string): IntakeKind<any, any> {
    const found = this.kinds.get(kind);

    if (!found) {
      throw new BadRequestException({
        message: `Unknown intake kind "${kind}"`,
        details: { reason: 'UNKNOWN_INTAKE_KIND', kind },
      });
    }

    return found;
  }

  list(): string[] {
    return [...this.kinds.keys()];
  }
}
