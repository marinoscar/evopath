import { Injectable, Logger } from '@nestjs/common';

// =============================================================================
// StorageObjectReferences — who else still uses an intake's photo
// =============================================================================
//
// An intake's photos are ordinary storage objects, and a feature may keep
// using one after (or while) an intake links it: "Scan gym" turns every
// intake photo into a gym photo on apply, and a user may attach an object to
// an intake that is already a photo of something else. When an intake is
// discarded or a photo detached, `IntakeService` deletes each object NO ONE
// references any more; a cascade from that delete would otherwise remove the
// other feature's row (data loss).
//
// The intake module is kind-agnostic and imports no feature, so consumers
// register a checker here in their own `onModuleInit` (the idiom of
// `IntakeKindRegistry`). A checker answers for its own tables only; the object
// is kept when ANY checker says it is referenced, or when a checker fails
// (keeping an object is the safe side of a best-effort cleanup).
// =============================================================================

export interface StorageObjectReferenceChecker {
  /** Short name for logs, e.g. `'gym_photos'`. */
  readonly name: string;
  /** Whether this consumer still references the object. */
  isReferenced(storageObjectId: string): Promise<boolean>;
}

@Injectable()
export class StorageObjectReferences {
  private readonly logger = new Logger(StorageObjectReferences.name);

  private readonly checkers = new Map<string, StorageObjectReferenceChecker>();

  /** Registers (or replaces, by name) a checker. */
  register(checker: StorageObjectReferenceChecker): void {
    this.checkers.set(checker.name, checker);
  }

  list(): string[] {
    return [...this.checkers.keys()];
  }

  /** True when any registered consumer references the object, or a checker could not tell. */
  async isReferenced(storageObjectId: string): Promise<boolean> {
    for (const checker of this.checkers.values()) {
      try {
        if (await checker.isReferenced(storageObjectId)) return true;
      } catch (error) {
        this.logger.warn(
          `Reference check "${checker.name}" failed for storage object ${storageObjectId}; keeping it: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        return true;
      }
    }

    return false;
  }
}
