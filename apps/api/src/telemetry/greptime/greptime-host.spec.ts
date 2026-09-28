import {
  checkHostResolves,
  DNS_ERROR_CODES,
  GREPTIME_DNS_TIMEOUT_MS,
  hostNotFoundMessage,
  isDnsError,
  type HostLookup,
} from './greptime-host';

// =============================================================================
// greptime-host — tests (issue #564, epic #528)
// =============================================================================
//
// `checkHostResolves` never throws, and returns `null` (nothing to report)
// whenever the check is inconclusive: an IP literal, a blank host, a
// successful lookup, a non-DNS error, or a lookup that outran its timeout.
// =============================================================================

function dnsError(code: string, message = `getaddrinfo ${code} some-host`): Error {
  return Object.assign(new Error(message), { code });
}

describe('checkHostResolves', () => {
  it('returns null when the lookup resolves', async () => {
    const lookup: HostLookup = jest.fn().mockResolvedValue({ address: '10.0.0.1', family: 4 });

    await expect(checkHostResolves('greptimedb', lookup)).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledWith('greptimedb');
  });

  it('returns null for an IPv4 literal without calling lookup', async () => {
    const lookup = jest.fn();

    await expect(checkHostResolves('127.0.0.1', lookup)).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns null for an IPv6 literal without calling lookup', async () => {
    const lookup = jest.fn();

    await expect(checkHostResolves('::1', lookup)).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns null for an empty host without calling lookup', async () => {
    const lookup = jest.fn();

    await expect(checkHostResolves('', lookup)).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([...DNS_ERROR_CODES])('reports the host-not-found message for %s', async (code) => {
    const lookup: HostLookup = jest.fn().mockRejectedValue(dnsError(code));

    const message = await checkHostResolves('greptimedb', lookup);

    expect(message).toContain('greptimedb');
    expect(message).toContain('could not be resolved');
  });

  it('threads the automatic host mode through to the message', async () => {
    const lookup: HostLookup = jest.fn().mockRejectedValue(dnsError('EAI_AGAIN'));

    const automatic = await checkHostResolves('greptimedb', lookup, undefined, { automatic: true });
    const custom = await checkHostResolves('greptimedb', lookup, undefined, { automatic: false });

    expect(automatic).toBe(hostNotFoundMessage('greptimedb', dnsError('EAI_AGAIN'), { automatic: true }));
    expect(automatic).toContain('Deploy GreptimeDB');
    expect(custom).toBe(hostNotFoundMessage('greptimedb', dnsError('EAI_AGAIN')));
  });

  it('returns null for a non-DNS rejection', async () => {
    const lookup: HostLookup = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(checkHostResolves('greptimedb', lookup)).resolves.toBeNull();
  });

  it('returns null (inconclusive) when the lookup is slower than the timeout', async () => {
    jest.useFakeTimers();
    try {
      let rejectLookup: (error: unknown) => void = () => undefined;
      const lookup: HostLookup = jest.fn(
        () =>
          new Promise((_, reject) => {
            rejectLookup = reject;
          }),
      );

      const pending = checkHostResolves('greptimedb', lookup, 50);
      const assertion = expect(pending).resolves.toBeNull();

      await jest.advanceTimersByTimeAsync(50);
      await assertion;

      // The lookup eventually rejects after the timeout already won; that must
      // not surface as an unhandled rejection.
      rejectLookup(dnsError('ENOTFOUND'));
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  it('handles a lookup that throws synchronously as a DNS verdict', async () => {
    const lookup: HostLookup = jest.fn(() => {
      throw dnsError('EAI_AGAIN');
    });

    const message = await checkHostResolves('greptimedb', lookup);

    expect(message).toContain('greptimedb');
  });

  it('handles a synchronous throw for a non-DNS error as inconclusive', async () => {
    const lookup: HostLookup = jest.fn(() => {
      throw new Error('boom');
    });

    await expect(checkHostResolves('greptimedb', lookup)).resolves.toBeNull();
  });

  it('defaults to GREPTIME_DNS_TIMEOUT_MS when no timeout is given', () => {
    expect(GREPTIME_DNS_TIMEOUT_MS).toBeGreaterThan(5_000);
  });
});

describe('isDnsError', () => {
  it.each([...DNS_ERROR_CODES])('is true for code %s', (code) => {
    expect(isDnsError(dnsError(code))).toBe(true);
  });

  it('is false for a non-DNS code', () => {
    expect(isDnsError(Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }))).toBe(false);
  });

  it('is false for an error with no code', () => {
    expect(isDnsError(new Error('nope'))).toBe(false);
  });

  it('is false for null, undefined and non-objects', () => {
    expect(isDnsError(null)).toBe(false);
    expect(isDnsError(undefined)).toBe(false);
    expect(isDnsError('EAI_AGAIN')).toBe(false);
    expect(isDnsError(42)).toBe(false);
  });
});

describe('hostNotFoundMessage', () => {
  // Shown to administrators: never a compose file, a file edit or the CLI.
  const OPERATOR_INSTRUCTIONS = /compose|\.ya?ml|appctl|\.env|docker|\bCLI\b/i;

  describe('a custom host', () => {
    const message = hostNotFoundMessage('candidate-host', dnsError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN candidate-host'));

    it('names the host and keeps the driver detail in parentheses', () => {
      expect(message).toContain('"candidate-host"');
      expect(message).toContain('(getaddrinfo EAI_AGAIN candidate-host)');
    });

    it('says to check the host, or clear it for the deployed GreptimeDB', () => {
      expect(message).toBe(
        'GreptimeDB host "candidate-host" could not be resolved (getaddrinfo EAI_AGAIN candidate-host): ' +
          'no host by that name exists on this network. ' +
          'Check the host name, or clear it to use the GreptimeDB deployed with this application.',
      );
    });

    it('is the default when no mode is given, and for automatic: false', () => {
      const error = dnsError('ENOTFOUND', 'x');

      expect(hostNotFoundMessage('h', error)).toBe(hostNotFoundMessage('h', error, { automatic: false }));
    });

    it('carries no operator instructions', () => {
      expect(message).not.toMatch(OPERATOR_INSTRUCTIONS);
    });
  });

  describe('the automatic host', () => {
    const message = hostNotFoundMessage('greptimedb', dnsError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN greptimedb'), {
      automatic: true,
    });

    it('names the built-in host and keeps the driver detail in parentheses', () => {
      expect(message).toContain('"greptimedb"');
      expect(message).toContain('(getaddrinfo EAI_AGAIN greptimedb)');
    });

    it('says GreptimeDB ships with the application and points at "Deploy GreptimeDB" on this page', () => {
      expect(message).toMatch(/^GreptimeDB is not running alongside this application/);
      expect(message).toContain('its container is not running');
      expect(message).toContain('Use "Deploy GreptimeDB" in the Telemetry services section of this page to start it.');
      expect(message).not.toContain('next application update');
      expect(message).not.toContain('Check the host name');
    });

    it('carries no operator instructions', () => {
      expect(message).not.toMatch(OPERATOR_INSTRUCTIONS);
    });
  });

  it('stringifies a non-Error rejection', () => {
    expect(hostNotFoundMessage('candidate-host', 'raw string error')).toContain('(raw string error)');
    expect(hostNotFoundMessage('greptimedb', 'raw string error', { automatic: true })).toContain('(raw string error)');
  });
});
