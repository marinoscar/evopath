// =============================================================================
// Render every email template to local HTML files for review (issue #237)
// =============================================================================
//
// Run with:  npx tsx apps/api/scripts/render-email-previews.ts <outDir>
//
// Writes, into <outDir>:
//   * <template>.html  — the HTML part, exactly as sent, except that each
//                        `cid:` reference is replaced by a `data:` URI of the
//                        matching inline attachment, so a browser (which has no
//                        MIME parts to resolve `cid:` against) shows the logo;
//   * <template>.txt   — the hand-written plain-text part, as sent;
//   * index.html       — links to all of the above, with each subject line.
//
// The sample data is fixed (a person named "Oscar Marin", fixed dates), so two
// runs produce identical files and a visual diff only shows real changes.
// `SAMPLES` is typed as a total map over the registry, so registering a new
// template without adding a sample here is a compile error.
//
// Pure rendering: no Nest, no database, no network. The templates are pure
// functions of their data, which is what makes this script possible at all.
// =============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  EMAIL_TEMPLATE_NAMES,
  renderEmailTemplate,
  type EmailTemplateDataMap,
  type EmailTemplateName,
  type RenderedEmail,
} from '../src/email/templates';

const APP_URL = 'https://app.example.com';

const SAMPLES: { [K in EmailTemplateName]: EmailTemplateDataMap[K] } = {
  'test-email': {
    recipientEmail: 'oscar@example.com',
    providerKind: 'ses',
    sentAt: new Date('2026-10-01T14:05:09.000Z'),
    triggeredBy: 'Oscar Marin',
    settingsUrl: `${APP_URL}/admin/settings/email`,
  },
  'user-welcome': {
    recipientEmail: 'oscar@example.com',
    recipientName: 'Oscar Marin',
    roles: ['contributor'],
    appUrl: APP_URL,
  },
  'allowlist-invitation': {
    recipientEmail: 'oscar@example.com',
    invitedBy: 'Dana Whitfield',
    signInUrl: `${APP_URL}/login`,
  },
  'role-changed': {
    recipientEmail: 'oscar@example.com',
    previousRoles: ['viewer'],
    currentRoles: ['admin', 'viewer'],
    changedAt: new Date('2026-10-01T09:42:17.000Z'),
    appUrl: APP_URL,
  },
  broadcast: {
    title: 'Planned maintenance this Saturday',
    body:
      'The application will be unavailable on Saturday 4 October from 22:00 to 23:30 UTC while we upgrade the database.\n\n' +
      'Anything you are working on is saved automatically. If a workout is in progress at 22:00, finish it afterwards and it will be kept.\n\n' +
      'Thank you for your patience.',
    ctaLabel: 'Read the status page',
    ctaUrl: 'https://status.example.com/incidents/42',
    link: '/announcements/42',
    critical: false,
  },
  'job-failed': {
    jobId: 'c7f1e2a4-9b3d-4f6e-8a21-5d0c9e7b3f18',
    jobType: 'health.export',
    error:
      'Upload to object storage failed: 403 AccessDenied (bucket example-exports, key exports/2026/10/01/oscar.zip)',
    attempts: 5,
    executor: 'node worker-eu-1',
    failedAt: new Date('2026-10-01T03:17:44.000Z'),
    appUrl: APP_URL,
  },
  'node-offline': {
    nodeId: '4e2b9c1d-77a0-4f3b-9d52-0b6f8a1c2e93',
    nodeName: 'worker-eu-1',
    lastHeartbeatAt: new Date('2026-10-01T02:58:12.000Z'),
    markedOfflineAt: new Date('2026-10-01T03:04:12.000Z'),
    staleAfterMinutes: 6,
    appUrl: APP_URL,
  },
  'backup-failed': {
    runId: 'b81d4f0e-2c6a-4e19-a3f7-6d5c8e9a0b12',
    outcome: 'failed',
    error: 'pg_dump: error: connection to server at "db" (10.0.3.4), port 5432 failed: timeout expired',
    startedAt: new Date('2026-10-01T02:00:03.000Z'),
    failedAt: new Date('2026-10-01T02:00:34.000Z'),
    trigger: 'scheduled',
    appUrl: APP_URL,
  },
  'restore-completed': {
    runId: '9a3c5e7f-1b2d-4c6e-8f0a-2b4d6f8a0c1e',
    backupTakenAt: new Date('2026-09-30T02:00:03.000Z'),
    completedAt: new Date('2026-10-01T11:26:51.000Z'),
    triggeredBy: 'oscar@example.com',
    preRestoreBackupId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
    appUrl: APP_URL,
  },
};

/** Replace every `cid:<id>` with a data URI of the matching inline part. */
function inlineCids(rendered: RenderedEmail): string {
  return rendered.html.replace(/cid:([^"'\s>]+)/g, (whole, id: string) => {
    const part = rendered.attachments.find((a) => a.contentId === id);
    return part ? `data:${part.contentType};base64,${part.contentBase64}` : whole;
  });
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function main(): void {
  const outArg = process.argv[2];
  if (!outArg) {
    console.error('Usage: npx tsx apps/api/scripts/render-email-previews.ts <outDir>');
    process.exit(1);
  }
  const outDir = resolve(outArg);
  mkdirSync(outDir, { recursive: true });

  const entries: string[] = [];
  for (const name of EMAIL_TEMPLATE_NAMES) {
    const rendered = renderEmailTemplate(name, SAMPLES[name] as never);
    writeFileSync(join(outDir, `${name}.html`), inlineCids(rendered));
    writeFileSync(join(outDir, `${name}.txt`), rendered.text);
    entries.push(
      `<li><a href="${name}.html">${name}</a> · <a href="${name}.txt">text</a><br><small>${escapeText(rendered.subject)}</small></li>`,
    );
  }

  writeFileSync(
    join(outDir, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Email previews</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;line-height:1.6}li{margin:0 0 12px}small{color:#555}</style>
</head><body><h1>Email previews</h1><ul>${entries.join('\n')}</ul></body></html>`,
  );

  console.log(`Wrote ${EMAIL_TEMPLATE_NAMES.length} previews to ${outDir}`);
}

main();
