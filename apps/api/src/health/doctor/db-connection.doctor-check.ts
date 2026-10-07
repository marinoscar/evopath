import { Injectable, OnModuleInit } from '@nestjs/common';
import { HealthCheckError } from '@nestjs/terminus';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { DatabaseHealthIndicator } from '../indicators/database.indicator';

/** Above this round trip the database answers, but slowly enough to notice. */
export const DB_SLOW_LATENCY_MS = 500;

/**
 * `core` / `db.connection` — the database answers `SELECT 1`.
 *
 * REUSES `DatabaseHealthIndicator`, the one definition of "the database
 * answers" that the readiness probe and `/api/admin/about` already share.
 */
@Injectable()
export class DbConnectionDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'db.connection';
  readonly category = 'core';
  readonly label = 'Database connection';

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly indicator: DatabaseHealthIndicator,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const result = await this.indicator.isHealthy('database');
      const latencyMs = parseLatency(result.database?.responseTime);

      if (latencyMs !== null && latencyMs > DB_SLOW_LATENCY_MS) {
        return {
          status: 'warn',
          detail: `Connected, but SELECT 1 took ${latencyMs} ms`,
          remedy:
            'Check the database host load and the network path between the API and PostgreSQL ' +
            '(POSTGRES_HOST); a healthy round trip is a few milliseconds.',
          data: { latencyMs },
        };
      }

      return {
        status: 'pass',
        detail: latencyMs === null ? 'Connected' : `Connected in ${latencyMs} ms`,
        data: { latencyMs },
      };
    } catch (error) {
      const message =
        error instanceof HealthCheckError
          ? String((error.causes as Record<string, { message?: string }>)?.database?.message ?? error.message)
          : error instanceof Error
            ? error.message
            : String(error);

      return {
        status: 'fail',
        detail: 'The database did not answer',
        remedy:
          'Check PostgreSQL is running and reachable, and that the POSTGRES_HOST, POSTGRES_PORT, ' +
          'POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB variables are correct.',
        error: message,
      };
    }
  }
}

function parseLatency(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)ms$/.exec(value);

  return match ? Number(match[1]) : null;
}
