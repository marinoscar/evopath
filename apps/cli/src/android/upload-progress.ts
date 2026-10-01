// =============================================================================
// Upload progress for `fetch`  (issue #291)
// =============================================================================
//
// `fetch` reports nothing while it sends a body, and an APK upload can take
// minutes. This wraps a fetch so a MULTIPART request body is re-expressed as
// the same bytes flowing through a counting stream: `new Request(url, init)`
// serialises the FormData (boundary and content type included) as a stream
// that still reads the file lazily from disk, so nothing is buffered.
//
// Only FormData bodies are wrapped; every other request goes through
// untouched. The streamed form is sent chunked (no Content-Length), which
// every HTTP/1.1 server and nginx accept — the CLI's `android publish` does
// not use this wrapper and keeps sending a sized body.
// =============================================================================

export type UploadProgressFn = (sentBytes: number) => void;

export function withUploadProgress(
  baseFetch: typeof globalThis.fetch,
  onProgress: UploadProgressFn,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (!(init?.body instanceof FormData)) return await baseFetch(input, init);

    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? 'POST';
    // Serialise once; keep the signal OFF this Request so aborting the real
    // one is what cancels the upload.
    const serialised = new Request(url, { method, body: init.body, ...(init.headers === undefined ? {} : { headers: init.headers }) });
    const source = serialised.body;
    if (source === null) return await baseFetch(input, init);

    let sent = 0;
    onProgress(0);
    const counted = source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          sent += chunk.byteLength;
          onProgress(sent);
          controller.enqueue(chunk);
        },
      }),
    );

    const forwarded: RequestInit & { duplex: 'half' } = {
      method,
      headers: serialised.headers,
      body: counted,
      duplex: 'half',
      ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
    };
    return await baseFetch(url, forwarded);
  };
}
