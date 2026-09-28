import type { DeployInfoInput } from './deploy-info.js';
import type { runCommand as defaultRunCommand } from './executor.js';
import { certificateExpiry } from './proxy.js';
import type { DeployProxyFacts } from './state.js';

// =============================================================================
// What a SUCCESSFUL run records about the proxy  (issue #392)
// =============================================================================
//
// Shared by install and update so the two cannot describe the same deployment
// differently. Both helpers are bookkeeping about a deployment that has already
// succeeded, so neither throws.
// =============================================================================

export interface ObserveProxyOptions {
  domain: string | undefined;
  bindPort: number;
  proxyRoot: string;
  mode: 'container' | 'host' | undefined;
  container: string | undefined;
  runCommand: typeof defaultRunCommand;
}

/**
 * The proxy facts recorded in the deployment state on success.
 *
 * The certificate expiry is READ FROM THE CERTIFICATE (`certificateExpiry`),
 * never computed from an issuance date, and only when a domain is set -- a
 * deployment that is not published has no certificate to describe.
 */
export async function observeProxy(options: ObserveProxyOptions): Promise<DeployProxyFacts> {
  let certificateExpiresAt: string | null = null;

  if (options.domain !== undefined) {
    try {
      const expiry = await certificateExpiry(
        { domain: options.domain, bindPort: options.bindPort, proxyRoot: options.proxyRoot },
        { runCommand: options.runCommand },
      );
      certificateExpiresAt = expiry.notAfter?.toISOString() ?? null;
    } catch {
      // Not known is an honest answer; a failed deploy over it is not.
    }
  }

  return {
    domain: options.domain ?? null,
    bindPort: options.bindPort,
    mode: options.mode ?? null,
    container: options.container ?? null,
    certificateExpiresAt,
  };
}

/**
 * The info.json `proxy` object for recorded proxy facts.
 *
 * `undefined` (written as `null`) when the deployment is not published: with
 * no domain, nothing proxies it, and a mode/container pair would describe a
 * proxy that has nothing to do with this deployment.
 */
export function proxyInfoOf(
  proxy: DeployProxyFacts | undefined,
): DeployInfoInput['proxy'] {
  if (proxy === undefined || proxy.domain === null) return undefined;
  return {
    mode: proxy.mode,
    container: proxy.container,
    certificateExpiresAt: proxy.certificateExpiresAt,
  };
}
