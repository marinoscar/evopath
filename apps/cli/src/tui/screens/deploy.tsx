import { installFields } from './deploy/install-model.js';

// =============================================================================
// Where the deploy screen used to be  (issue #406)
// =============================================================================
//
// The 509-line screen that lived here is now one component per command under
// `./deploy/`, over the pure models beside them. This file is the seam: it
// keeps `./screens/deploy.js` a working specifier so `app.tsx`'s route table
// and the existing test do not have to move in the same change as the split.
//
// It is deliberately a re-export and nothing else. A shim that re-implemented
// anything would be a second place for the screen's behaviour to live, which is
// the shape of the problem the split exists to remove.
// =============================================================================

export { DeployScreen, type DeployScreenProps } from './deploy/index.js';

/** The field shape the screens ask with. Its home is `./deploy/model.ts`. */
export type { FieldSpec } from './deploy/model.js';

/**
 * @deprecated Renamed to `installFields` and moved to `./deploy/install-model.ts`,
 * where it gained the `seed` parameter that makes a re-run keep the values
 * already on disk. Kept as an alias because the name is what
 * `deploy.test.ts` imports; call `installFields` in new code.
 */
export const fieldsForInstall = installFields;
