import {
  buildCorsOptions,
  InvalidCorsOriginError,
  isSameOriginOnly,
} from './cors-options';

// =============================================================================
// buildCorsOptions — tests (issue #517)
// =============================================================================
//
// `buildCorsOptions` is pure (no process.env, no logging — see the header
// comment on the module under test), so every case here just calls it with a
// raw string and asserts on the returned options. No env mocking, no module
// reset.
// =============================================================================

describe('buildCorsOptions', () => {
  describe('same-origin (no CORS headers)', () => {
    it('returns { origin: false } for undefined', () => {
      const options = buildCorsOptions(undefined);
      expect(options).toEqual({ origin: false });
      expect(isSameOriginOnly(options)).toBe(true);
    });

    it('returns { origin: false } for an empty string', () => {
      expect(buildCorsOptions('')).toEqual({ origin: false });
    });

    it('returns { origin: false } for whitespace-only input', () => {
      expect(buildCorsOptions('   ')).toEqual({ origin: false });
    });

    it('returns { origin: false } for commas with no real entries', () => {
      expect(buildCorsOptions(' , , ')).toEqual({ origin: false });
    });
  });

  describe('allowlist', () => {
    it('accepts a single origin, with credentials true', () => {
      const options = buildCorsOptions('https://app.example.com');
      expect(options).toEqual({
        origin: ['https://app.example.com'],
        credentials: true,
      });
      expect(isSameOriginOnly(options)).toBe(false);
    });

    it('accepts multiple origins, trimming surrounding whitespace', () => {
      const options = buildCorsOptions(
        ' https://a.example , https://b.example ',
      );
      expect(options).toEqual({
        origin: ['https://a.example', 'https://b.example'],
        credentials: true,
      });
    });

    it('collapses duplicates, keeping first-seen order', () => {
      const options = buildCorsOptions(
        'https://a.example,https://b.example,https://a.example',
      );
      expect(options).toEqual({
        origin: ['https://a.example', 'https://b.example'],
        credentials: true,
      });
    });

    it('sets credentials: true only when a list is actually set', () => {
      expect(buildCorsOptions(undefined)).not.toHaveProperty('credentials');
      const withList = buildCorsOptions('https://app.example.com');
      expect(withList).toHaveProperty('credentials', true);
    });
  });

  describe('rejections', () => {
    it.each([
      ['a bare wildcard', '*'],
      ['a wildcard subdomain', 'https://*.example.com'],
      ['a trailing slash', 'https://app.example.com/'],
      ['a path', 'https://app.example.com/callback'],
      ['an uppercase host', 'https://App.example.com'],
      ['a default port spelled out on https', 'https://app.example.com:443'],
      ['a non-http(s) scheme', 'ftp://app.example.com'],
    ])('throws for %s (%s)', (_label, entry) => {
      expect(() => buildCorsOptions(entry)).toThrow(InvalidCorsOriginError);
    });

    it('throws when the wildcard is buried among otherwise-valid entries', () => {
      expect(() =>
        buildCorsOptions('https://a.example,*,https://b.example'),
      ).toThrow(InvalidCorsOriginError);
    });

    it('throws on a value that is not a URL at all', () => {
      expect(() => buildCorsOptions('not-a-url')).toThrow(
        InvalidCorsOriginError,
      );
    });

    it('throws on a default http port spelled out explicitly', () => {
      expect(() => buildCorsOptions('http://app.example.com:80')).toThrow(
        InvalidCorsOriginError,
      );
    });
  });
});

describe('isSameOriginOnly', () => {
  it('is true only for { origin: false }', () => {
    expect(isSameOriginOnly({ origin: false })).toBe(true);
    expect(
      isSameOriginOnly({
        origin: ['https://app.example.com'],
        credentials: true,
      }),
    ).toBe(false);
  });
});
