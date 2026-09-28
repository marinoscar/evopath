import configuration from './configuration';

// =============================================================================
// `ALLOWED_MIME_TYPES` / `MAX_FILE_SIZE` parsing (#519)
// =============================================================================
//
// The parsing itself lives inline in the default-exported factory rather than
// as a separately named export, so this drives that factory directly (as
// `ConfigModule.forRoot({ load: [configuration] })` does) and reads the
// `storage` slice of its result. Every other key on the returned object is
// exercised elsewhere (or not at all); this file only owns `storage`.
// =============================================================================

describe('configuration() — storage.allowedMimeTypes / storage.maxFileSize (#519)', () => {
  const ENV_KEYS = ['ALLOWED_MIME_TYPES', 'MAX_FILE_SIZE'] as const;
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    saved = {
      ALLOWED_MIME_TYPES: process.env.ALLOWED_MIME_TYPES,
      MAX_FILE_SIZE: process.env.MAX_FILE_SIZE,
    };
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('ALLOWED_MIME_TYPES', () => {
    it('is an empty array — "allow every type" — when unset', () => {
      delete process.env.ALLOWED_MIME_TYPES;

      expect(configuration().storage.allowedMimeTypes).toEqual([]);
    });

    it('is an empty array when set to the empty string', () => {
      process.env.ALLOWED_MIME_TYPES = '';

      expect(configuration().storage.allowedMimeTypes).toEqual([]);
    });

    it('splits a comma-separated list', () => {
      process.env.ALLOWED_MIME_TYPES = 'application/pdf,image/*,video/mp4';

      expect(configuration().storage.allowedMimeTypes).toEqual([
        'application/pdf',
        'image/*',
        'video/mp4',
      ]);
    });

    it('trims whitespace around each entry', () => {
      process.env.ALLOWED_MIME_TYPES = ' application/pdf , image/*  ,video/mp4 ';

      expect(configuration().storage.allowedMimeTypes).toEqual([
        'application/pdf',
        'image/*',
        'video/mp4',
      ]);
    });

    it('lower-cases each entry', () => {
      process.env.ALLOWED_MIME_TYPES = 'APPLICATION/PDF,Image/*';

      expect(configuration().storage.allowedMimeTypes).toEqual([
        'application/pdf',
        'image/*',
      ]);
    });

    it('drops entries left empty after trimming (e.g. a trailing comma)', () => {
      process.env.ALLOWED_MIME_TYPES = 'application/pdf,, ,image/*,';

      expect(configuration().storage.allowedMimeTypes).toEqual([
        'application/pdf',
        'image/*',
      ]);
    });
  });

  describe('MAX_FILE_SIZE', () => {
    it('defaults to 10GB when unset', () => {
      delete process.env.MAX_FILE_SIZE;

      expect(configuration().storage.maxFileSize).toBe(10737418240);
    });

    it('parses a configured value', () => {
      process.env.MAX_FILE_SIZE = '1048576';

      expect(configuration().storage.maxFileSize).toBe(1048576);
    });
  });
});
