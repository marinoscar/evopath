// =============================================================================
// Unit tests for StorageObjectProcessHandler (issue #520)
// =============================================================================
//
// `process` is exercised against a mocked `PrismaService` (via
// `resolveStorageObjectInput`, the real function — the resolver's own three
// failure reasons are already pinned in `storage-job-input.spec.ts`, so this
// suite only needs to prove the handler reacts to them correctly) and a
// mocked `ObjectProcessingService`, whose own processing loop is covered by
// `object-processing.service.spec.ts`.
//
// `onJobSettled` is exercised directly with hand-built `JobSettledEvent`-shaped
// objects, the same way `ai-audio-transcribe.handler.spec.ts` tests its own
// settled listener: only the four fields the handler reads (`type`,
// `succeeded`, `subjectType`, `subjectId`, `lastError`) need to be real.
// =============================================================================

import { Logger } from '@nestjs/common';
import { Job, StorageObject } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import type { JobSettledEvent } from '../../jobs/events/job-settled.event';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import { PrismaService } from '../../prisma/prisma.service';
import type { ObjectProcessingService } from '../processing/object-processing.service';
import { JobInputResolutionError, STORAGE_OBJECT_SUBJECT_TYPE } from '../storage-job-input';
import { STORAGE_OBJECT_PROCESS_TYPE, StorageObjectProcessHandler } from './storage-object-process.handler';

const OBJECT_ID = 'object-1';
const JOB_ID = 'job-1';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    type: STORAGE_OBJECT_PROCESS_TYPE,
    subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
    subjectId: OBJECT_ID,
    ...overrides,
  } as Job;
}

function makeObject(overrides: Partial<StorageObject> = {}): StorageObject {
  return {
    id: OBJECT_ID,
    name: 'photo.jpg',
    size: BigInt(1024),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/1/photo.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'processing',
    s3UploadId: null,
    metadata: null,
    uploadedById: 'someone',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as StorageObject;
}

/** A minimal `JobSettledEvent`-shaped value — only the fields the handler reads. */
function settledEvent(overrides: Partial<JobSettledEvent> = {}): JobSettledEvent {
  return {
    jobId: JOB_ID,
    type: STORAGE_OBJECT_PROCESS_TYPE,
    succeeded: false,
    subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
    subjectId: OBJECT_ID,
    lastError: 'ran out of attempts',
    ...overrides,
  } as JobSettledEvent;
}

describe('StorageObjectProcessHandler', () => {
  let prisma: MockPrismaService;
  let registry: JobHandlerRegistry;
  let processing: jest.Mocked<Pick<ObjectProcessingService, 'run' | 'markAbandoned'>>;
  let handler: StorageObjectProcessHandler;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = new JobHandlerRegistry();
    processing = {
      run: jest.fn().mockResolvedValue('ready'),
      markAbandoned: jest.fn().mockResolvedValue(true),
    };

    (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(makeObject());

    handler = new StorageObjectProcessHandler(
      registry,
      prisma as unknown as PrismaService,
      processing as unknown as ObjectProcessingService
    );

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // ===========================================================================
  // Declaration
  // ===========================================================================

  describe('declaration', () => {
    it('self-registers under storage.object.process from its own onModuleInit', () => {
      handler.onModuleInit();

      expect(registry.get(STORAGE_OBJECT_PROCESS_TYPE)).toBe(handler);
      expect(handler.type).toBe('storage.object.process');
    });

    it('is server-only — neither node member is present', () => {
      // Read through the `JobHandler` view, not the class: the class simply
      // never declares either member, which IS the assertion. Processors are
      // in-process DI classes a remote node cannot construct.
      handler.onModuleInit();
      const asHandler: JobHandler = handler;

      expect(asHandler.nodeResultSchema).toBeUndefined();
      expect(asHandler.persistNodeResult).toBeUndefined();
      expect(registry.serverOnlyTypes()).toContain(STORAGE_OBJECT_PROCESS_TYPE);
    });

    it('has a display label, so the dashboard never shows the dotted key', () => {
      expect(JOB_TYPE_LABELS[STORAGE_OBJECT_PROCESS_TYPE]).toBeDefined();
      expect(JOB_TYPE_LABELS[STORAGE_OBJECT_PROCESS_TYPE]).not.toBe(STORAGE_OBJECT_PROCESS_TYPE);
    });
  });

  // ===========================================================================
  // process
  // ===========================================================================

  describe('process', () => {
    it('loads the object and runs the applicable processors against it', async () => {
      const object = makeObject();
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(object);

      await handler.process(makeJob());

      expect(prisma.storageObject.findUnique).toHaveBeenCalledWith({ where: { id: OBJECT_ID } });
      expect(processing.run).toHaveBeenCalledTimes(1);
      expect(processing.run).toHaveBeenCalledWith(object);
    });

    it('completes without throwing, and without running anything, when the object was deleted', async () => {
      // `input_object_not_found`: there is nothing left to process, and
      // retrying a missing row to exhaustion would only page an operator
      // about a user tidying up.
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      expect(processing.run).not.toHaveBeenCalled();
    });

    it.each([
      ['missing_subject_id', () => makeJob({ subjectId: null })],
      [
        'input_object_has_no_storage_key',
        () => {
          (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
            makeObject({ storageKey: '' })
          );
          return makeJob();
        },
      ],
    ])('rethrows every other resolver failure (%s), so the queue retries', async (reason, buildJob) => {
      const job = buildJob();

      await expect(handler.process(job)).rejects.toMatchObject({ reason });

      expect(processing.run).not.toHaveBeenCalled();
    });

    it('does not swallow a JobInputResolutionError it did not itself construct', async () => {
      // Sanity check on the discriminator: a resolver failure that is neither
      // of the "not found" shape must still propagate, however it arrived.
      const error = new JobInputResolutionError(
        'input_object_has_no_storage_key',
        'no key',
        JOB_ID,
        OBJECT_ID
      );

      jest.spyOn(prisma.storageObject, 'findUnique').mockRejectedValue(error);

      await expect(handler.process(makeJob())).rejects.toBe(error);
    });

    it('lets an error from run() propagate, so the queue retries the job', async () => {
      processing.run.mockRejectedValue(new Error('disk full'));

      await expect(handler.process(makeJob())).rejects.toThrow('disk full');
    });

    it('never calls markAbandoned itself — only a terminal job.settled event does', async () => {
      // The "retries" half of the contract: a `process` failure that the
      // queue will retry must not fail the object early. Only give-up
      // (`onJobSettled` below) may do that.
      processing.run.mockRejectedValue(new Error('transient'));

      await expect(handler.process(makeJob())).rejects.toThrow('transient');

      expect(processing.markAbandoned).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // onJobSettled
  // ===========================================================================

  describe('onJobSettled', () => {
    it('marks the object abandoned when this job type gave up permanently', async () => {
      await handler.onJobSettled(settledEvent());

      expect(processing.markAbandoned).toHaveBeenCalledTimes(1);
      expect(processing.markAbandoned).toHaveBeenCalledWith(
        OBJECT_ID,
        expect.stringContaining(JOB_ID)
      );
      expect(processing.markAbandoned).toHaveBeenCalledWith(
        OBJECT_ID,
        expect.stringContaining('ran out of attempts')
      );
    });

    it('ignores a settled event for a different job type', async () => {
      await handler.onJobSettled(settledEvent({ type: 'ai.image.generate' }));

      expect(processing.markAbandoned).not.toHaveBeenCalled();
    });

    it('ignores a success — only a give-up abandons the object', async () => {
      await handler.onJobSettled(settledEvent({ succeeded: true }));

      expect(processing.markAbandoned).not.toHaveBeenCalled();
    });

    it('ignores a settled event whose subject is not a storage object', async () => {
      await handler.onJobSettled(settledEvent({ subjectType: 'ai_run' }));

      expect(processing.markAbandoned).not.toHaveBeenCalled();
    });

    it('ignores a settled event with no subjectId at all', async () => {
      await handler.onJobSettled(settledEvent({ subjectId: null }));

      expect(processing.markAbandoned).not.toHaveBeenCalled();
    });

    it('quotes "no error recorded" when the job carries no lastError', async () => {
      await handler.onJobSettled(settledEvent({ lastError: null }));

      expect(processing.markAbandoned).toHaveBeenCalledWith(
        OBJECT_ID,
        expect.stringContaining('no error recorded')
      );
    });

    it('swallows (and logs) an error markAbandoned throws, rather than rethrowing into the emitter', async () => {
      // `JOB_SETTLED_EVENT` dispatches synchronously and its emitters wrap the
      // call in try/catch precisely so a throwing listener cannot affect the
      // job row that was just written — this is the listener's own half of
      // that contract.
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      processing.markAbandoned.mockRejectedValue(new Error('row locked'));

      await expect(handler.onJobSettled(settledEvent())).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('row locked'));
    });
  });
});
