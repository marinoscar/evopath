// =============================================================================
// HealthExportService: request, status and download of health exports (H7, #191)
// =============================================================================
//
// The export id is the `health.export` job id; there is no export table. The
// request lives on the job payload, the outcome on `payload.result` (written
// by the handler with the file's `storage_objects` row, in one transaction).
//
// OWNER-SCOPED. Every read filters on `type`, `subjectType: 'user'` and
// `subjectId: <caller>`, so another user's export id is a 404.
//
// DOWNLOAD. Only `GET /api/health/exports/:id` mints a URL, and only while the
// export is `ready`: a signed GET valid for 5 minutes, with a
// `Content-Disposition: attachment` naming the file. The URL is never logged
// and never stored.
// =============================================================================

import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../storage/providers/storage-provider.interface';
import {
  type CreateHealthExportInput,
  type HealthExport,
  type HealthExportJobPayload,
  type HealthExportList,
  healthExportJobPayloadSchema,
  type HealthExportStatus,
  readHealthExportResult,
} from './dto/health-export.dto';
import { orderDatasets } from './health-export-data';
import {
  HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
  HEALTH_EXPORT_JOB_TYPE,
  HEALTH_EXPORT_LIST_LIMIT,
  HEALTH_EXPORT_MAX_IN_FLIGHT,
  HEALTH_EXPORT_SUBJECT_TYPE,
} from './health-export.constants';

export const HEALTH_EXPORT_NOT_FOUND = 'Health export not found';
export const HEALTH_EXPORT_TOO_MANY = `You already have ${HEALTH_EXPORT_MAX_IN_FLIGHT} exports in progress; wait for one to finish`;
export const HEALTH_EXPORT_FAILED_MESSAGE = 'The export could not be created. Please try again.';

/** A download name the service will put in a header: what `healthExportFileName` produces. */
const SAFE_FILE_NAME = /^[a-z0-9-]+\.(json|zip|xlsx|pdf)$/;

type ExportJob = Pick<Job, 'id' | 'status' | 'payload' | 'createdAt' | 'finishedAt'>;

const JOB_SELECT = { id: true, status: true, payload: true, createdAt: true, finishedAt: true } as const;

@Injectable()
export class HealthExportService {
  private readonly logger = new Logger(HealthExportService.name);

  /** Overridable clock, for tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** Queues an export of the caller's data. 429 while too many are in flight. */
  async request(userId: string, input: CreateHealthExportInput): Promise<HealthExport> {
    const inFlight = await this.prisma.job.count({
      where: { ...ownerWhere(userId), status: { in: ['pending', 'running'] } },
    });

    if (inFlight >= HEALTH_EXPORT_MAX_IN_FLIGHT) {
      throw new HttpException(HEALTH_EXPORT_TOO_MANY, HttpStatus.TOO_MANY_REQUESTS);
    }

    const payload: HealthExportJobPayload = {
      userId,
      format: input.format,
      from: input.from,
      to: input.to,
      datasets: orderDatasets(input.datasets),
      includeHistory: input.includeHistory,
    };

    // Distinct requests are distinct work: two exports of different formats
    // must not collapse onto one job.
    const job = await this.jobs.enqueue({
      type: HEALTH_EXPORT_JOB_TYPE,
      reason: 'rerun',
      subjectType: HEALTH_EXPORT_SUBJECT_TYPE,
      subjectId: userId,
      payload: payload as Prisma.InputJsonValue,
      skipDedup: true,
    });

    this.logger.log(`Health export ${job.id} (${payload.format}, ${payload.datasets.length} dataset(s)) queued`);

    return (await this.toViews([job]))[0];
  }

  /** The caller's recent exports, newest first, without download URLs. */
  async list(userId: string): Promise<HealthExportList> {
    const jobs = await this.prisma.job.findMany({
      where: ownerWhere(userId),
      select: JOB_SELECT,
      orderBy: { createdAt: 'desc' },
      take: HEALTH_EXPORT_LIST_LIMIT,
    });

    return { items: await this.toViews(jobs) };
  }

  /** One of the caller's exports; with a fresh download URL while it is ready. */
  async get(userId: string, exportId: string): Promise<HealthExport> {
    const job = await this.prisma.job.findFirst({
      where: { id: exportId, ...ownerWhere(userId) },
      select: JOB_SELECT,
    });

    if (!job) throw new NotFoundException(HEALTH_EXPORT_NOT_FOUND);

    const [view] = await this.toViews([job]);
    if (view.status !== 'ready' || !view.fileName) return view;

    const object = await this.prisma.storageObject.findFirst({
      where: { id: readHealthExportResult(job.payload)!.storageObjectId, uploadedById: userId },
      select: { storageKey: true },
    });
    if (!object) return { ...view, status: 'expired' };

    if (!SAFE_FILE_NAME.test(view.fileName)) {
      throw new Error(`Health export ${job.id} has an unexpected file name`);
    }

    const url = await this.storage.getSignedDownloadUrl(object.storageKey, {
      expiresIn: HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
      responseContentDisposition: `attachment; filename="${view.fileName}"`,
    });

    return {
      ...view,
      download: {
        url,
        expiresAt: new Date(this.now().getTime() + HEALTH_EXPORT_DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      },
    };
  }

  /** The API shape of each job; one query for the files the ready ones name. */
  private async toViews(jobs: ExportJob[]): Promise<HealthExport[]> {
    const results = jobs.map((job) => readHealthExportResult(job.payload));
    const objectIds = results.flatMap((result) => (result ? [result.storageObjectId] : []));
    const existing =
      objectIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.prisma.storageObject.findMany({
                where: { id: { in: objectIds }, status: 'ready' },
                select: { id: true },
              })
            ).map((row) => row.id),
          );
    const now = this.now().getTime();

    return jobs.map((job, index) => {
      const payload = healthExportJobPayloadSchema.parse(job.payload);
      const result = results[index];
      let status: HealthExportStatus;

      if (result) {
        status = existing.has(result.storageObjectId) && Date.parse(result.expiresAt) > now ? 'ready' : 'expired';
      } else if (job.status === 'pending' || job.status === 'running') {
        status = job.status;
      } else {
        status = 'failed';
      }

      return {
        id: job.id,
        status,
        format: payload.format,
        from: payload.from,
        to: payload.to,
        datasets: payload.datasets,
        includeHistory: payload.includeHistory,
        createdAt: job.createdAt.toISOString(),
        completedAt: result?.completedAt ?? job.finishedAt?.toISOString() ?? null,
        expiresAt: result?.expiresAt ?? null,
        fileName: result?.fileName ?? null,
        sizeBytes: result?.sizeBytes ?? null,
        rowCounts: result?.rowCounts ?? null,
        error: status === 'failed' ? HEALTH_EXPORT_FAILED_MESSAGE : null,
        download: null,
      };
    });
  }
}

function ownerWhere(userId: string): Prisma.JobWhereInput {
  return { type: HEALTH_EXPORT_JOB_TYPE, subjectType: HEALTH_EXPORT_SUBJECT_TYPE, subjectId: userId };
}
