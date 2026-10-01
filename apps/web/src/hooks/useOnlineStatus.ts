/**
 * `navigator.onLine`, kept current by the `online` / `offline` events (E7.8,
 * #248). A hint only: `true` does not promise the API is reachable, but
 * `false` reliably means a send would fail, so the coach composer disables
 * itself and says why.
 */
import { useEffect, useState } from 'react';

function current(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(current);

  useEffect(() => {
    const update = () => setOnline(current());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}
