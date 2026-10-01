import { html, SafeHtml } from './safe-html';
import {
  APP_NAME,
  detailRows,
  formatEmailDuration,
  formatEmailTimestamp,
  plainText,
  renderLayout,
  textDetailLines,
  timeHtml,
  timestampRow,
} from './layout';
import { roleChangedEmail } from './role-changed.email';
import { testEmail } from './test-email.email';

// =============================================================================
// layout.ts — tests (issue #123, epic #109)
// =============================================================================
//
// Three concerns, in the order #123 asks for them:
//
//   1. Escaping of the data the layout itself interpolates (title, preview
//      text, CTA label) — the layout is a second place a display name flows
//      through, independent of safe-html.spec.ts's tests of the `html` tag
//      in isolation.
//   2. URL safety for the CTA button, and — crucially — that a rejected URL
//      causes the button to be DROPPED rather than rendered pointing
//      somewhere useless, checked on the rendered output of BOTH the HTML
//      and the text part.
//   3. Structural invariants (no <link>, only cid: sources, at most one
//      progressive-enhancement <style> block, inline baseline styling, table
//      based, hidden preheader present) that guard email-client
//      compatibility as future templates reuse this layout (#123, #237).
// =============================================================================

const basicBody: SafeHtml = html`<p>Hello, world.</p>`;

describe('renderLayout — escaping', () => {
  it('escapes a <script> payload in the title (rendered in both <title> and the visible heading)', () => {
    const out = renderLayout({
      title: '<script>alert(document.cookie)</script>',
      bodyHtml: basicBody,
    });

    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
    expect(out).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
  });

  it('escapes a <script> payload in the preview text (preheader)', () => {
    const out = renderLayout({
      title: 'Title',
      previewText: '<script>alert(1)</script>',
      bodyHtml: basicBody,
    });

    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes an attribute-breakout payload in the preview text', () => {
    const out = renderLayout({
      title: 'Title',
      previewText: '"><img src=x onerror=alert(1)>',
      bodyHtml: basicBody,
    });

    expect(out).not.toContain('<img src=x onerror=alert(1)>');
    expect(out).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a <script> payload in the CTA label', () => {
    const out = renderLayout({
      title: 'Title',
      bodyHtml: basicBody,
      ctaLabel: '<script>alert(1)</script>',
      ctaUrl: 'https://example.com/cta',
    });

    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('composes a nested SafeHtml bodyHtml verbatim, without double-escaping the caller-built markup', () => {
    const rows = ['first', 'second'].map(
      (label) => html`<li>${label}</li>`,
    );
    const body = html`<ul>${rows}</ul>`;
    const out = renderLayout({ title: 'Title', bodyHtml: body });

    expect(out).toContain('<ul><li>first</li><li>second</li></ul>');
  });

  it('still escapes user data inside a bodyHtml that also contains legitimate nested markup', () => {
    const displayName = '<script>alert(1)</script>';
    const body = html`<p>Welcome, ${displayName}.</p>${html`<p>Enjoy.</p>`}`;
    const out = renderLayout({ title: 'Title', bodyHtml: body });

    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('<p>Enjoy.</p>');
  });
});

describe('renderLayout — CTA URL safety', () => {
  it('renders a button for a valid https CTA URL', () => {
    const out = renderLayout({
      title: 'Title',
      bodyHtml: basicBody,
      ctaLabel: 'Open settings',
      ctaUrl: 'https://example.com/admin/settings/email',
    });

    expect(out).toContain('href="https://example.com/admin/settings/email"');
    expect(out).toContain('Open settings');
  });

  it('drops the button entirely when the CTA URL uses javascript:', () => {
    const out = renderLayout({
      title: 'Title',
      bodyHtml: basicBody,
      ctaLabel: 'Open settings',
      ctaUrl: 'javascript:alert(document.cookie)',
    });

    expect(out).not.toContain('Open settings');
    expect(out).not.toContain('javascript:');
    expect(out).not.toMatch(/<a\b/); // no anchor at all — the layout has no other <a> tag
  });

  it('drops the button entirely when the CTA URL uses a case-variant javascript: scheme', () => {
    const out = renderLayout({
      title: 'Title',
      bodyHtml: basicBody,
      ctaLabel: 'Open settings',
      ctaUrl: 'JaVaScRiPt:alert(1)',
    });

    expect(out).not.toContain('Open settings');
    expect(out).not.toMatch(/<a\b/i);
  });

  it('drops the button entirely when the CTA URL is relative', () => {
    const out = renderLayout({
      title: 'Title',
      bodyHtml: basicBody,
      ctaLabel: 'Open settings',
      ctaUrl: '/admin/settings/email',
    });

    expect(out).not.toContain('Open settings');
    expect(out).not.toMatch(/<a\b/);
  });

  it('renders no CTA markup at all when only ctaLabel is supplied (no ctaUrl)', () => {
    const out = renderLayout({
      title: 'Title',
      bodyHtml: basicBody,
      ctaLabel: 'Open settings',
    });

    expect(out).not.toContain('Open settings');
    expect(out).not.toMatch(/<a\b/);
  });

  it('renders no CTA markup at all when only ctaUrl is supplied (no ctaLabel)', () => {
    const out = renderLayout({
      title: 'Title',
      bodyHtml: basicBody,
      ctaUrl: 'https://example.com/cta',
    });

    expect(out).not.toMatch(/<a\b/);
  });
});

describe('renderLayout — structural invariants', () => {
  const out = renderLayout({
    title: 'Title',
    previewText: 'Preview',
    bodyHtml: basicBody,
    ctaLabel: 'Go',
    ctaUrl: 'https://example.com',
  });

  it('contains no <link> tag (no external stylesheet)', () => {
    expect(out).not.toMatch(/<link\b/i);
  });

  it('references assets only as cid: (inline MIME parts), never by a remote or data: URL', () => {
    // Every `src=` inside an actual (unescaped) tag. The brand mark travels
    // inside the message as an inline part and is referenced as
    // `cid:brand-mark`; anything else — http(s), protocol-relative, data: —
    // is either a remote fetch that clients block by default or a payload
    // several clients refuse to render.
    const sources = [
      ...out.matchAll(/<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]*)/gi),
    ].map((match) => match[1]);

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).toMatch(/^cid:/);
    }
    expect(sources).toContain('cid:brand-mark');
  });

  it('shows the brand mark with an empty alt and the product name as live text beside it', () => {
    expect(out).toMatch(/<img\b[^>]*src="cid:brand-mark"[^>]*alt=""/);
    expect(out).toContain(APP_NAME);
  });

  it('has at most one <style> block, holding only progressive enhancements (@media / [data-og*] rules)', () => {
    const blocks = [...out.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(
      (match) => match[1] ?? '',
    );
    expect(blocks.length).toBeLessThanOrEqual(1);

    for (const css of blocks) {
      // Walk the TOP-LEVEL rules by brace depth and record each one's prelude.
      const preludes: string[] = [];
      let depth = 0;
      let prelude = '';
      for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
        if (char === '{') {
          if (depth === 0) preludes.push(prelude.trim());
          depth += 1;
          prelude = '';
        } else if (char === '}') {
          depth -= 1;
        } else if (depth === 0) {
          prelude += char;
        }
      }
      expect(depth).toBe(0);
      expect(preludes.length).toBeGreaterThan(0);
      for (const rule of preludes) {
        expect(rule).toMatch(/^(@media\b|\[data-og(sc|sb)\])/);
      }
    }
  });

  it('keeps baseline styling inline on the main elements, so a stripped <style> block changes nothing essential', () => {
    // Each element a dark-mode/mobile rule targets also carries its light
    // appearance inline. Stripping the block must leave a styled message.
    const withoutStyle = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

    expect(withoutStyle).toMatch(/<body\b[^>]*style="[^"]*background-color:#F2F7F6/i);
    expect(withoutStyle).toMatch(/class="em-card"[^>]*bgcolor="#FFFFFF"[^>]*style="[^"]*border:1px solid/i);
    expect(withoutStyle).toMatch(/<h1\b[^>]*style="[^"]*font-size:\d+px[^"]*color:#0E1F1D/i);
    expect(withoutStyle).toMatch(/class="em-pad"[^>]*style="padding:32px;"/);
    // The button: a bgcolor cell around a padded anchor, plus the VML version.
    expect(withoutStyle).toMatch(/<td\b[^>]*bgcolor="#0F766E"[^>]*>\s*<a\b[^>]*style="[^"]*padding:14px 28px/i);
    expect(withoutStyle).toContain('<v:roundrect');
  });

  it('is table-based (a future flexbox "cleanup" would break Outlook silently)', () => {
    expect(out).toMatch(/<table\b/i);
    // More than a token gesture: the layout nests several tables (outer
    // shell, content card, CTA button).
    expect((out.match(/<table\b/gi) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('does not use flexbox or grid display', () => {
    expect(out).not.toMatch(/display:\s*flex/i);
    expect(out).not.toMatch(/display:\s*grid/i);
  });
});

describe('renderLayout — hidden preheader', () => {
  it('includes the preview text and hides it from visible rendering', () => {
    const out = renderLayout({
      title: 'Title',
      previewText: 'You have a new notification',
      bodyHtml: basicBody,
    });

    expect(out).toContain('You have a new notification');
    // Hidden via the belt-and-braces style stack documented in layout.ts.
    expect(out).toMatch(/display:\s*none/i);
    expect(out).toMatch(/visibility:\s*hidden/i);
  });

  it('appears in the document before the visible body content', () => {
    const out = renderLayout({
      title: 'Title',
      previewText: 'PREHEADER_MARKER',
      bodyHtml: html`<p>BODY_MARKER</p>`,
    });

    expect(out.indexOf('PREHEADER_MARKER')).toBeGreaterThan(-1);
    expect(out.indexOf('BODY_MARKER')).toBeGreaterThan(-1);
    expect(out.indexOf('PREHEADER_MARKER')).toBeLessThan(out.indexOf('BODY_MARKER'));
  });

  it('omits the preheader block when no previewText is given', () => {
    const withPreview = renderLayout({ title: 'Title', previewText: 'x', bodyHtml: basicBody });
    const withoutPreview = renderLayout({ title: 'Title', bodyHtml: basicBody });

    // The hidden-preheader style stack should only appear when previewText
    // is actually supplied.
    expect(withPreview).toMatch(/mso-hide:all/i);
    expect(withoutPreview).not.toMatch(/mso-hide:all/i);
  });
});

describe('plainText', () => {
  it('joins parts with CRLF, not bare LF', () => {
    const text = plainText({ title: 'Title', lines: ['Line one', '', 'Line two'] });

    expect(text).toContain('\r\n');
    // No LF that isn't part of a CRLF pair.
    expect(text).not.toMatch(/(?<!\r)\n/);
  });

  it('includes the title and every supplied line, in order', () => {
    const text = plainText({ title: 'My Title', lines: ['First line', 'Second line'] });
    const idxTitle = text.indexOf('My Title');
    const idxFirst = text.indexOf('First line');
    const idxSecond = text.indexOf('Second line');

    expect(idxTitle).toBeGreaterThan(-1);
    expect(idxFirst).toBeGreaterThan(idxTitle);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });

  it('contains no HTML tags', () => {
    const text = plainText({
      title: 'Title',
      lines: ['Plain sentence.', 'Another plain sentence.'],
      ctaLabel: 'Open settings',
      ctaUrl: 'https://example.com/settings',
    });

    expect(text).not.toMatch(/<[a-zA-Z!/][^>]*>/);
  });

  it('appends the CTA label and full URL when both are valid', () => {
    const text = plainText({
      title: 'Title',
      lines: ['Body.'],
      ctaLabel: 'Open settings',
      ctaUrl: 'https://example.com/settings',
    });

    expect(text).toContain('Open settings: https://example.com/settings');
  });

  it('drops the CTA line entirely when the URL is rejected (javascript:) — matching the HTML behavior', () => {
    const text = plainText({
      title: 'Title',
      lines: ['Body.'],
      ctaLabel: 'Open settings',
      ctaUrl: 'javascript:alert(1)',
    });

    expect(text).not.toContain('Open settings');
    expect(text).not.toContain('javascript:');
  });

  it('drops the CTA line entirely when the URL is relative', () => {
    const text = plainText({
      title: 'Title',
      lines: ['Body.'],
      ctaLabel: 'Open settings',
      ctaUrl: '/settings',
    });

    expect(text).not.toContain('Open settings');
  });

  it('never renders the literal word "undefined" when the CTA is omitted or rejected', () => {
    const noCta = plainText({ title: 'Title', lines: ['Body.'] });
    const rejectedCta = plainText({
      title: 'Title',
      lines: ['Body.'],
      ctaLabel: 'Go',
      ctaUrl: 'javascript:evil()',
    });

    expect(noCta).not.toContain('undefined');
    expect(rejectedCta).not.toContain('undefined');
  });
});

describe('renderLayout + plainText — rejected CTA drops the button in BOTH parts', () => {
  it('a javascript: CTA URL is absent from the rendered HTML and the plain-text part', () => {
    const opts = {
      title: 'Title',
      ctaLabel: 'Dangerous button',
      ctaUrl: 'javascript:alert(document.cookie)',
    };

    const htmlOut = renderLayout({ ...opts, bodyHtml: basicBody });
    const textOut = plainText({ ...opts, lines: ['Body.'] });

    expect(htmlOut).not.toContain('Dangerous button');
    expect(htmlOut).not.toContain('javascript:');
    expect(textOut).not.toContain('Dangerous button');
    expect(textOut).not.toContain('javascript:');
  });
});

// =============================================================================
// Timestamps — formatEmailTimestamp and friends
// =============================================================================

describe('formatEmailTimestamp', () => {
  it('renders a UTC instant as day, English month, year, 24-hour time and an explicit zone', () => {
    expect(formatEmailTimestamp(new Date('2026-10-01T02:00:03.000Z'))).toBe(
      '1 Oct 2026, 02:00 UTC',
    );
    expect(formatEmailTimestamp(new Date('2026-10-01T21:59:59.999Z'))).toBe(
      '1 Oct 2026, 21:59 UTC',
    );
  });

  it('converts an input carrying a non-UTC offset to UTC (never the host zone)', () => {
    // 01:30 at +05:30 is 20:00 UTC on the PREVIOUS day.
    expect(formatEmailTimestamp('2026-03-01T01:30:00+05:30')).toBe(
      '28 Feb 2026, 20:00 UTC',
    );
    // A negative offset that pushes the instant into the next day.
    expect(formatEmailTimestamp('2026-06-15T22:15:00-04:00')).toBe(
      '16 Jun 2026, 02:15 UTC',
    );
  });

  it('crosses month and year boundaries correctly', () => {
    expect(formatEmailTimestamp('2026-01-31T23:59:00Z')).toBe('31 Jan 2026, 23:59 UTC');
    expect(formatEmailTimestamp('2026-02-01T00:00:00Z')).toBe('1 Feb 2026, 00:00 UTC');
    expect(formatEmailTimestamp('2026-12-31T23:30:00-01:00')).toBe(
      '1 Jan 2027, 00:30 UTC',
    );
  });

  it('accepts a Date and an ISO string for the same instant and renders them identically', () => {
    const iso = '2026-10-01T09:42:17.000Z';
    expect(formatEmailTimestamp(iso)).toBe(formatEmailTimestamp(new Date(iso)));
  });

  it('includes seconds only when asked', () => {
    expect(
      formatEmailTimestamp('2026-10-01T09:42:07.000Z', { seconds: true }),
    ).toBe('1 Oct 2026, 09:42:07 UTC');
  });

  it('returns invalid input unchanged rather than throwing', () => {
    expect(formatEmailTimestamp('not a date')).toBe('not a date');
    expect(formatEmailTimestamp('')).toBe('');
    expect(formatEmailTimestamp(new Date('garbage'))).toBe('Invalid Date');
  });
});

describe('timeHtml and timestampRow', () => {
  it('timeHtml wraps the human string in <time> with the exact ISO instant', () => {
    expect(timeHtml('2026-10-01T04:00:03+02:00').toString()).toBe(
      '<time datetime="2026-10-01T02:00:03.000Z" style="white-space:nowrap;">1 Oct 2026, 02:00 UTC</time>',
    );
  });

  it('timeHtml renders invalid input as escaped text with no <time> element', () => {
    const out = timeHtml('<b>soon</b>').toString();
    expect(out).toBe('&lt;b&gt;soon&lt;/b&gt;');
  });

  it('timestampRow gives the text part the human string and the html part a <time> wrapper', () => {
    const row = timestampRow('Changed at', new Date('2026-10-01T09:42:17.000Z'));

    expect(textDetailLines([row])).toEqual(['  Changed at:  1 Oct 2026, 09:42 UTC']);
    expect(detailRows([row]).toString()).toContain(
      '<time datetime="2026-10-01T09:42:17.000Z" style="white-space:nowrap;">1 Oct 2026, 09:42 UTC</time>',
    );
  });

  it('timestampRow renders null as words, with no <time> element', () => {
    const row = timestampRow('Started at', null);
    expect(row.value).toBe('Not recorded');
    expect(detailRows([row]).toString()).not.toContain('<time');
    expect(timestampRow('Last heartbeat', null, 'Never').value).toBe('Never');
  });
});

describe('formatEmailDuration', () => {
  it.each([
    ['2026-10-01T02:00:03Z', '2026-10-01T02:00:34Z', '31 s'],
    ['2026-10-01T02:00:00Z', '2026-10-01T02:00:00Z', '0 s'],
    ['2026-10-01T02:00:00Z', '2026-10-01T02:02:04Z', '2 min 4 s'],
    ['2026-10-01T02:00:00Z', '2026-10-01T02:10:00Z', '10 min'],
    ['2026-10-01T02:00:00Z', '2026-10-01T03:05:59Z', '1 h 5 min'],
    ['2026-10-01T02:00:00Z', '2026-10-01T04:00:00Z', '2 h'],
    ['2026-09-29T02:00:00Z', '2026-10-01T05:00:00Z', '2 d 3 h'],
  ])('%s -> %s is %s', (start, end, expected) => {
    expect(formatEmailDuration(start, end)).toBe(expected);
  });

  it('returns undefined for a negative span or an invalid input, so the caller omits the row', () => {
    expect(formatEmailDuration('2026-10-01T02:00:10Z', '2026-10-01T02:00:00Z')).toBeUndefined();
    expect(formatEmailDuration('nope', '2026-10-01T02:00:00Z')).toBeUndefined();
  });
});

describe('templates outside the operational set use the shared formatter', () => {
  it('role-changed shows the human timestamp in both parts and the preheader', () => {
    const out = roleChangedEmail({
      recipientEmail: 'a@example.com',
      previousRoles: ['viewer'],
      currentRoles: ['admin'],
      changedAt: new Date('2026-10-01T09:42:17.000Z'),
    });

    expect(out.text).toMatch(/Changed at:\s+1 Oct 2026, 09:42 UTC/);
    expect(out.html).toContain('changed at 1 Oct 2026, 09:42 UTC.');
    expect(out.html).toContain('<time datetime="2026-10-01T09:42:17.000Z"');
    expect(out.text).not.toContain('2026-10-01T');
  });

  it('test-email keeps seconds in the subject so two sends a few seconds apart do not thread together', () => {
    const first = testEmail({
      recipientEmail: 'a@example.com',
      providerKind: 'smtp',
      sentAt: new Date('2026-10-01T14:05:09.000Z'),
    });
    const second = testEmail({
      recipientEmail: 'a@example.com',
      providerKind: 'smtp',
      sentAt: new Date('2026-10-01T14:05:41.000Z'),
    });

    expect(first.subject).toContain('(1 Oct 2026, 14:05:09 UTC)');
    expect(first.subject).not.toBe(second.subject);
    expect(first.text).toMatch(/Sent at:\s+1 Oct 2026, 14:05 UTC/);
  });
});
