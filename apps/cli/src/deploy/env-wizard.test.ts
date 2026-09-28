import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { parseEnvExample } from './env-spec.js';
import { runEnvWizard } from './env-wizard.js';

// Same scripted terminal as prompt.test.ts: an answer is supplied only when
// something is actually waiting for one, because readline drops buffered lines
// that no question has claimed.
class FakeInput extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
}

class FakeOutput extends PassThrough {
  isTTY = true;
  readonly chunks: string[] = [];
  onChunk: ((text: string) => void) | undefined;

  override write(chunk: unknown, ...rest: unknown[]): boolean {
    const text = String(chunk);
    this.chunks.push(text);
    this.onChunk?.(text);
    return super.write(chunk as never, ...(rest as []));
  }

  text(): string {
    return this.chunks.join('');
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

function terminal(answers: readonly string[]): {
  ctx: { input: NodeJS.ReadStream; output: NodeJS.WriteStream };
  output: FakeOutput;
  remaining: () => number;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  const queue = [...answers];

  output.onChunk = (text: string): void => {
    const visible = text.replace(ANSI, '');
    if (visible === '' || visible.endsWith('\n') || !visible.endsWith(' ')) return;
    const answer = queue.shift();
    if (answer === undefined) return;
    setImmediate(() => input.write(`${answer}\n`));
  };

  return {
    ctx: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    output,
    remaining: () => queue.length,
  };
}

/** A template small enough that the answer sequence stays readable. */
const TEMPLATE = [
  '# ------------------------------------------------------------',
  '# Application',
  '# ------------------------------------------------------------',
  'NODE_ENV=development',
  'APP_URL=http://localhost:3535',
  'PORT=3000',
  '',
  '# ------------------------------------------------------------',
  '# Database',
  '# ------------------------------------------------------------',
  '# The database host.',
  'POSTGRES_HOST=localhost',
  'POSTGRES_USER=postgres',
  'POSTGRES_PASSWORD=postgres',
  'POSTGRES_DB=appdb',
  '',
  '# ------------------------------------------------------------',
  '# JWT / Session',
  '# ------------------------------------------------------------',
  'JWT_SECRET=your-super-secret-key-min-32-characters-long',
  '',
  '# ------------------------------------------------------------',
  '# Test Authentication',
  '# ------------------------------------------------------------',
  'TEST_AUTH_ENABLED=false',
  '',
  '# ------------------------------------------------------------',
  '# Email (Amazon SES)',
  '# ------------------------------------------------------------',
  'SES_REGION=us-east-1',
].join('\n');

const SPECS = parseEnvExample(TEMPLATE);

/** Answers for the default (essential-only) run, in prompt order. */
const ESSENTIAL_ANSWERS = [
  'db.example.test', // POSTGRES_HOST
  'appuser', // POSTGRES_USER
  'sup3rs3cret-password', // POSTGRES_PASSWORD (secret)
  'appdb', // POSTGRES_DB
  'y', // JWT_SECRET: generate one?
  'y', // review: write this environment?
];

describe('runEnvWizard', () => {
  it('asks only the essential keys and defaults the rest', async () => {
    const { ctx, output, remaining } = terminal(ESSENTIAL_ANSWERS);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    // Every scripted answer was consumed, so no extra questions were asked.
    expect(remaining()).toBe(0);
    expect(values.get('POSTGRES_HOST')).toBe('db.example.test');
    // PORT was never asked; it took the template default.
    expect(values.get('PORT')).toBe('3000');
    expect(output.text()).not.toContain('PORT [');
  });

  it('forces NODE_ENV to production', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    expect(values.get('NODE_ENV')).toBe('production');
  });

  it('never writes TEST_AUTH_ENABLED', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    // True in production fails startup by design, so it is not carried at all.
    expect(values.has('TEST_AUTH_ENABLED')).toBe(false);
  });

  it('derives APP_URL from the domain instead of asking', async () => {
    const { ctx, output } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    expect(values.get('APP_URL')).toBe('https://app.example.test');
    expect(output.text()).not.toContain('APP_URL [');
  });

  it('generates a secret when offered and accepted', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    const generated = values.get('JWT_SECRET') as string;
    expect(generated).not.toBe('your-super-secret-key-min-32-characters-long');
    expect(generated.length).toBeGreaterThanOrEqual(32);
  });

  it('re-asks on the same key when a value fails validation', async () => {
    const { ctx, output } = terminal([
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      'n', // decline generation for JWT_SECRET
      'too-short', // rejected: under 32 characters
      'a-perfectly-long-replacement-secret-value',
      'y',
    ]);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    expect(output.text()).toContain('JWT_SECRET must be at least 32');
    expect(values.get('JWT_SECRET')).toBe('a-perfectly-long-replacement-secret-value');
  });

  it('skips a group the operator did not opt into', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    expect(values.has('SES_REGION')).toBe(false);
  });

  it('includes a group when asked for it', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      groups: ['email'],
      ctx,
    });

    // Not essential, so it takes the template default rather than prompting.
    expect(values.get('SES_REGION')).toBe('us-east-1');
  });

  it('uses existing values as defaults and does not re-ask for a secret', async () => {
    const existing = new Map([
      ['POSTGRES_PASSWORD', 'already-set-password'],
      ['JWT_SECRET', 'an-existing-secret-of-sufficient-length'],
    ]);

    const { ctx, remaining } = terminal([
      'db.example.test', // POSTGRES_HOST
      'appuser', // POSTGRES_USER
      '', // POSTGRES_PASSWORD: essential, blank keeps the existing value
      'appdb', // POSTGRES_DB
      '', // JWT_SECRET: essential too, so still asked; blank keeps it
      'y', // review
    ]);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      existing,
      ctx,
    });

    // A blank answer keeps what is already there, so a re-run does not force
    // anyone to retype a working password.
    expect(values.get('POSTGRES_PASSWORD')).toBe('already-set-password');
    expect(values.get('JWT_SECRET')).toBe('an-existing-secret-of-sufficient-length');
    // No generation offer: it is only made when there is nothing usable yet.
    expect(remaining()).toBe(0);
  });

  it('carries through a key the template does not know about', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      existing: new Map([['SENTRY_DSN', 'https://example']]),
      ctx,
    });

    // Silently dropping a value someone deliberately set is the worst thing
    // this could do.
    expect(values.get('SENTRY_DSN')).toBe('https://example');
  });

  it('asks about everything under --all', async () => {
    const { ctx, remaining } = terminal([
      '', // APP_URL is derived, so the first question is PORT
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      'n', // decline generation
      'a-perfectly-long-replacement-secret-value',
      'eu-west-1',
      'y', // review
    ]);

    await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      all: true,
      groups: ['email'],
      ctx,
    });

    expect(remaining()).toBe(0);
  });

  it('never shows a secret in the review summary', async () => {
    const { ctx, output } = terminal(ESSENTIAL_ANSWERS);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    const password = values.get('POSTGRES_PASSWORD') as string;
    const jwt = values.get('JWT_SECRET') as string;

    expect(password).toBe('sup3rs3cret-password');
    expect(output.text()).not.toContain(password);
    expect(output.text()).not.toContain(jwt);
    expect(output.text()).toContain('********');
  });

  it('aborts when the review is declined', async () => {
    const { ctx } = terminal([...ESSENTIAL_ANSWERS.slice(0, -1), 'n']);

    await expect(
      runEnvWizard({ specs: SPECS, domain: 'app.example.test', ctx }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('runEnvWizard --non-interactive', () => {
  it('lists every unresolved key at once, not just the first', async () => {
    const error = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: new Map([['POSTGRES_HOST', 'db.example.test']]),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    const message = (error as Error).message;

    // A CI operator learning about these one run at a time is a bad afternoon.
    expect(message).toContain('POSTGRES_USER');
    expect(message).toContain('POSTGRES_DB');
    expect(message).toContain('JWT_SECRET');
    expect(message).not.toContain('POSTGRES_HOST');
  });

  it('rejects a value that is present but still the placeholder', async () => {
    const error = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: new Map([
        ['POSTGRES_HOST', 'db.example.test'],
        ['POSTGRES_USER', 'appuser'],
        ['POSTGRES_PASSWORD', 'pw-that-is-fine'],
        ['POSTGRES_DB', 'appdb'],
        // Straight from .env.example, which is not a configured value.
        ['JWT_SECRET', 'your-super-secret-key-min-32-characters-long'],
      ]),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('JWT_SECRET');
  });

  it('succeeds and prompts for nothing when the environment is complete', async () => {
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: new Map([
        ['POSTGRES_HOST', 'db.example.test'],
        ['POSTGRES_USER', 'appuser'],
        ['POSTGRES_PASSWORD', 'pw-that-is-fine'],
        ['POSTGRES_DB', 'appdb'],
        ['JWT_SECRET', 'a-perfectly-long-replacement-secret-value'],
      ]),
    });

    expect(values.get('NODE_ENV')).toBe('production');
    expect(values.get('APP_URL')).toBe('https://app.example.test');
    expect(values.get('POSTGRES_USER')).toBe('appuser');
  });
});

// =============================================================================
// "SKIPPED" is a third outcome, beside "answered" and "missing" (see the
// wizard's own header comment on the non-interactive path). A declined
// optional variable must not be reported as a missing value, and it must not
// resurrect the template default either - it is deleted outright.
// =============================================================================
describe('runEnvWizard --non-interactive: the `skipped` outcome', () => {
  const ONLY_OPTIONAL_SPECS = parseEnvExample(
    ['# Optional: an analytics DSN a fork might configure later.', '# SENTRY_DSN='].join('\n'),
  );

  // POSTGRES_HOST is essential in ENV_METADATA; SENTRY_DSN has no entry there
  // at all, so it is optional with no `essential` flag - exactly the case the
  // header comment describes.
  const SKIP_AND_ESSENTIAL_SPECS = parseEnvExample(
    [
      '# Optional: an analytics DSN a fork might configure later.',
      '# SENTRY_DSN=',
      'POSTGRES_HOST=localhost',
    ].join('\n'),
  );

  it('deletes a declined optional key rather than falling back to its template default', async () => {
    const { values } = await runEnvWizard({
      specs: ONLY_OPTIONAL_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      all: true,
    });

    // Not merely "unset" - genuinely absent, so the serializer does not write
    // it back in with its (blank) template default.
    expect(values.has('SENTRY_DSN')).toBe(false);
  });

  it('records the skipped row as {display: "(skipped)", source: "skipped"}', async () => {
    const { summary } = await runEnvWizard({
      specs: ONLY_OPTIONAL_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      all: true,
    });

    expect(summary).toContainEqual({
      key: 'SENTRY_DSN',
      display: '(skipped)',
      source: 'skipped',
    });
  });

  it('does not report a declined optional key as missing', async () => {
    // Before the fix, an absent optional variable was read as "missing" and
    // failed the whole run - for a variable nobody wanted in the first place.
    await expect(
      runEnvWizard({
        specs: ONLY_OPTIONAL_SPECS,
        domain: 'app.example.test',
        nonInteractive: true,
        all: true,
      }),
    ).resolves.toBeDefined();
  });

  it('does not let a skipped optional key mask a genuinely missing essential one', async () => {
    const error = await runEnvWizard({
      specs: SKIP_AND_ESSENTIAL_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      all: true,
    }).catch((caught: unknown) => caught);

    // POSTGRES_HOST is essential and blank: it must still land in the
    // unresolved list, whatever else in the same run was legitimately skipped.
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('POSTGRES_HOST');
  });
});

// =============================================================================
// GreptimeDB passwords are generated, never asked  (issue #567)
// =============================================================================

const GREPTIME_TEMPLATE = [
  '# ------------------------------------------------------------',
  '# Telemetry store',
  '# ------------------------------------------------------------',
  'GREPTIME_WRITER_USER=writer',
  'GREPTIME_WRITER_PASSWORD=change-me-writer',
  'GREPTIME_READER_USER=reader',
  'GREPTIME_READER_PASSWORD=change-me-reader',
  'GREPTIME_ADMIN_USER=admin',
  'GREPTIME_ADMIN_PASSWORD=change-me-admin',
].join('\n');

const GREPTIME_SPECS = parseEnvExample(GREPTIME_TEMPLATE);
const PASSWORD_KEYS = [
  'GREPTIME_WRITER_PASSWORD',
  'GREPTIME_READER_PASSWORD',
  'GREPTIME_ADMIN_PASSWORD',
] as const;

describe('runEnvWizard: auto-generated GreptimeDB passwords (#567)', () => {
  it('generates all three without prompting on an unattended run', async () => {
    const { values, summary } = await runEnvWizard({
      specs: GREPTIME_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      groups: ['observability'],
    });

    const generated = PASSWORD_KEYS.map((key) => values.get(key) as string);
    for (const value of generated) {
      // Embedded in `user=password,user2=password2`: none of `,` `=` `:`.
      expect(value).toMatch(/^[0-9a-f]{64}$/);
      expect(value).not.toMatch(/[,=:]/);
    }
    // Three independent draws, never one value reused.
    expect(new Set(generated).size).toBe(3);
    // Never echoed: the summary masks them.
    for (const key of PASSWORD_KEYS) {
      expect(summary.find((row) => row.key === key)).toMatchObject({
        display: '********',
        source: 'generated',
      });
    }
  });

  it('generates them on an interactive run without asking anything but the review', async () => {
    const { ctx, output, remaining } = terminal(['y']); // review only
    const { values } = await runEnvWizard({
      specs: GREPTIME_SPECS,
      domain: 'app.example.test',
      groups: ['observability'],
      ctx,
    });

    expect(remaining()).toBe(0);
    expect(output.text()).not.toContain('Generate one?');
    expect(output.text()).not.toMatch(/GREPTIME_\w+_PASSWORD[^\n]*: $/m);
    for (const key of PASSWORD_KEYS) {
      const value = values.get(key) as string;
      expect(value).toMatch(/^[0-9a-f]{64}$/);
      // The secret itself never reaches the terminal.
      expect(output.text()).not.toContain(value);
    }
  });

  it('keeps an existing real password and replaces placeholders and blanks', async () => {
    const { values, summary } = await runEnvWizard({
      specs: GREPTIME_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      groups: ['observability'],
      existing: new Map([
        ['GREPTIME_WRITER_PASSWORD', 'an-operator-chosen-writer-secret'],
        ['GREPTIME_READER_PASSWORD', 'change-me-reader'],
        ['GREPTIME_ADMIN_PASSWORD', ''],
      ]),
    });

    expect(values.get('GREPTIME_WRITER_PASSWORD')).toBe('an-operator-chosen-writer-secret');
    expect(summary.find((row) => row.key === 'GREPTIME_WRITER_PASSWORD')?.source).toBe('existing');
    expect(values.get('GREPTIME_READER_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
    expect(values.get('GREPTIME_ADMIN_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still leaves them alone when the group is not enabled', async () => {
    const { values } = await runEnvWizard({
      specs: GREPTIME_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
    });

    for (const key of PASSWORD_KEYS) expect(values.has(key)).toBe(false);
  });
});
