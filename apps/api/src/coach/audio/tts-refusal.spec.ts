import { classifySpeechRun, COACH_MIN_SPEECH_BYTES, isTtsRefusal } from './tts-refusal';

// =============================================================================
// Speech-run classification and refusal detection (E7.6, #246)
// =============================================================================

const OBJECT = '00000000-0000-4000-8000-0000000000c1';

function speech(overrides: Record<string, unknown> = {}) {
  return {
    status: 'succeeded',
    output: {
      type: 'speech',
      storageObjectId: OBJECT,
      mimeType: 'audio/mpeg',
      size: 24_000,
      voice: 'onyx',
      ...overrides,
    },
    errorCode: null,
    errorMessage: null,
  };
}

describe('classifySpeechRun', () => {
  it('a succeeded run with real audio is ready, carrying the object and voice', () => {
    expect(classifySpeechRun(speech(), { cause: 'settled' })).toEqual({
      kind: 'ready',
      storageObjectId: OBJECT,
      voice: 'onyx',
      mimeType: 'audio/mpeg',
      size: 24_000,
    });
  });

  it.each([
    ['empty audio', { size: 0 }],
    ['a tiny stub', { size: COACH_MIN_SPEECH_BYTES - 1 }],
  ])('%s is a refusal', (_label, overrides) => {
    expect(classifySpeechRun(speech(overrides), { cause: 'settled' })).toMatchObject({ kind: 'failed', reason: 'refusal' });
  });

  it.each([
    ['no output', null],
    ['not a speech output', { type: 'images' }],
    ['a non-audio mime type', { type: 'speech', storageObjectId: OBJECT, mimeType: 'text/plain', size: 5000 }],
    ['no storage object', { type: 'speech', mimeType: 'audio/mpeg', size: 5000 }],
  ])('a succeeded run with %s is a provider error', (_label, output) => {
    expect(
      classifySpeechRun({ status: 'succeeded', output, errorCode: null, errorMessage: null }, { cause: 'settled' }),
    ).toMatchObject({ kind: 'failed', reason: 'provider_error' });
  });

  it('a failed run with a content-filter code or refusal wording is a refusal', () => {
    expect(
      classifySpeechRun({ status: 'failed', output: null, errorCode: 'AI_CONTENT_FILTERED', errorMessage: null }, { cause: 'settled' }),
    ).toEqual({ kind: 'failed', reason: 'refusal', code: 'AI_CONTENT_FILTERED' });
    expect(
      classifySpeechRun(
        { status: 'failed', output: null, errorCode: 'AI_INVALID_REQUEST', errorMessage: 'The model refused this input.' },
        { cause: 'settled' },
      ),
    ).toMatchObject({ kind: 'failed', reason: 'refusal' });
  });

  it('any other failure is a provider error', () => {
    expect(
      classifySpeechRun(
        { status: 'failed', output: null, errorCode: 'AI_PROVIDER_UNAVAILABLE', errorMessage: 'upstream 503' },
        { cause: 'settled' },
      ),
    ).toEqual({ kind: 'failed', reason: 'provider_error', code: 'AI_PROVIDER_UNAVAILABLE' });
  });

  it('no run at all is a provider error', () => {
    expect(classifySpeechRun(null, { cause: 'settled' })).toMatchObject({ kind: 'failed', reason: 'provider_error' });
  });

  it('a still-active run waits on a settle event but times out at the cap', () => {
    const active = { status: 'running', output: null, errorCode: null, errorMessage: null };
    expect(classifySpeechRun(active, { cause: 'settled' })).toEqual({ kind: 'wait' });
    expect(classifySpeechRun(active, { cause: 'settled', jobSucceeded: false })).toMatchObject({ reason: 'provider_error' });
    expect(classifySpeechRun(active, { cause: 'timeout' })).toMatchObject({ kind: 'failed', reason: 'timeout' });
  });

  it('a cancelled run is a timeout at the cap, a provider error otherwise', () => {
    const cancelled = { status: 'cancelled', output: null, errorCode: null, errorMessage: null };
    expect(classifySpeechRun(cancelled, { cause: 'timeout' })).toMatchObject({ reason: 'timeout' });
    expect(classifySpeechRun(cancelled, { cause: 'settled' })).toMatchObject({ reason: 'provider_error' });
  });
});

describe('isTtsRefusal', () => {
  it.each([
    ['AI_CONTENT_FILTERED', null, true],
    [null, 'Request declined by the safety system', true],
    [null, 'This content violates our content policy', true],
    [null, "I can't help with that", true],
    ['AI_PROVIDER_UNAVAILABLE', 'socket hang up', false],
    [null, null, false],
  ])('code %s / message %s -> %s', (code, message, expected) => {
    expect(isTtsRefusal(code, message)).toBe(expected);
  });
});
