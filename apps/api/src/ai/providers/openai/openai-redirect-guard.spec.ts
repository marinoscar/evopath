import { noRedirectFetch, REDIRECT_REFUSED_CODE } from './openai-redirect-guard';

describe('noRedirectFetch (#448)', () => {
  it('sends every request with redirect: manual and passes a non-redirect through untouched', async () => {
    const answer = new Response('{"ok":true}', { status: 200 });
    const inner = jest.fn(async () => answer);
    const guarded = noRedirectFetch(inner);

    await expect(guarded('https://h.example/v1/models', { method: 'GET', headers: { a: 'b' } })).resolves.toBe(answer);
    expect(inner).toHaveBeenCalledWith('https://h.example/v1/models', { method: 'GET', headers: { a: 'b' }, redirect: 'manual' });
  });

  it.each([301, 302, 303, 307, 308])('replaces a %i with a refusal that names no Location', async (status) => {
    const guarded = noRedirectFetch(async () =>
      new Response('moved', { status, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    );

    const response = await guarded('https://h.example/v1/chat/completions', { method: 'POST' });
    const body = await response.text();

    expect(response.status).toBe(status);
    expect(response.headers.get('location')).toBeNull();
    expect(JSON.parse(body).error.code).toBe(REDIRECT_REFUSED_CODE);
    expect(body).not.toContain('169.254');
  });

  it('treats an opaque redirect as a refusal too', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, body: null } as unknown as Response;
    const response = await noRedirectFetch(async () => opaque)('https://h.example/v1/models');

    expect(response.status).toBe(310);
    expect((await response.json()).error.code).toBe(REDIRECT_REFUSED_CODE);
  });

  it('leaves errors (4xx/5xx) to the SDK', async () => {
    const answer = new Response('{}', { status: 404 });

    await expect(noRedirectFetch(async () => answer)('https://h.example/v1/x')).resolves.toBe(answer);
  });
});
