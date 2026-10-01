import { APP_NAME } from '@app/shared';

import type { EmailAttachment } from '../email.types';
import {
  BRAND_MARK_CID,
  BRAND_MARK_DISPLAY_SIZE,
  BRAND_MARK_FILENAME,
  BRAND_MARK_PNG_BASE64,
} from './brand-mark.generated';
import { SafeHtml, html, safeUrl } from './safe-html';

// =============================================================================
// Email layout — the HTML shell every message shares (issue #123, epic #109;
// redesigned for the brand mark and the Tidal Teal palette in #237)
// =============================================================================
//
// EMAIL HTML IS NOT WEB HTML. Every constraint below is here because a real
// client breaks without it, and getting this wrong once means every template
// that reuses this layout inherits the breakage.
//
//   * **Inline styles and nested tables, no flexbox, no grid.** Outlook on
//     Windows renders mail with the WORD layout engine, not with a browser
//     engine. It ignores `display:flex`, `display:grid`, most positioning, and
//     it strips `<style>` blocks in many configurations, so anything not
//     inlined is simply absent. Tables are the only layout primitive with 25
//     years of consistent behaviour across Gmail, Outlook and Apple Mail.
//
//     CLASSES EXIST ONLY AS HOOKS for the one progressive-enhancement
//     `<style>` block below (`em-bg`, `em-card`, `em-text`, ...). Every
//     element carries its complete light-mode styling inline; a class never
//     carries baseline appearance. Strip the `<style>` block — as Outlook and
//     several webmail clients do — and the message still renders exactly as
//     designed, minus dark mode and the tighter phone padding.
//
//   * **At most ONE `<style>` block, and it holds ONLY progressive
//     enhancements**: `@media (prefers-color-scheme: dark)`, the Outlook.com
//     `[data-ogsc]`/`[data-ogsb]` equivalents, and `@media (max-width:620px)`
//     for phones. Nothing in it may be needed for the message to be legible.
//     `layout.spec.ts` parses the block and fails on any other top-level rule.
//
//   * **No REMOTE assets whatsoever** — no `<link>`, no remote images, no web
//     fonts, no `http(s):` `src`. Gmail, Outlook and Apple Mail all block
//     remote content by default until the recipient clicks "display images",
//     and a blocked asset is also a tracking-pixel signal to spam filters.
//
//     THE BRAND MARK IS NOT A REMOTE ASSET. It travels INSIDE the message as
//     an inline MIME part (`Content-Disposition: inline`, `Content-ID:
//     <brand-mark>`) and the HTML references it as `cid:brand-mark`. There is
//     no network fetch, so there is nothing for "block remote images" to
//     block, and nothing to track. The part comes from `layoutAttachments()`
//     below; every template returns it in `RenderedEmail.attachments`, and
//     `composeEmailMessage` carries it to the transport. The product name
//     sits beside the image as LIVE TEXT, and the image has an empty `alt`,
//     so a client that hides inline images still shows the brand once, not
//     twice. `cid:` is the only `src` scheme this module emits.
//
//   * **A hidden preheader.** Inbox lists show a snippet beside the subject.
//     With no preheader the client scrapes the first visible text in the body
//     — the product name and the eyebrow — so every message in the list would
//     preview identically and the recipient learns nothing from it.
//
//   * **A palette that survives forced dark mode.** Outlook.com, the Gmail
//     Android app and others do not ask the message what it wants: they
//     INVERT its colours. CONTRAST survives inversion but HUE does not, so:
//     extremes for anything carrying body text (near-black ink on white or on
//     the pale page background, 15:1 and up), and the mid-tone brand and
//     status colours only on SHORT, BOLD accents — the eyebrow, callout
//     labels, the button — each of which clears 4.5:1 against its own
//     background in light mode AND in the dark values of the style block
//     (ratios beside each constant below). A mid-tone accent that inverts to
//     a slightly different mid-tone is still a bold label on a contrasting
//     ground. The `color-scheme`/`supported-color-schemes` metas opt Apple
//     Mail and iOS out of forced inversion and into the explicit dark values;
//     they are advisory, so the palette has to work either way on its own.
//
// The plain-text renderer lives at the bottom of this same file, deliberately.
// #123 requires BOTH parts for every message, and a template author who opens
// this file to find `renderLayout` cannot miss `plainText` sitting directly
// beneath it. Splitting them across files is how one of them quietly stops
// being produced.
// =============================================================================

/**
 * Product name. Text, beside the brand mark image — see the header note.
 *
 * NOT DEFINED HERE (issue #163, epic #161): the product name has one source
 * of truth, `packages/shared`, which the web app, the CLI and the OpenAPI
 * document read as well. This module re-exports it because templates need the
 * same string in their SUBJECT lines, and every template already imports
 * `APP_NAME` from here. Two copies of the product name is how a rename ships
 * half-applied; so is two import paths for the same constant.
 */
export { APP_NAME };

// -----------------------------------------------------------------------------
// Palette
// -----------------------------------------------------------------------------
//
// Restated from the web theme's light scheme, `apps/web/src/theme/tokens.ts`
// (`TIDAL_TEAL.light`), because the API cannot import from the web app and an
// email cannot read a CSS variable. CHANGE A COLOUR THERE FIRST, then here.
// Contrast ratios (WCAG 2.x) are against the background each colour is
// actually used on.

/** `background.default`. Page background outside the card. */
const BG_COLOR = '#F2F7F6';
/** `background.paper`. The card. */
const CARD_COLOR = '#FFFFFF';
/** `divider`. Card border and code-block border. */
const BORDER_COLOR = '#D0DDDB';
/** `surface.container1`. Hairlines between detail rows (no text sits on it). */
const RULE_COLOR = '#E7EFEE';
/** `text.primary`. 17.04:1 on the card, 15.75:1 on the page background. */
const TEXT_COLOR = '#0E1F1D';
/** `text.secondary`. 6.73:1 on the card, 6.22:1 on the page background. */
const MUTED_COLOR = '#4A605D';
/**
 * `primary.main`. Eyebrow, links, the button and the card's accent bar.
 * 5.47:1 on the card, 5.06:1 on the page background; white button label on
 * it is 5.47:1.
 */
const BRAND_COLOR = '#0F766E';
/** White label on the brand-teal button. */
const ON_BRAND_COLOR = '#FFFFFF';

/**
 * The four callout tones: the status colour (left bar + text label) and a
 * low-intensity tint of it for the callout background (status mixed 6% into
 * white). Label on tint: info 5.31:1, success 4.63:1, warning 4.99:1,
 * critical 5.97:1. Body text (`TEXT_COLOR`) on every tint is above 15:1.
 */
const TONES = {
  info: { color: '#0B6AA6', tint: '#F0F6FA', label: 'Info' },
  success: { color: '#1B7F4A', tint: '#F1F7F4', label: 'Done' },
  warning: { color: '#9C5A00', tint: '#F9F5F0', label: 'Warning' },
  critical: { color: '#B42318', tint: '#FBF2F1', label: 'Action needed' },
} as const;

// Dark values, from `TIDAL_TEAL.dark` — used ONLY inside the progressive
// `@media (prefers-color-scheme: dark)` block, never inline.
//   text #E3EEEC on card #122020 = 14.13:1, on bg #0B1413 = 15.76:1
//   muted #9CB2AE on card = 7.50:1, on bg = 8.36:1
//   link teal #4FCDBC on card = 8.61:1, on bg = 9.60:1
//   button stays #0F766E with white text (5.47:1)
//   callout labels (dark status colours) on their dark tints: info 6.46,
//   success 5.97, warning 6.96, critical 6.04; body text on every dark tint
//   is above 10.5:1. The tints are hand-picked dark shades of each hue,
//   because a status colour mixed into the teal-black card turns grey.
const DARK = {
  bg: '#0B1413',
  card: '#122020',
  border: '#2A423F',
  text: '#E3EEEC',
  muted: '#9CB2AE',
  accent: '#4FCDBC',
  tones: {
    info: { color: '#7DB9EE', tint: '#16304A' },
    success: { color: '#62C68E', tint: '#163A2A' },
    warning: { color: '#E6B452', tint: '#3A2E16' },
    critical: { color: '#F28B82', tint: '#3E2220' },
  },
} as const;

/**
 * Font stacks.
 *
 * Web fonts are a remote asset and therefore unavailable. The Word engine
 * falls back to Times New Roman when it cannot resolve the FIRST family, so
 * the stack leads with a face every Windows host has (Segoe UI), then the
 * Apple system face, then the universal fallbacks.
 *
 * Wrapped as `SafeHtml` because they contain single quotes: interpolated as a
 * plain string the `html` tag would (correctly, harmlessly) escape them to
 * `&#39;`, which is valid but makes the markup needlessly hard to read. They
 * are literals, which is the one case `unsafeFromTrustedString` exists for.
 */
const FONT = SafeHtml.unsafeFromTrustedString(
  "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif",
);
const MONO_FONT = SafeHtml.unsafeFromTrustedString(
  "Consolas, 'SFMono-Regular', Menlo, 'Liberation Mono', monospace",
);

/** Maximum width of the message column, in CSS pixels. */
const COLUMN_WIDTH = 600;

/**
 * Padding that pushes the client's scraped snippet off the end of the
 * preheader.
 *
 * Clients fill the inbox snippet to a fixed length: they take the preheader
 * and then KEEP GOING into the visible body. These are zero-width non-joiners
 * interleaved with word joiners — invisible in every client, but consumed by
 * the snippet's character budget, so the scrape runs out before it reaches the
 * body. The interleaving matters: a run of identical characters gets collapsed
 * by some clients, and the pair does not.
 */
const PREHEADER_PADDING = '&#847;&zwnj;&nbsp;&#8199;&#65279;&#847;'.repeat(30);

// -----------------------------------------------------------------------------
// The brand mark, as an inline MIME part
// -----------------------------------------------------------------------------

/**
 * The inline part behind `<img src="cid:brand-mark">`.
 *
 * The bytes are GENERATED (`brand-mark.generated.ts`, from the web app's icon
 * script) so the mark in the inbox is the mark in the browser tab.
 */
export const BRAND_MARK_ATTACHMENT: Readonly<EmailAttachment> = Object.freeze({
  filename: BRAND_MARK_FILENAME,
  contentType: 'image/png',
  contentBase64: BRAND_MARK_PNG_BASE64,
  contentId: BRAND_MARK_CID,
  disposition: 'inline' as const,
});

/**
 * The parts every `renderLayout` document references. Every template returns
 * this as `RenderedEmail.attachments`.
 *
 * A FRESH ARRAY OF FRESH OBJECTS per call, so a caller that decorates one
 * message's parts cannot mutate the next message's.
 */
export function layoutAttachments(): EmailAttachment[] {
  return [{ ...BRAND_MARK_ATTACHMENT }];
}

// -----------------------------------------------------------------------------
// The progressive-enhancement style block
// -----------------------------------------------------------------------------
//
// Built ONLY from the literal constants above, so wrapping it as trusted
// markup is sound. Every rule is `!important` because it has to beat an
// inline style, which is where the baseline lives.

const toneDarkRules = (Object.keys(DARK.tones) as Array<keyof typeof DARK.tones>)
  .map(
    (tone) =>
      `.em-callout-${tone}{background-color:${DARK.tones[tone].tint}!important;border-color:${DARK.tones[tone].color}!important;}` +
      `.em-label-${tone}{color:${DARK.tones[tone].color}!important;}`,
  )
  .join('');

const STYLE_BLOCK = SafeHtml.unsafeFromTrustedString(
  [
    '@media (prefers-color-scheme: dark){',
    `.em-bg{background-color:${DARK.bg}!important;}`,
    `.em-card{background-color:${DARK.card}!important;border-color:${DARK.border}!important;border-top-color:${BRAND_COLOR}!important;}`,
    `.em-text{color:${DARK.text}!important;}`,
    `.em-muted{color:${DARK.muted}!important;}`,
    `.em-accent{color:${DARK.accent}!important;}`,
    `.em-rule{border-color:${DARK.border}!important;}`,
    `.em-code{background-color:${DARK.bg}!important;border-color:${DARK.border}!important;color:${DARK.text}!important;}`,
    toneDarkRules,
    '}',
    // Outlook.com's dark mode rewrites colours itself and marks the elements
    // it touched with these attributes; restating the intended dark values
    // keeps its guesses from landing on mid-tones.
    `[data-ogsc] .em-text{color:${DARK.text}!important;}`,
    `[data-ogsc] .em-muted{color:${DARK.muted}!important;}`,
    `[data-ogsc] .em-accent{color:${DARK.accent}!important;}`,
    `[data-ogsb] .em-bg{background-color:${DARK.bg}!important;}`,
    `[data-ogsb] .em-card{background-color:${DARK.card}!important;}`,
    '@media (max-width:620px){',
    '.em-outer{padding:16px 10px 24px 10px!important;}',
    '.em-pad{padding:24px!important;}',
    '.em-title{font-size:21px!important;line-height:28px!important;}',
    '.em-detail-label,.em-detail-value{display:block!important;width:auto!important;}',
    '.em-detail-label{padding:10px 0 2px 0!important;}',
    '.em-detail-value{padding:0 0 10px 0!important;border-top:0!important;}',
    '.em-chrome{padding-left:4px!important;padding-right:4px!important;}',
    '}',
  ].join(''),
);

// -----------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------
//
// Every component returns `SafeHtml` and builds it with the `html` tag, so
// every caller-supplied value is escaped. Block components wrap themselves in
// a one-cell table whose bottom PADDING provides the spacing after them:
// Outlook ignores margins on tables and divs, but honours cell padding.

/** Wrap a block so the gap after it survives the Word engine. */
function block(content: SafeHtml, bottom = 20): SafeHtml {
  return html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 0 ${bottom}px 0;">${content}</td></tr></table>`;
}

export interface ParagraphOptions {
  /**
   * `muted` for supporting copy (smaller, secondary ink). Default is body
   * copy, which inherits its colour from the card so dark mode reaches it.
   */
  tone?: 'default' | 'muted';
}

/**
 * A paragraph of body copy. A `string` is escaped; a `SafeHtml` (for inline
 * `<strong>`) is emitted as-is.
 *
 * The default tone carries NO colour of its own: it inherits `TEXT_COLOR`
 * from the body cell, which also carries the `em-text` dark-mode hook.
 */
export function paragraph(
  content: string | SafeHtml,
  opts: ParagraphOptions = {},
): SafeHtml {
  if (opts.tone === 'muted') {
    return html`<p style="margin:0 0 16px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED_COLOR};" class="em-muted">${content}</p>`;
  }
  return html`<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:24px;">${content}</p>`;
}

/** One fact in a {@link detailRows} table. */
export interface DetailRow {
  label: string;
  value: string | SafeHtml;
  /** Set for identifiers (ids, hashes) so they read as such and wrap anywhere. */
  mono?: boolean;
}

/**
 * A two-column label/value table for the facts of a message — who, what,
 * when, which job, which node.
 *
 * Label muted 13px, value bold 14px; 1px hairlines BETWEEN rows. On a phone
 * the style block stacks each label above its value; without the style block
 * the columns simply stay side by side, which is still legible.
 */
export function detailRows(rows: readonly DetailRow[]): SafeHtml {
  if (rows.length === 0) return SafeHtml.EMPTY;

  const body = rows.map((row, index) => {
    const rule = index === 0 ? '' : `border-top:1px solid ${RULE_COLOR};`;
    const ruleCss = SafeHtml.unsafeFromTrustedString(rule);
    const valueFont = row.mono ? MONO_FONT : FONT;
    const valueSize = row.mono ? '13px' : '14px';
    // Bold monospace reads as shouting; identifiers stay regular weight and
    // are set apart by the face instead.
    const valueWeight = row.mono ? 'normal' : 'bold';
    return html`<tr>
      <td class="em-muted em-rule em-detail-label" width="34%" valign="top" style="width:34%;padding:10px 16px 10px 0;${ruleCss}font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED_COLOR};vertical-align:top;">${row.label}</td>
      <td class="em-text em-rule em-detail-value" valign="top" style="padding:10px 0;${ruleCss}font-family:${valueFont};font-size:${valueSize};line-height:20px;font-weight:${valueWeight};color:${TEXT_COLOR};vertical-align:top;word-break:break-word;overflow-wrap:anywhere;">${row.value}</td>
    </tr>`;
  });

  return block(
    html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${body}</table>`,
    16,
  );
}

export type CalloutTone = keyof typeof TONES;

export interface CalloutOptions {
  tone: CalloutTone;
  /** Short bold heading inside the callout. */
  title?: string;
  /** The callout's sentence(s). A `string` is escaped. */
  body: string | SafeHtml;
}

/** The word that names a callout's state, so state is never colour alone. */
export function calloutLabel(tone: CalloutTone): string {
  return TONES[tone].label;
}

/**
 * A tinted box that states the STATE of the thing the message is about:
 * failed (critical), done (success), degraded (warning), or worth knowing
 * (info).
 *
 * The tone is carried three ways — a 4px left bar and a tint in the status
 * colour, and a TEXT label ("Action needed", "Done", ...) — so a reader who
 * cannot tell red from green, or whose client inverted the colours, still
 * gets the state from the word.
 */
export function callout(opts: CalloutOptions): SafeHtml {
  const tone = TONES[opts.tone];
  const titleRow = opts.title
    ? html`<tr><td class="em-text" style="padding:0 0 4px 0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:bold;color:${TEXT_COLOR};">${opts.title}</td></tr>`
    : SafeHtml.EMPTY;

  return block(html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td class="em-callout-${opts.tone}" bgcolor="${tone.tint}" style="background-color:${tone.tint};border-left:4px solid ${tone.color};border-radius:0 8px 8px 0;padding:14px 18px 14px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td class="em-label-${opts.tone}" style="padding:0 0 4px 0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.8px;text-transform:uppercase;color:${tone.color};">${tone.label}</td></tr>
          ${titleRow}
          <tr><td class="em-text" style="font-family:${FONT};font-size:14px;line-height:22px;color:${TEXT_COLOR};">${opts.body}</td></tr>
        </table>
      </td>
    </tr>
  </table>`);
}

export interface CodeBlockOptions {
  /** Muted caption above the block ("Last error reported by the handler"). */
  label?: string;
}

/**
 * A monospaced, wrapped excerpt — an error message, a log line. The text is
 * escaped and keeps its line breaks.
 */
export function codeBlock(text: string, opts: CodeBlockOptions = {}): SafeHtml {
  const caption = opts.label
    ? html`<tr><td class="em-muted" style="padding:0 0 6px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED_COLOR};">${opts.label}</td></tr>`
    : SafeHtml.EMPTY;

  return block(html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${caption}
    <tr><td class="em-code" bgcolor="${BG_COLOR}" style="background-color:${BG_COLOR};border:1px solid ${BORDER_COLOR};border-radius:8px;padding:12px 14px;font-family:${MONO_FONT};font-size:13px;line-height:20px;color:${TEXT_COLOR};white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;">${text}</td></tr>
  </table>`);
}

/** A 1px hairline between sections of the card body. */
export function divider(): SafeHtml {
  return block(
    html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="em-rule" height="1" style="height:1px;line-height:1px;font-size:1px;border-top:1px solid ${RULE_COLOR};">&nbsp;</td></tr></table>`,
    4,
  );
}

/**
 * A secondary text link ("View all notifications"). The URL goes through
 * `safeUrl`; an unusable one drops the line entirely, matching the CTA.
 */
export function secondaryLink(label: string, url: string): SafeHtml {
  const checked = safeUrl(url);
  if (!checked) return SafeHtml.EMPTY;

  return block(
    html`<a class="em-accent" href="${checked}" target="_blank" style="font-family:${FONT};font-size:14px;line-height:20px;font-weight:bold;color:${BRAND_COLOR};text-decoration:underline;">${label}</a>`,
    12,
  );
}

// -----------------------------------------------------------------------------
// The layout
// -----------------------------------------------------------------------------

export interface RenderLayoutOptions {
  /** Heading shown at the top of the card, and the document `<title>`. */
  title: string;

  /**
   * Category label above the title — "Account", "Security", "Operations",
   * "Announcement", "Test". Short; rendered uppercase in brand teal.
   */
  eyebrow?: string;

  /**
   * Hidden inbox-preview text. Optional in the signature, but every real
   * template should pass one — see the preheader note in the header block.
   */
  previewText?: string;

  /**
   * The message body.
   *
   * TYPED `SafeHtml`, NOT `string`, AND THAT IS THE POINT. A body assembled by
   * string concatenation — the shape in which an unescaped display name
   * arrives — does not typecheck here. The only ways to produce a `SafeHtml`
   * are the `html` tag (and the components above, which use it), and the
   * explicitly named `SafeHtml.unsafeFromTrustedString` (see safe-html.ts).
   */
  bodyHtml: SafeHtml;

  /** Call-to-action button label. Rendered only together with `ctaUrl`. */
  ctaLabel?: string;

  /**
   * Call-to-action button URL. Must be an absolute `http(s)`/`mailto` URL;
   * anything else is rejected by `safeUrl` and the button — and its
   * paste-this-link fallback — is omitted rather than rendered pointing
   * somewhere useless.
   */
  ctaUrl?: string;

  /** Optional content below the button, e.g. a {@link secondaryLink}. */
  secondaryHtml?: SafeHtml;

  /**
   * Why the recipient got this message, as one or two sentences in the
   * footer ("You received this because you are an administrator of …").
   * Falls back to a generic line.
   */
  footerReason?: string;

  /**
   * Absolute URL of the recipient's notification preferences. When present
   * (and `safeUrl` accepts it) the footer shows "Manage email preferences".
   * Leave it out for mandatory messages, which cannot be switched off.
   */
  preferencesUrl?: string;
}

/** Footer fallback when a template supplies no reason. */
const DEFAULT_FOOTER_REASON =
  'If you were not expecting this message, you can safely ignore it.';

/** The muted product line at the very bottom of every message. */
function productLine(): string {
  return `Sent automatically by ${APP_NAME}.`;
}

/**
 * Estimated width of the VML button. VML cannot size itself to its label, so
 * the Outlook button is given a width from the label length (bold 16px is
 * ~9.5px per character) plus the 28px side padding the HTML button has.
 */
function vmlButtonWidth(label: string): number {
  return Math.max(160, Math.round(label.length * 9.5) + 56);
}

/**
 * The bulletproof button.
 *
 * Two renderings of the same button, selected by conditional comments:
 *
 *   * Outlook on Windows (`mso`) gets a VML `<v:roundrect>`: the Word engine
 *     ignores padding and `display:inline-block` on an anchor and squares
 *     `border-radius`, so a CSS button collapses into bare underlined text.
 *     VML gives it a real rounded, padded, clickable shape.
 *   * Everything else gets a table cell with `bgcolor` and an `<a>` padded
 *     14x28, inside `<!--[if !mso]><!-->`, which non-Outlook clients read as
 *     an ordinary closed comment followed by live markup.
 *
 * Below it, the URL as text: a button that does nothing (a client that strips
 * links, a corporate URL rewriter that broke it) still leaves the reader a way
 * through.
 */
function ctaBlock(label: string, url: string): SafeHtml {
  const width = vmlButtonWidth(label);
  const vmlOpen = SafeHtml.unsafeFromTrustedString('<!--[if mso]>');
  const vmlClose = SafeHtml.unsafeFromTrustedString('<![endif]-->');
  const notMsoOpen = SafeHtml.unsafeFromTrustedString('<!--[if !mso]><!-->');
  const notMsoClose = SafeHtml.unsafeFromTrustedString('<!--<![endif]-->');

  return html`<tr>
    <td align="left" style="padding:8px 0 0 0;">
      ${vmlOpen}<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:${width}px;" arcsize="17%" stroke="f" fillcolor="${BRAND_COLOR}"><w:anchorlock/><center style="color:${ON_BRAND_COLOR};font-family:Arial, Helvetica, sans-serif;font-size:16px;font-weight:bold;">${label}</center></v:roundrect>${vmlClose}
      ${notMsoOpen}<table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" bgcolor="${BRAND_COLOR}" style="background-color:${BRAND_COLOR};border-radius:8px;">
            <a href="${url}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:bold;color:${ON_BRAND_COLOR};text-decoration:none;border-radius:8px;">${label}</a>
          </td>
        </tr>
      </table>${notMsoClose}
    </td>
  </tr>
  <tr>
    <td class="em-muted" style="padding:16px 0 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED_COLOR};">
      Button not working? Paste this link into your browser:<br />
      <span class="em-accent" style="color:${BRAND_COLOR};word-break:break-all;">${url}</span>
    </td>
  </tr>`;
}

/**
 * Render the complete HTML document for one email.
 *
 * Returns a plain `string` because this is the terminal step: the result goes
 * straight into `RenderedEmail.html` and is never interpolated into anything
 * else. The inline parts it references come from {@link layoutAttachments},
 * which the template returns alongside it.
 */
export function renderLayout(opts: RenderLayoutOptions): string {
  const { title, eyebrow, previewText, bodyHtml, ctaLabel, ctaUrl } = opts;

  // The preheader is hidden by several overlapping declarations, not one.
  // Clients disagree about which of them they honour — Gmail respects
  // `display:none`, some Outlook builds do not and need the zero height/width,
  // and a few strip `visibility` — so the belt-and-braces stack is what keeps
  // this text out of the rendered body while leaving it visible to the
  // snippet scraper.
  const preheader = previewText
    ? html`<div
        style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;max-height:0;width:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;"
      >
        ${previewText}${SafeHtml.unsafeFromTrustedString(PREHEADER_PADDING)}
      </div>`
    : SafeHtml.EMPTY;

  // Reject the CTA URL rather than emit an unusable href — see `safeUrl`.
  const checkedCtaUrl = ctaUrl ? safeUrl(ctaUrl) : null;
  const cta =
    ctaLabel && checkedCtaUrl ? ctaBlock(ctaLabel, checkedCtaUrl) : SafeHtml.EMPTY;

  const secondary = opts.secondaryHtml
    ? html`<tr><td style="padding:16px 0 0 0;">${opts.secondaryHtml}</td></tr>`
    : SafeHtml.EMPTY;

  const eyebrowRow = eyebrow
    ? html`<tr><td class="em-accent" style="padding:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${BRAND_COLOR};">${eyebrow}</td></tr>`
    : SafeHtml.EMPTY;

  const checkedPreferencesUrl = opts.preferencesUrl
    ? safeUrl(opts.preferencesUrl)
    : null;
  const preferencesRow = checkedPreferencesUrl
    ? html`<tr><td class="em-chrome" style="padding:8px 8px 0 8px;font-family:${FONT};font-size:13px;line-height:20px;"><a class="em-accent" href="${checkedPreferencesUrl}" target="_blank" style="color:${BRAND_COLOR};text-decoration:underline;font-weight:bold;">Manage email preferences</a></td></tr>`
    : SafeHtml.EMPTY;

  const size = BRAND_MARK_DISPLAY_SIZE;

  // `bgcolor` attributes accompany every `background-color` style below: the
  // Word engine drops the CSS background on table elements often enough that
  // the deprecated presentational attribute is the reliable one.
  //
  // `x-apple-disable-message-reformatting` stops iOS Mail auto-scaling the
  // message, which otherwise resizes text and breaks the fixed column.
  //
  // The `<!--[if mso]>` ghost table exists because Outlook ignores `max-width`
  // entirely: without it the column stretches to the full window width.
  // The `OfficeDocumentSettings` block stops Outlook on high-DPI Windows from
  // rescaling pixel sizes (it otherwise renders the 48px mark at 64px).
  // `xmlns:v`/`xmlns:o` on <html> are what make the VML button parse.
  const document = html`<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${title}</title>
    ${SafeHtml.unsafeFromTrustedString('<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->')}
    <style>${STYLE_BLOCK}</style>
  </head>
  <body
    class="em-bg"
    style="margin:0;padding:0;width:100%;background-color:${BG_COLOR};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;"
    bgcolor="${BG_COLOR}"
  >
    ${preheader}
    <table
      role="presentation"
      class="em-bg"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      bgcolor="${BG_COLOR}"
      style="background-color:${BG_COLOR};"
    >
      <tr>
        <td class="em-outer" align="center" style="padding:32px 16px 40px 16px;">
          ${SafeHtml.unsafeFromTrustedString(`<!--[if mso]><table role="presentation" width="${COLUMN_WIDTH}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`)}
          <table
            role="presentation"
            width="100%"
            cellpadding="0"
            cellspacing="0"
            border="0"
            style="max-width:${COLUMN_WIDTH}px;width:100%;"
          >
            <tr>
              <td class="em-chrome" align="left" style="padding:0 8px 20px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td valign="middle" style="padding:0 12px 0 0;vertical-align:middle;">
                      <img src="cid:${BRAND_MARK_CID}" width="${size}" height="${size}" alt="" style="display:block;border:0;outline:none;width:${size}px;height:${size}px;border-radius:11px;" />
                    </td>
                    <td class="em-text" valign="middle" style="vertical-align:middle;font-family:${FONT};font-size:19px;line-height:24px;font-weight:bold;letter-spacing:-0.2px;color:${TEXT_COLOR};">
                      ${APP_NAME}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td>
                <table
                  role="presentation"
                  class="em-card"
                  width="100%"
                  cellpadding="0"
                  cellspacing="0"
                  border="0"
                  bgcolor="${CARD_COLOR}"
                  style="background-color:${CARD_COLOR};border:1px solid ${BORDER_COLOR};border-top-color:${BRAND_COLOR};border-radius:12px;border-collapse:separate;overflow:hidden;"
                >
                  <tr>
                    <td height="4" bgcolor="${BRAND_COLOR}" style="height:4px;line-height:4px;font-size:4px;background-color:${BRAND_COLOR};">&nbsp;</td>
                  </tr>
                  <tr>
                    <td class="em-pad" style="padding:32px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        ${eyebrowRow}
                        <tr>
                          <td style="padding:0 0 16px 0;">
                            <h1 class="em-text em-title" style="margin:0;font-family:${FONT};font-size:24px;line-height:31px;font-weight:bold;letter-spacing:-0.3px;color:${TEXT_COLOR};">${title}</h1>
                          </td>
                        </tr>
                        <tr>
                          <td class="em-text" style="font-family:${FONT};font-size:15px;line-height:24px;color:${TEXT_COLOR};">
                            ${bodyHtml}
                          </td>
                        </tr>
                        ${cta}
                        ${secondary}
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="em-muted em-chrome" align="left" style="padding:24px 8px 0 8px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED_COLOR};">
                ${opts.footerReason ?? DEFAULT_FOOTER_REASON}
              </td>
            </tr>
            ${preferencesRow}
            <tr>
              <td class="em-muted em-chrome" align="left" style="padding:12px 8px 0 8px;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED_COLOR};">
                ${productLine()}
              </td>
            </tr>
          </table>
          ${SafeHtml.unsafeFromTrustedString('<!--[if mso]></td></tr></table><![endif]-->')}
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return document.toString();
}

// -----------------------------------------------------------------------------
// The plain-text half
// -----------------------------------------------------------------------------
//
// THE TEXT PART IS MANDATORY AND HAND-WRITTEN. There is deliberately no
// function anywhere in this module that takes HTML and returns text, because
// the moment one exists every template will use it and the text part stops
// being written.
//
// Two independent reasons, both load-bearing:
//
//   1. **Deliverability.** Spam filters score HTML-only multipart-less mail as
//      a signal, because legitimate bulk senders produce both parts and a good
//      deal of unsolicited mail does not.
//
//   2. **It is read by humans.** Text-only clients, screen readers in text
//      mode, and previews all render this part. A machine-stripped version
//      reads as debris — bare CTA URLs stranded mid-sentence, table remnants,
//      the footer welded to the greeting. A recipient who sees that concludes
//      the message is broken.
//
// So `plainText` composes from STRUCTURE the author supplies — an eyebrow, a
// title, lines, a footer reason — rather than from the rendered markup, which
// it never sees. `textDetailLines` and `textCallout` give the HTML components
// their text-part counterparts, so the two halves keep the same shape.
// -----------------------------------------------------------------------------

export interface PlainTextOptions {
  /** Same heading as the HTML, so the two parts say the same thing. */
  title: string;

  /** Same category label as the HTML eyebrow; written in capitals. */
  eyebrow?: string;

  /**
   * Body paragraphs, one per element; an empty string is a blank line.
   *
   * TYPED AS A NON-EMPTY TUPLE. `[]` does not typecheck, so "I will fill the
   * text part in later" is a compile error rather than a message that ships
   * with an empty alternative part.
   */
  lines: readonly [string, ...string[]];

  /** CTA label, matching the HTML button. */
  ctaLabel?: string;

  /** CTA URL. Written out in full — a text part cannot hide a link behind a label. */
  ctaUrl?: string;

  /** Same footer reason as the HTML. Falls back to the same generic line. */
  footerReason?: string;

  /** Same preferences URL as the HTML footer link. */
  preferencesUrl?: string;
}

/**
 * Detail rows as aligned `Label:  value` lines, indented two spaces — the
 * text-part counterpart of {@link detailRows}.
 */
export function textDetailLines(
  rows: readonly { label: string; value: string }[],
): string[] {
  const width = Math.max(0, ...rows.map((row) => row.label.length)) + 1;
  return rows.map((row) => `  ${`${row.label}:`.padEnd(width + 1)} ${row.value}`);
}

/**
 * A callout as a labelled paragraph — the text-part counterpart of
 * {@link callout}. The state word ("Action needed") leads, as it does in the
 * HTML, so the state is in the text too.
 */
export function textCallout(opts: {
  tone: CalloutTone;
  title?: string;
  body: string;
}): string[] {
  const label = calloutLabel(opts.tone).toUpperCase();
  return opts.title
    ? [`[${label}] ${opts.title}`, opts.body]
    : [`[${label}] ${opts.body}`];
}

/**
 * Compose the plain-text alternative for a message.
 *
 * No wrapping, no reflowing, no markdown. Mail clients wrap text parts
 * themselves at the width of the reader's window, and a hard-wrapped body
 * double-wraps into a ragged mess on a phone.
 */
export function plainText(opts: PlainTextOptions): string {
  const parts: string[] = [APP_NAME, ''];
  if (opts.eyebrow) parts.push(opts.eyebrow.toUpperCase());
  parts.push(opts.title, '', ...opts.lines);

  if (opts.ctaLabel && opts.ctaUrl) {
    // The URL is scheme-checked here too. A text part is not markup, so there
    // is no injection to prevent — but a `javascript:` URL that the HTML half
    // refused to render must not reappear here as something the recipient can
    // copy into a browser bar.
    const checked = safeUrl(opts.ctaUrl);
    if (checked) {
      parts.push('', `${opts.ctaLabel}: ${checked}`);
    }
  }

  parts.push('', '--', opts.footerReason ?? DEFAULT_FOOTER_REASON);

  const preferences = opts.preferencesUrl ? safeUrl(opts.preferencesUrl) : null;
  if (preferences) {
    parts.push(`Manage email preferences: ${preferences}`);
  }

  parts.push(productLine());

  // CRLF, not LF. RFC 5322 specifies CRLF line endings, and while most
  // transports normalise, some SMTP relays pass bare LF through and the
  // recipient sees the whole body on one line.
  return parts.join('\r\n');
}

// Re-exported so `escapeHtml` is reachable from the module #123 names it in,
// alongside `renderLayout`. It is DEFINED in safe-html.ts next to the `html`
// tag that calls it, so the two cannot drift apart.
export { escapeHtml, html, SafeHtml, safeUrl } from './safe-html';
