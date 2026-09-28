// =============================================================================
// AboutService — assembles the deployment report (issue #401, epic #397)
// =============================================================================
//
// Three independent facts, gathered with a strict rule between them: NO ONE OF
// THEM MAY TAKE DOWN THE OTHER TWO.
//
//   1. The API's own version, from `openapi/version.ts`. Always available; the
//      resolver never throws and falls back to `'0.0.0'`.
//   2. The deploy document on disk, read fresh per request.
//   3. A database liveness probe, from the health module's own indicator.
//
// Each is obtained inside its own failure boundary, and every failure becomes a
// field. Nothing here throws an HTTP exception, because the controller above it
// has exactly one status code to return and the reason is argued at length in
// `dto/about-response.dto.ts`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { DatabaseHealthIndicator } from '../health/indicators/database.indicator';
import { resolveApiVersion } from '../openapi/version';
import { readDeployInfo, resolveDeployInfoPath } from './deploy-info';
import type { AboutResponse } from './dto/about-response.dto';

/**
 * When this process started, fixed once at module load. `process.uptime()` is
 * measured from process start, so subtracting it from "now" at load time gives
 * the start instant; computing it per request would drift by clock jitter.
 */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** The key the health indicator reports its result under. */
const DATABASE_INDICATOR_KEY = 'database';

@Injectable()
export class AboutService {
  private readonly logger = new Logger(AboutService.name);

  constructor(private readonly database: DatabaseHealthIndicator) {}

  /**
   * Builds the whole report.
   *
   * ⚠ NO CACHING ANYWHERE IN THIS METHOD, and that is a requirement rather than
   * an omission. `appctl deploy update` rewrites `info.json` in place against a
   * running container; a memoised read — even a short-lived one — would serve a
   * stale commit SHA immediately after the deploy that changed it, which is the
   * one moment anybody looks at this page.
   */
  async describe(): Promise<AboutResponse> {
    const path = resolveDeployInfoPath();
    const deployInfo = await readDeployInfo(path);
    const { database, databaseError } = await this.probeDatabase();

    const document = deployInfo.document;

    return {
      api: { version: resolveApiVersion() },

      deployInfoStatus: deployInfo.status,
      deployInfoPath: deployInfo.path,
      deployInfoError: deployInfo.error,

      // Every one of these is `null` when no document was read. Deliberately
      // not "" or a placeholder object — see the DTO's note on fabricated
      // defaults, and note especially that `installedAt`/`updatedAt` never fall
      // back to the current time.
      app: document?.app ?? null,
      installedAt: document?.installedAt ?? null,
      updatedAt: document?.updatedAt ?? null,
      deployedBy: document?.deployedBy ?? null,
      domain: document?.domain ?? null,
      remote: document?.remote ?? null,

      // The third state rides here: a document whose `run.outcome` is
      // `'failure'` still arrives with `deployInfoStatus: 'ok'` and every other
      // field populated, plus `run.failedStep` naming where it stopped.
      run: document?.run ?? null,

      // Issue #392 additions — same `null`-when-no-document rule.
      lastCommand: document?.lastCommand ?? null,
      bindPort: document?.bindPort ?? null,
      proxy: document?.proxy ?? null,
      host: document?.host ?? null,
      history: document?.history ?? null,

      // Live, not from disk — the one part of this report always current.
      runtime: {
        processStartedAt: PROCESS_STARTED_AT,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV?.trim() || null,
      },

      database,
      databaseError,
    };
  }

  /**
   * Asks the health module's indicator whether the database answers.
   *
   * ⚠ A FAILURE IS A FIELD, NOT A 503. `DatabaseHealthIndicator` signals failure
   * by THROWING `HealthCheckError`, which is the right contract for Terminus —
   * the readiness probe wants a non-2xx. It is the wrong contract here, so the
   * throw is caught and turned back into data. Letting it escape would mean the
   * one page that reports what is deployed stops loading whenever the database
   * is the thing that is broken, hiding the API version, the commit SHA and the
   * deploy document, none of which need a database to be known.
   */
  private async probeDatabase(): Promise<
    Pick<AboutResponse, 'database' | 'databaseError'>
  > {
    try {
      const result = await this.database.isHealthy(DATABASE_INDICATOR_KEY);
      const entry = result?.[DATABASE_INDICATOR_KEY];

      return {
        database: {
          status: String(entry?.status ?? 'up'),
          responseTime: String(entry?.responseTime ?? ''),
        },
        databaseError: null,
      };
    } catch (error) {
      // Logged at `warn`, not `error`: the indicator has already logged the
      // underlying failure at `error` from the readiness path, and a page load
      // is not a second incident.
      this.logger.warn(
        `Database probe failed while building the about report: ${describe(error)}`,
      );

      return { database: null, databaseError: describe(error) };
    }
  }
}

/**
 * A message for the client that never leaks a stack trace.
 *
 * ⚠ IT READS `causes` FIRST, AND THAT IS THE WHOLE POINT OF THIS FUNCTION.
 * `HealthIndicator` wraps every failure in a `HealthCheckError` whose own
 * `message` is the CONSTANT string `'Database check failed'` — true, and useless
 * to the operator reading this page, who already knows the check failed and
 * wants to know why. The real diagnosis ("Can't reach database server",
 * "password authentication failed", a connect timeout) is put by the indicator
 * into `causes[key].message`, so that is what is reported when it is there.
 *
 * Only the MESSAGE is taken, never the error object: a stack trace must not
 * reach a response body.
 */
function describe(error: unknown): string {
  const causes = (error as { causes?: Record<string, { message?: unknown }> })?.causes;

  if (causes && typeof causes === 'object') {
    for (const cause of Object.values(causes)) {
      const message = cause?.message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  }

  if (error instanceof Error && error.message.length > 0) return error.message;

  return 'The database did not answer.';
}
