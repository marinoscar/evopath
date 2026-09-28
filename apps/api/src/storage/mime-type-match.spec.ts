import { mimeTypeMatches, normaliseMimeType } from './mime-type-match';

describe('normaliseMimeType', () => {
  it('lower-cases the type', () => {
    expect(normaliseMimeType('IMAGE/PNG')).toBe('image/png');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseMimeType('  application/pdf  ')).toBe('application/pdf');
  });

  it('drops parameters after the first semicolon', () => {
    expect(normaliseMimeType('text/plain; charset=utf-8')).toBe('text/plain');
  });

  it('trims whitespace left after dropping parameters', () => {
    expect(normaliseMimeType('text/html ; charset=utf-8')).toBe('text/html');
  });

  it('lower-cases and drops parameters together', () => {
    expect(normaliseMimeType('  Text/HTML; charset=UTF-8  ')).toBe('text/html');
  });
});

describe('mimeTypeMatches', () => {
  describe('exact types', () => {
    it('matches an exact entry', () => {
      expect(mimeTypeMatches('application/pdf', ['application/pdf'])).toBe(true);
    });

    it('does not match a different exact type', () => {
      expect(mimeTypeMatches('application/pdf', ['application/json'])).toBe(false);
    });

    it('does not match a different subtype of the same top-level type', () => {
      expect(mimeTypeMatches('image/png', ['image/jpeg'])).toBe(false);
    });

    it('matches when one of several entries is exact', () => {
      expect(mimeTypeMatches('text/csv', ['application/pdf', 'text/csv', 'image/png'])).toBe(true);
    });
  });

  describe('type/* wildcards', () => {
    it('matches any subtype of the wildcarded type', () => {
      expect(mimeTypeMatches('image/png', ['image/*'])).toBe(true);
      expect(mimeTypeMatches('image/jpeg', ['image/*'])).toBe(true);
      expect(mimeTypeMatches('image/svg+xml', ['image/*'])).toBe(true);
    });

    it('does not match a different top-level type', () => {
      expect(mimeTypeMatches('video/mp4', ['image/*'])).toBe(false);
    });

    it('does not match the bare type with no subtype', () => {
      expect(mimeTypeMatches('image/', ['image/*'])).toBe(false);
    });

    it('does not match the wildcarded type name itself without a subtype', () => {
      expect(mimeTypeMatches('image', ['image/*'])).toBe(false);
    });

    it('does not treat the wildcard as a substring match across type boundaries', () => {
      // "imagex/png" must not match "image/*" merely because it starts with "image".
      expect(mimeTypeMatches('imagex/png', ['image/*'])).toBe(false);
    });
  });

  describe('case-insensitivity', () => {
    it('matches regardless of the allowlist entry casing', () => {
      expect(mimeTypeMatches('application/pdf', ['APPLICATION/PDF'])).toBe(true);
    });

    it('matches a wildcard entry regardless of casing', () => {
      expect(mimeTypeMatches('image/png', ['IMAGE/*'])).toBe(true);
    });

    it('normalises allowlist entries that carry parameters or whitespace', () => {
      expect(mimeTypeMatches('text/plain', [' Text/Plain ; charset=utf-8 '])).toBe(true);
    });
  });

  describe('empty allowlist', () => {
    it('matches nothing — an empty allowlist is not "allow all" at this layer', () => {
      expect(mimeTypeMatches('application/pdf', [])).toBe(false);
      expect(mimeTypeMatches('anything/whatever', [])).toBe(false);
    });
  });

  describe('non-matching input', () => {
    it('returns false when no entry matches', () => {
      expect(mimeTypeMatches('application/zip', ['image/*', 'application/pdf'])).toBe(false);
    });
  });

  describe('malformed input', () => {
    it('does not match a type with no slash against any entry', () => {
      expect(mimeTypeMatches('notamimetype', ['application/pdf', 'image/*'])).toBe(false);
    });

    it('matches a malformed type only via an exact entry that names it literally', () => {
      expect(mimeTypeMatches('notamimetype', ['notamimetype'])).toBe(true);
    });

    it('treats a bare "*/*" entry literally rather than as an allow-all wildcard', () => {
      // "*/*" is itself a type/* wildcard whose "type" is "*", so it only
      // matches subtypes of a literal "*" top-level type — not everything.
      expect(mimeTypeMatches('image/png', ['*/*'])).toBe(false);
      expect(mimeTypeMatches('*/png', ['*/*'])).toBe(true);
    });

    it('ignores an empty-string entry', () => {
      expect(mimeTypeMatches('application/pdf', ['', 'application/pdf'])).toBe(true);
      expect(mimeTypeMatches('application/pdf', [''])).toBe(false);
    });
  });
});
