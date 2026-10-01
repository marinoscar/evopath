import {
  TRANSACTIONAL_EMAIL_HEADERS,
  composeEmailMessage,
  type RenderedEmail,
} from './email-template.types';
import { layoutAttachments } from './layout';

// =============================================================================
// composeEmailMessage — the one place a RenderedEmail becomes an EmailMessage
// (issue #237). A hand-copy of fields is how the inline brand mark would be
// dropped at one call site, so the contract is pinned here.
// =============================================================================

function rendered(overrides: Partial<RenderedEmail> = {}): RenderedEmail {
  return {
    subject: 'Hello',
    html: '<p>Hello <img src="cid:brand-mark" alt="" /></p>',
    text: 'Hello',
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
    attachments: layoutAttachments(),
    ...overrides,
  };
}

const envelope = { to: 'user@example.com', from: 'App <no-reply@example.com>' };

describe('composeEmailMessage', () => {
  it('carries subject, html, text and the envelope across', () => {
    const message = composeEmailMessage(rendered(), envelope);

    expect(message).toMatchObject({
      subject: 'Hello',
      html: '<p>Hello <img src="cid:brand-mark" alt="" /></p>',
      text: 'Hello',
      to: envelope.to,
      from: envelope.from,
    });
  });

  it('carries the inline attachments across, equal in content', () => {
    const source = rendered();
    const message = composeEmailMessage(source, envelope);

    expect(message.attachments).toEqual(source.attachments);
    expect(message.attachments?.[0]).toMatchObject({
      contentId: 'brand-mark',
      disposition: 'inline',
      contentType: 'image/png',
    });
    expect(message.attachments?.[0].contentBase64.length).toBeGreaterThan(0);
  });

  it('carries the headers across, equal in content', () => {
    const source = rendered();
    const message = composeEmailMessage(source, envelope);

    expect(message.headers).toEqual(source.headers);
  });

  it('copies attachments and headers, so decorating one message cannot leak into the source', () => {
    const source = rendered();
    const message = composeEmailMessage(source, envelope);

    expect(message.attachments).not.toBe(source.attachments);
    expect(message.attachments?.[0]).not.toBe(source.attachments[0]);
    expect(message.headers).not.toBe(source.headers);

    message.headers!['List-Unsubscribe'] = '<mailto:x@example.com>';
    message.attachments![0].filename = 'changed.png';

    expect(source.headers).not.toHaveProperty('List-Unsubscribe');
    expect(source.attachments[0].filename).not.toBe('changed.png');
  });

  it('omits headers when the template set none', () => {
    const message = composeEmailMessage(rendered({ headers: undefined }), envelope);

    expect(message).not.toHaveProperty('headers');
  });

  it('omits attachments when there are none', () => {
    const message = composeEmailMessage(rendered({ attachments: [] }), envelope);

    expect(message).not.toHaveProperty('attachments');
  });

  it('takes the envelope from the argument, never from the rendered value', () => {
    const sneaky = { ...rendered(), to: 'attacker@evil.example' } as RenderedEmail;
    const message = composeEmailMessage(sneaky, envelope);

    expect(message.to).toBe(envelope.to);
  });
});
