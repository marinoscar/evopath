/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

// =============================================================================
// The service worker  (issue #218, epic #215)
// =============================================================================
//
// WHY THIS FILE EXISTS AT ALL
//
// Not for offline support — that is the bonus. On ANDROID CHROME the
// Notifications API is service-worker-only: `new Notification()` throws
// (`Illegal constructor`), and `ServiceWorkerRegistration.showNotification()`
// is the single code path that can put a notification on the screen. Without
// this file every Android phone and tablet gets nothing from epic #215, no
// matter what the permission prompt says. It is also the only place the
// `push`, `notificationclick` and `pushsubscriptionchange` handlers of issues
// #223 and #230 can live — a page cannot host them.
//
// Offline precaching of the app shell rides along for free, because the epic
// opted into it and the precache manifest is generated either way.
//
// -----------------------------------------------------------------------
// HARD CONSTRAINT: THIS WORKER MUST NEVER CALL THE API
// -----------------------------------------------------------------------
//
// It has no way to authenticate, and any attempt to acquire that ability
// breaks the page. The access token is MEMORY-ONLY — it lives in a private
// field of the `ApiClient` instance in `src/services/api.ts` and is never
// written to storage the worker can read — and the refresh cookie is scoped to
// `path: '/api/auth'` and ROTATED ON EVERY USE. So a worker that tried to
// refresh on its own would spend the one-shot refresh token behind the page's
// back; the page's next refresh would then present a token the server has
// already retired, and the user would be logged out by their own service
// worker. Anything the worker needs from the API must be pushed TO it (a Web
// Push payload, or a `postMessage` from a page that already holds a token),
// never fetched BY it.
//
// -----------------------------------------------------------------------
// SECURITY: NOTHING UNDER `/api` MAY EVER BE CACHED
// -----------------------------------------------------------------------
//
// Cache Storage is origin-scoped and outlives the session: it is not cleared
// by logout, and it is not partitioned per account. Precaching or
// runtime-caching an authenticated JSON response therefore leaves one user's
// data readable by the NEXT person to sign in on a shared device, long after
// the token that fetched it expired. There is deliberately no runtime caching
// strategy registered below for that reason, and `globPatterns` in
// `vite.config.ts` only ever matches built static assets, which never include
// `/api` because the API is a different service entirely.
// =============================================================================

import { isInternalLink } from './utils/internalLink';

declare let self: ServiceWorkerGlobalScope;

// -----------------------------------------------------------------------------
// Precache the app shell
// -----------------------------------------------------------------------------
// `self.__WB_MANIFEST` is replaced at build time by vite-plugin-pwa with the
// list of built assets (see `injectManifest.globPatterns` in `vite.config.ts`).
// `cleanupOutdatedCaches()` deletes precaches left by PREVIOUS revisions of
// this worker; without it every deploy grows Cache Storage by another full copy
// of the bundle until the browser evicts the origin wholesale.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// -----------------------------------------------------------------------------
// SPA navigation fallback
// -----------------------------------------------------------------------------
// Every in-app route (`/settings`, `/admin/settings/users`, …) is a client-side
// path with no file behind it, so a navigation request is answered from the
// precached `index.html` — the same job `try_files $uri $uri/ /index.html` does
// in `apps/web/nginx.conf`, done offline.
//
// THE DENYLIST IS LOAD-BEARING, AND `/api/notifications/stream` IS WHY.
//
// `/^\/api\//` keeps the worker out of the API's URL space entirely. Do not
// narrow it to "just the HTML-ish API routes" or to individual paths: that
// endpoint is SERVER-SENT EVENTS, and an SSE response BY DESIGN NEVER ENDS.
// A handler that took it would hold a `fetch()` open for the lifetime of the
// stream — the worker never reaches idle, the browser eventually kills it as
// unresponsive, and the notification stream dies with it. The same reasoning
// covers `/api/docs` and `/api/storage/objects/:id/download`, which are real
// server responses that must not be swapped for the SPA shell.
//
// (Strictly, `NavigationRoute` only sees requests whose `mode` is `navigate`,
// which an `EventSource` connection is not. The denylist is belt-and-braces
// against exactly that reasoning being used to remove it.)
//
// `/.well-known/` is the server's too (issue #279): `assetlinks.json` there is
// the Android app's Digital Asset Links document, proxied to the API by nginx.
// Chrome's own verification fetch never passes through this worker, but a
// person opening the URL in a tab would otherwise get the SPA shell instead of
// the JSON they came to check.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/\.well-known\//],
  }),
);

// -----------------------------------------------------------------------------
// Take control of open pages as soon as this worker activates
// -----------------------------------------------------------------------------
// This is not a nicety. On a FIRST load the page that installed the worker is
// not controlled by it, and an uncontrolled page has no
// `registration.active` — so `registration.showNotification()` is unavailable
// for that entire session, which on Android means the user grants notification
// permission and then sees nothing until they reload. `clientsClaim()` closes
// that window.
clientsClaim();

// -----------------------------------------------------------------------------
// Update handshake  (`registerType: 'prompt'`)
// -----------------------------------------------------------------------------
// Deliberately NO top-level `self.skipWaiting()`. Under `prompt` a new worker
// installs and then WAITS, so a user mid-session keeps the exact asset
// revisions their loaded page was built against; activating underneath them
// would let a stale chunk request 404 against a rotated filename.
//
// The page decides when to hand over, by posting `{ type: 'SKIP_WAITING' }`.
// Issue #219 wires the UI half (`useRegisterSW` plus an "update available"
// prompt); this listener is the worker half it will call, and it exists now so
// that a worker shipped today is never permanently stuck in `waiting` should a
// build land before that UI does.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// -----------------------------------------------------------------------------
// notificationclick, push and pushsubscriptionchange — issues #223 and #230,
// epic #215
// -----------------------------------------------------------------------------
//
// notificationclick —
//
// The ONLY place a click on a worker-shown notification can be handled. A
// toast raised by `showPageNotification` (`services/browserNotifications.ts`)
// carries a JS `onclick` closure in the page that already knows what to do
// with a click; one raised by `registration.showNotification()`
// (`showAppNotification`, same file, issue #222) has NO such closure — the
// click instead arrives here, as this event, possibly with no page open at
// all. That is the entire reason this handler exists rather than living next
// to the other one.
//
// STILL BOUND BY "THIS WORKER MUST NEVER CALL THE API" AT THE TOP OF THIS
// FILE. Marking a notification read needs a valid access token, and the only
// place one exists is inside an open page's `ApiClient` instance (memory-only,
// see above) — so this handler never does the marking itself. It only ever
// hands the click to a page that already holds a token, one of two ways:
//   * a page is already open — focus it and `postMessage` the click, and let
//     `NotificationContext.tsx`'s `message` listener call the SAME
//     `markRead`/`navigate` the in-page toast's own click handler calls;
//   * no page is open — `clients.openWindow()` a fresh one at the link, with
//     the notification id riding along in a `?n=` query param, because there
//     is no page yet to `postMessage` to. `NotificationContext.tsx`'s
//     boot-time effect reads `?n=`, marks it read once the app (and its
//     token) exist, and strips the param so a refresh does not re-fire it.
// Either way, the API call happens from the page, on the page's own token,
// exactly as if the user had clicked the row in the bell.
//
// RE-VALIDATE `link` HERE EVEN THOUGH `sanitizeLink` ALREADY ENFORCES
// ROOT-RELATIVE-ONLY AT WRITE TIME
// (`apps/api/src/notifications/channels/browser-notification.channel.ts`).
// That sanitizer's own comment argues a forgetful FUTURE consumer would have
// to be unlucky, not that one is impossible — and this worker is exactly that
// new consumer, feeding the value straight into `clients.openWindow()`, a real
// navigation. A row written by an older build, seeded by hand, or restored
// from a backup taken before the sanitiser existed is not something this
// worker chooses to trust a second time on faith. `isInternalLink` (also used
// by the row click in `NotificationBell.tsx` and the in-page toast click in
// `NotificationContext.tsx`) accepts only a single leading `/` and rejects the
// protocol-relative `//`, which a browser resolves as "same scheme, ANY
// host" — precisely the shape an open-redirect payload would take. Anything
// that fails the check falls back to `/`: a wrong destination inside this app
// is a wrong click, an accepted off-origin link is a vulnerability.
self.addEventListener('notificationclick', (event) => {
  // Dismiss immediately, before the async work below. Left open, the OS lets
  // the same notification be clicked again while this handler is still
  // in flight, which would just fire it a second time for one click.
  event.notification.close();

  const data = (event.notification.data ?? {}) as { id?: unknown; link?: unknown; actionLinks?: unknown };
  const id = typeof data.id === 'string' ? data.id : '';
  // An ACTION BUTTON (E7.5, #245: the coach's "Hear Coach") carries its own
  // link, keyed by the action id in `data.actionLinks` by the push handler
  // below; a click on the body (`event.action === ''`) uses the plain link.
  // The action's link goes through the same `isInternalLink` check, and an
  // unknown action falls back to the plain link rather than to nothing.
  const rawLink = actionLinkOf(data.actionLinks, event.action) ?? (typeof data.link === 'string' ? data.link : null);
  const link = isInternalLink(rawLink) ? rawLink : '/';

  event.waitUntil(
    (async () => {
      // `includeUncontrolled: true` matters on the FIRST click after this
      // worker activates: `clientsClaim()` above hands the worker control of
      // pages going forward, but a tab that was already open when this worker
      // installed is not retroactively controlled, and without this flag
      // `matchAll` would not see it — the click would then look like the
      // cold-open case below and launch a SECOND tab next to the one already
      // open, rather than reusing it.
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      if (allClients.length > 0) {
        // Prefer a client already sitting on the link's path — nothing to
        // navigate, just bring it forward — and fall back to whichever window
        // is first otherwise. `matchAll({ type: 'window' })` guarantees
        // `WindowClient`s back even though `Clients.matchAll`'s declared
        // return type is the narrower `Client[]`.
        const windowClients = allClients as WindowClient[];
        const linkPath = link.split('?')[0];
        const target =
          windowClients.find((client) => {
            try {
              return new URL(client.url).pathname === linkPath;
            } catch {
              return false;
            }
          }) ?? windowClients[0];

        await target.focus();
        // The PAGE does the mark-read and the navigation from here — see
        // `NotificationContext.tsx`'s `message` listener, which reuses the
        // exact `markRead`/`navigate` calls the in-page toast's click handler
        // already makes. This worker only ever delivers the click.
        target.postMessage({ type: 'notification-click', id, link });
        return;
      }

      // COLD OPEN: no page to `postMessage` to, so the id rides along in the
      // URL instead, for `NotificationContext.tsx`'s boot-time `?n=` handler
      // to pick up once the app — and a token to mark it read with — exists.
      const separator = link.includes('?') ? '&' : '?';
      await self.clients.openWindow(`${link}${separator}n=${encodeURIComponent(id)}`);
    })(),
  );
});

// push and pushsubscriptionchange —
//
// Both live HERE, in this file, and not in a script pulled in with
// `importScripts()` — that split is precisely why this build uses
// `injectManifest` rather than `generateSW`; see `vite.config.ts`. Both must
// respect the "never call the API" constraint at the top of this file: `push`
// renders the payload it was given rather than fetching anything to render it,
// and `pushsubscriptionchange` never tries to notify the server (see its own
// doc comment).

/**
 * The payload shape the API's `PushNotificationChannel` sends as the Web Push
 * message body (JSON, comfortably under the 4KB push payload limit). `id` and
 * `link` are carried through into `notification.data` so a future
 * `notificationclick` handler (issue #223) can mark the notification read and
 * navigate without any further lookup.
 */
interface PushNotificationPayload {
  id: string;
  eventKey: string;
  title: string;
  body: string;
  link: string;
  /**
   * OPTIONAL action buttons (E7.5, #245), each with its own root-relative
   * link: the coach's "Hear Coach" (`hear`) opens `/coach?m=<id>&autoplay=1`.
   * The click on the button is the user gesture that lets the page play the
   * audio (a service worker has no audio output of its own).
   */
  actions?: Array<{ action: string; title: string; link: string }>;
  /** OPTIONAL ids for the page (E7.5: the coach `messageId`). */
  data?: { messageId?: string };
  /**
   * Set only by the admin "Send test push" action (`POST
   * /api/admin/push-config/test`, issue #115). See `handleTestPush`.
   */
  test?: boolean;
}

const PUSH_ICON = '/icons/icon-192.png';
const PUSH_BADGE = '/icons/badge-96.png';

/**
 * =============================================================================
 * THE CRITICAL RULE
 * =============================================================================
 * If a push event's `waitUntil` promise resolves WITHOUT `showNotification`
 * having been called, Chrome silently substitutes its own generic "This site
 * has been updated in the background" notification — worse than anything this
 * handler could show on purpose, and confusing to a user who has no idea what
 * it means. So every code path below — including the JSON-parse-failure path
 * — ends in an awaited `showNotification` (a test push's ack `postMessage`
 * stands in only if that call throws; see `handleTestPush`). There must be no
 * path that just returns.
 */
async function handlePush(event: PushEvent): Promise<void> {
  let payload: PushNotificationPayload;
  try {
    if (!event.data) throw new Error('push event carried no data');
    payload = event.data.json() as PushNotificationPayload;
  } catch {
    // Malformed or missing payload: there is no title/body/link/id to work
    // with. Per the critical rule above, doing nothing here is strictly worse
    // than showing something — it would surface Chrome's own generic
    // substitute instead, which looks identical to the user but tells them
    // nothing this app can control. A plain, generic notification is the more
    // honest failure mode, so show one rather than silently no-op.
    await self.registration.showNotification('New notification', {
      body: 'You have a new notification',
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
      tag: 'push-fallback',
    });
    return;
  }

  if (payload.test === true) {
    await handleTestPush(payload);
    return;
  }

  // Every real push is shown as an OS notification — including when a
  // visible, focused tab exists. That tab has already received this event
  // over SSE and run it through `NotificationContext` (table update, unread
  // count), but its SSE handler deliberately raises NO OS toast while the tab
  // is focused (the `visibilityState === 'visible' && hasFocus()` early
  // return). So if this worker also stayed quiet for a focused tab — as it
  // once did, posting the payload to the page instead — a focused user got no
  // visible alert at all. Showing it here therefore adds no duplicate: the
  // page and the worker never both toast for a focused tab.
  //
  // Known pre-existing edge, unchanged by this rule: a backgrounded-but-alive
  // tab can raise its own SSE toast (tagged with the browser-channel row's id)
  // alongside this one (tagged with the push-channel row's id). The two rows
  // have different ids, so the `tag` de-dup below cannot collapse them.
  const options: NotificationOptionsWithActions = {
    body: payload.body,
    // Keyed by the notification's own id, mirroring the `tag` de-dup
    // convention `showNativeNotification` uses for the page-side toast (see
    // `services/browserNotifications.ts`): multiple pushes for the same
    // notification collapse into one OS entry instead of stacking.
    tag: payload.id,
    icon: PUSH_ICON,
    badge: PUSH_BADGE,
    // Consumed by the `notificationclick` handler above to mark the
    // notification read and navigate. Passed through unmodified — validating
    // or sanitising `link` is that handler's job at the point it navigates,
    // not this one's.
    data: notificationDataOf(payload),
    ...actionsOf(payload),
  };
  await self.registration.showNotification(payload.title, options);
}

/**
 * `NotificationOptions` plus `actions`, which this project's `lib.webworker`
 * does not declare yet (every Chromium browser and Firefox support it on a
 * service-worker notification; Safari ignores it).
 */
interface NotificationOptionsWithActions extends NotificationOptions {
  actions?: Array<{ action: string; title: string }>;
}

/**
 * `notification.data` for a real push: `id` and `link` always, plus the
 * action links and the coach `messageId` only when the payload carries them
 * (so a plain notification's data is exactly `{ id, link }`).
 */
function notificationDataOf(payload: PushNotificationPayload): Record<string, unknown> {
  const actions = validActions(payload.actions);
  return {
    id: payload.id,
    link: payload.link,
    ...(actions.length > 0
      ? { actionLinks: Object.fromEntries(actions.map((a) => [a.action, a.link])) }
      : {}),
    ...(typeof payload.data?.messageId === 'string' ? { messageId: payload.data.messageId } : {}),
  };
}

/** `{ actions }` for `showNotification`, or nothing when the payload has none. */
function actionsOf(payload: PushNotificationPayload): { actions?: Array<{ action: string; title: string }> } {
  const actions = validActions(payload.actions);
  return actions.length > 0 ? { actions: actions.map(({ action, title }) => ({ action, title })) } : {};
}

/** Well-formed actions only: string fields, at most two (what browsers show). */
function validActions(value: unknown): Array<{ action: string; title: string; link: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (a): a is { action: string; title: string; link: string } =>
        !!a &&
        typeof a === 'object' &&
        typeof (a as { action?: unknown }).action === 'string' &&
        typeof (a as { title?: unknown }).title === 'string' &&
        typeof (a as { link?: unknown }).link === 'string',
    )
    .slice(0, 2);
}

/** The link stored for `action` by `notificationDataOf`, or null. */
function actionLinkOf(actionLinks: unknown, action: string | undefined): string | null {
  if (!action || !actionLinks || typeof actionLinks !== 'object') return null;
  const link = (actionLinks as Record<string, unknown>)[action];
  return typeof link === 'string' ? link : null;
}

/**
 * A TEST PUSH from `/admin/settings/push` (issue #115).
 *
 * Like a real push, it is ALWAYS shown as an OS notification, even when a
 * visible, focused tab exists (the admin presses "Send test push" FROM an open
 * tab). It differs in two deliberate ways:
 *
 *   1. It has no SSE twin and writes no notification row, so there is nothing
 *      for the page to have shown already.
 *   2. It then acks to EVERY window client (`push-test-received`), so the
 *      diagnostics panel can prove end-to-end delivery and measure latency.
 *
 * `data.id` is `''` on purpose: the test id names no notification row, and
 * `notificationclick` / `NotificationContext` skip mark-read for an empty id.
 *
 * Still obeys the critical rule above: `showNotification` is attempted first,
 * and if it throws the ack `postMessage` stands in for it.
 */
async function handleTestPush(payload: PushNotificationPayload): Promise<void> {
  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const hadFocusedClient = windowClients.some(
    (client) => client.visibilityState === 'visible' && client.focused,
  );

  let shown = false;
  let error: string | undefined;
  try {
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.id,
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
      data: { id: '', link: payload.link, test: true },
    });
    shown = true;
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const ack = {
    type: 'push-test-received',
    id: payload.id,
    receivedAt: Date.now(),
    shown,
    hadFocusedClient,
    ...(error ? { error } : {}),
  };
  for (const client of windowClients) {
    try {
      client.postMessage(ack);
    } catch {
      // One client refusing the message must not stop the others hearing it.
    }
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

/**
 * A local extension of `PushSubscriptionChangeEvent`. `oldSubscription` is
 * part of the Push API spec, but it is missing from this project's `lib`
 * (`ESNext`+`WebWorker`) — a real gap in `lib.webworker.d.ts`'s event typing,
 * not a mistake in this code. This augments the shape locally rather than
 * suppressing the checker with `@ts-expect-error`, so a future lib update
 * that adds the real property is a visible, honest type error here (an
 * unnecessary augmentation) instead of a silently-stale suppression comment.
 */
interface PushSubscriptionChangeEventWithOldSubscription extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
}

/**
 * Best-effort resubscription, per the issue's own Alternatives Considered
 * section: "The page re-syncs idempotently on every boot, which is the real
 * mechanism; the worker handler is a best-effort optimisation." So there is
 * deliberately no attempt here to POST the new subscription to
 * `/api/notifications/push/subscriptions` — this worker has no token to
 * authenticate that call with (see the "NEVER CALL THE API" header rule), and
 * a silent failure here is fully recovered by the page's own resync on next
 * load.
 */
async function handlePushSubscriptionChange(
  event: PushSubscriptionChangeEvent,
): Promise<void> {
  const applicationServerKey = (event as PushSubscriptionChangeEventWithOldSubscription)
    .oldSubscription?.options?.applicationServerKey;

  if (!applicationServerKey) return;

  try {
    await self.registration.pushManager.subscribe({
      applicationServerKey,
      userVisibleOnly: true,
    });
  } catch (error) {
    // Expected/tolerated, not a bug — the page's own resync is the real
    // mechanism (see the doc comment above). Low-key `warn`, not `error`,
    // since nothing here needs anyone paged.
    console.warn('Service worker push resubscription failed; page will resync on next load.', error);
  }
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(handlePushSubscriptionChange(event));
});
