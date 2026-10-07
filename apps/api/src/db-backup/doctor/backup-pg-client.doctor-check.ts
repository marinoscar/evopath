import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import {
  CLIENT_VERSION_TIMEOUT_MS,
  MIN_PG_CLIENT_MAJOR,
  PgVersionCheck,
  checkPgClientVersion,
  readServerVersionNumWithPgClient,
} from '../pg-version.util';
import { BACKUP_SETTINGS_PATH } from './backup-schedule.doctor-check';

const RUNBOOK = 'docs/runbooks/postgres-client-version.md';

/** Pure: judges the `pg_dump` client against the pin and the server. */
export function decidePgClient(check: PgVersionCheck): DoctorCheckOutcome {
  const data = { client: check.client ?? null, clientMajor: check.clientMajor, serverMajor: check.serverMajor };

  if (!check.client || check.clientMajor === null) {
    return {
      status: 'warn',
      detail: 'pg_dump was not found or did not report a version; backups cannot run on this API',
      remedy: `Use the shipped API image (it installs postgresql${MIN_PG_CLIENT_MAJOR}-client), or leave backups to a worker node. See ${RUNBOOK}.`,
      data,
    };
  }

  if (check.status === 'blocked') {
    return {
      status: 'fail',
      detail: `pg_dump ${check.clientMajor} cannot dump PostgreSQL ${check.serverMajor}`,
      remedy: `Rebuild the API image with a postgresql${check.serverMajor}-client (or newer). See ${RUNBOOK}.`,
      data,
    };
  }

  if (check.clientMajor < MIN_PG_CLIENT_MAJOR) {
    return {
      status: 'fail',
      detail: `pg_dump ${check.clientMajor} is older than the ${MIN_PG_CLIENT_MAJOR} this build pins`,
      remedy: `Redeploy the current API image; the running one is not what this build expects. See ${RUNBOOK}.`,
      data,
    };
  }

  return {
    status: 'pass',
    detail:
      check.serverMajor === null
        ? `${check.client} (the server version could not be read)`
        : `${check.client} can dump PostgreSQL ${check.serverMajor}`,
    data,
  };
}

/**
 * `backup` / `backup.pg-client` — this process's `pg_dump` can back up the
 * database. Runs `pg_dump --version` (prints and exits) and reads
 * `server_version_num` over a short-lived connection; writes nothing.
 */
@Injectable()
export class BackupPgClientDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'backup.pg-client';
  readonly category = 'backup';
  readonly label = 'PostgreSQL client (pg_dump)';
  readonly settingsPath = BACKUP_SETTINGS_PATH;
  /** `pg_dump --version` is allowed its own 10 s before it counts as hung. */
  readonly timeoutMs = CLIENT_VERSION_TIMEOUT_MS + 2_000;

  /** Overridable in tests. */
  protected probe: () => Promise<PgVersionCheck> = () =>
    checkPgClientVersion({ readServerVersionNum: () => readServerVersionNumWithPgClient() });

  constructor(private readonly registry: DoctorCheckRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decidePgClient(await this.probe());
  }
}
