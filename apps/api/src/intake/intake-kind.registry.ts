import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import type { IntakeKind } from './intake-kind.interface';
import { INTAKE_INPUT_KINDS } from './intake-inputs';

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
    // #173: an analyzer's model is the administrator's assignment for a
    // feature, so a kind that analyzes must name that feature.
    if (kind.analyzeJobType && !kind.aiFeature) {
      throw new Error(`Intake kind "${kind.kind}" has an analyzer but no \`aiFeature\``);
    }

    assertAcceptedInputs(kind);

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

/** H2 (#186): `acceptedInputs` and `maxPdfPages` are declarations a typo must not weaken. */
function assertAcceptedInputs(kind: IntakeKind<any, any>): void {
  const accepted = kind.acceptedInputs;

  if (accepted !== undefined) {
    if (accepted.length === 0) {
      throw new Error(`Intake kind "${kind.kind}" declares no \`acceptedInputs\`; omit it for images only`);
    }

    for (const input of accepted) {
      if (!(INTAKE_INPUT_KINDS as readonly string[]).includes(input)) {
        throw new Error(
          `Intake kind "${kind.kind}" accepts unknown input "${input}"; expected one of ${INTAKE_INPUT_KINDS.join(', ')}`,
        );
      }
    }

    if (new Set(accepted).size !== accepted.length) {
      throw new Error(`Intake kind "${kind.kind}" lists an input twice in \`acceptedInputs\``);
    }
  }

  if (kind.maxPdfPages !== undefined && (!Number.isInteger(kind.maxPdfPages) || kind.maxPdfPages < 1)) {
    throw new Error(`Intake kind "${kind.kind}" has an invalid \`maxPdfPages\` (a positive integer)`);
  }
}
