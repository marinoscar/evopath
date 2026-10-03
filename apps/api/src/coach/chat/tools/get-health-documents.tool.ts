import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { fromDbDate } from '../../../check-ins/local-date';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { dropNulls, userText } from './user-context';

const CONSENT_OFF = {
  error: 'consent_off',
  message:
    'The user\'s "Use my health data in training plans and coach chat" setting is off, so health records are not ' +
    'shared with you.',
} as const;

/**
 * `get_health_documents` (#338): the caller's health records (lab reports
 * and body-metric documents): kind, the file's name, its date, type and
 * size, whether the file is kept, and when it was added. Behind the user's
 * own health-data switch (`HealthSummaryReader.consentOn`), like every lab
 * read of the chat. Never the file itself, its storage object or a URL: the
 * values read from a lab report are in `get_measurements` / the biomarker tools.
 */
export function createGetHealthDocumentsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_health_documents',
    description:
      "The user's uploaded health records (lab reports, body-metric documents), newest first: kind, file name, " +
      'document date, file type and size, whether the file is still kept, and when it was added. The values in them ' +
      'are in get_measurements (category lab) and list_biomarkers. Answers consent_off while the user\'s health-data ' +
      'setting is off.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        if (!deps.healthSummary) return TOOL_UNAVAILABLE;
        if (!(await deps.healthSummary.consentOn(ctx.userId))) return CONSENT_OFF;
        const rows = await deps.prisma.healthDocument.findMany({
          where: { userId: ctx.userId },
          orderBy: [{ createdAt: 'desc' }],
          select: {
            kind: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            retention: true,
            documentDate: true,
            fileDeletedAt: true,
            createdAt: true,
          },
        });
        return {
          count: rows.length,
          documents: rows.map((row) =>
            dropNulls({
              kind: row.kind,
              fileName: userText(row.originalName, 200),
              documentDate: row.documentDate ? fromDbDate(row.documentDate) : null,
              fileType: row.mimeType,
              sizeKb: Math.round(Number(row.sizeBytes) / 1024),
              fileKept: row.fileDeletedAt === null,
              retention: row.retention,
              addedOn: row.createdAt.toISOString().slice(0, 10),
            }),
          ),
        };
      }, TOOL_UNAVAILABLE),
  });
}
