import {
  APP_NAME,
  callout,
  detailRows,
  html,
  layoutAttachments,
  paragraph,
  plainText,
  renderLayout,
  textCallout,
  textDetailLines,
  timestampRow,
} from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Worker node went offline" template — `nodes.node_offline` (#288, epic #254)
// =============================================================================
//
// THE FACT WORTH REPORTING IS LOST CAPACITY, NOT A CRASH. Nothing observed
// this node fail: the fleet sweep noticed that it stopped heartbeating past
// the stale window and wrote `offline`. That distinction drives the copy —
// the message says what was last heard and when, and does not assert a cause
// it cannot know.
//
// THE NODE'S NAME IS OPERATOR-SUPPLIED and reaches this template unvalidated,
// so it is interpolated through the `html` tag like every other value here and
// is escaped by construction.
//
// No product name is hard-coded; `APP_NAME` is the only seam.
// =============================================================================

/** Everything the node-offline message renders. */
export interface NodeOfflineEmailData {
  /** The node row's id. */
  nodeId: string;

  /** The operator-supplied display name. Escaped on the way into the html. */
  nodeName: string;

  /**
   * When the node was last heard from, or `null` when it registered and never
   * heartbeated at all — which is a genuinely different failure (a node that
   * came up and could not reach the control plane) and is worth saying so.
   */
  lastHeartbeatAt: Date | null;

  /** When the sweep marked it offline. Rendered as UTC. */
  markedOfflineAt: Date;

  /**
   * The stale window in minutes that the sweep applied, so the reader can tell
   * "unreachable for 6 minutes" from "unreachable for 6 hours" without going
   * to look up the policy.
   */
  staleAfterMinutes: number;

  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. Matches `adminSections.tsx`. */
const WORKERS_ADMIN_PATH = '/admin/settings/workers';

/**
 * A never-heartbeated node gets WORDS rather than a blank cell.
 *
 * The same rule `role-changed.email.ts` applies to an empty role list: the
 * most alarming value in the message must not render as whitespace that reads
 * like a formatting bug.
 */
const NEVER_HEARTBEATED = 'Never — it registered and never sent a heartbeat';

/** The recipient's own notification settings page, appended to `appUrl`. */
const NOTIFICATION_SETTINGS_PATH = '/settings/notifications';

/**
 * Render the node-offline message.
 */
export function nodeOfflineEmail(data: NodeOfflineEmailData): RenderedEmail {
  const heartbeatRow = timestampRow(
    'Last heartbeat',
    data.lastHeartbeatAt,
    NEVER_HEARTBEATED,
  );
  const heartbeat = heartbeatRow.value;

  // The SUBJECT DELIBERATELY DOES NOT CARRY THE NODE NAME. Subject lines are
  // not HTML and are therefore not escaped by the `html` tag, so putting an
  // operator-supplied string in one would be the single place in this file
  // where an unescaped value reaches a rendered surface. The name is in the
  // body and in the preheader, both of which go through the tag.
  const subject = `${APP_NAME}: a worker node stopped responding`;

  const title = 'Worker node went offline';
  const eyebrow = 'Operations';
  const ctaUrl = data.appUrl ? `${data.appUrl}${WORKERS_ADMIN_PATH}` : undefined;
  const ctaLabel = ctaUrl ? 'Open worker nodes' : undefined;
  const preferencesUrl = data.appUrl
    ? `${data.appUrl}${NOTIFICATION_SETTINGS_PATH}`
    : undefined;
  const footerReason = `You received this because you can view worker nodes in ${APP_NAME}.`;

  const intro =
    `A worker node registered with ${APP_NAME} stopped sending heartbeats for longer than the configured stale window, ` +
    'and has been marked offline. Nothing observed it fail — it simply stopped answering.';
  const calloutTitle = 'The fleet is running with less capacity';
  const calloutBody =
    "Jobs it was holding are released by the queue's own lease sweep and will be retried elsewhere. Until this node comes back, the fleet has less capacity than it was sized for.";
  const facts = [
    { label: 'Node', value: data.nodeName },
    { label: 'Node id', value: data.nodeId, mono: true },
    heartbeatRow,
    timestampRow('Marked offline at', data.markedOfflineAt),
    { label: 'Stale after', value: `${data.staleAfterMinutes} minute(s)` },
  ];

  const bodyHtml = html`
    ${paragraph(intro)}
    ${callout({ tone: 'warning', title: calloutTitle, body: calloutBody })}
    ${detailRows(facts)}
  `;

  const htmlDocument = renderLayout({
    title,
    eyebrow,
    previewText:
      data.lastHeartbeatAt === null
        ? `${data.nodeName} never checked in.`
        : `${data.nodeName} last checked in at ${heartbeat}.`,
    bodyHtml,
    ctaLabel,
    ctaUrl,
    footerReason,
    preferencesUrl,
  });

  const text = plainText({
    eyebrow,
    title,
    lines: [
      intro,
      '',
      ...textCallout({ tone: 'warning', title: calloutTitle, body: calloutBody }),
      '',
      ...textDetailLines(facts),
    ],
    ctaLabel,
    ctaUrl,
    footerReason,
    preferencesUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
    attachments: layoutAttachments(),
  };
}
