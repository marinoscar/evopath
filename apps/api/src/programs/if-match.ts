import { BadRequestException } from '@nestjs/common';

import { PROGRAM_REASONS } from './programs.constants';

/**
 * The program version an `If-Match` header names: an integer, bare (`4`) or
 * as the ETag `GET /api/programs/:id` returns (`"4"`, `W/"4"`). Program
 * content writes REQUIRE it, so a missing or unparseable value is a 400.
 */
export function requireIfMatchVersion(header: string | undefined): number {
  const value = header?.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1').trim();
  if (value && /^\d{1,9}$/.test(value)) {
    const version = Number(value);
    if (version >= 1) return version;
  }
  throw new BadRequestException({
    message: 'Send If-Match with the plan version you loaded (currentVersion).',
    details: { reason: PROGRAM_REASONS.IF_MATCH_REQUIRED },
  });
}

/** The ETag of a program at `version`. */
export function programEtag(version: number): string {
  return `"${version}"`;
}
