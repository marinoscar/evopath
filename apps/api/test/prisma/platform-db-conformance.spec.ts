// =============================================================================
// The platform-db conformance suite, run against EvoPath
// (marinoscar/EnterpriseAppBase#747)
// =============================================================================
//
// Offline: no database. It proves two things an app owes the package:
//   - the raw-SQL index tripwire: every partial or expression index in the
//     platform's migrations is listed in RAW_SQL_INDEXES, none is redeclared
//     with @@unique/@@index in the schema (CLAUDE.md "intentional schema
//     drift"), and
//   - platform.lock: the migrations mapped under prisma/migrations are
//     byte-identical to the package's (or a recorded comment-only divergence),
//     none missing, none edited, none renamed.
//
// The EvoPath-specific facts (the 22 mappings, the renamed id, the comment-only
// entry, the declared deviation) are in platform-lock.spec.ts.
// =============================================================================

import { join } from 'node:path';

import { runDbConformance } from '@marinoscar/platform-db';

runDbConformance({ appRoot: join(__dirname, '..', '..') });
