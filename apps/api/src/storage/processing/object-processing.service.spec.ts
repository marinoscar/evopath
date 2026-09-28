import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'node:stream';

import { ObjectProcessingService } from './object-processing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../providers/storage-provider.interface';
import { OBJECT_PROCESSOR, ObjectProcessor } from './object-processor.interface';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';

describe('ObjectProcessingService', () => {
  // #520: `run` is what the `storage.object.process` job calls; before #520 the
  // same loop ran inside an `@OnEvent('storage.object.uploaded')` listener.
  let service: ObjectProcessingService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;

  const mockStorageObject = {
    id: 'obj-123',
    name: 'test-file.pdf',
    size: BigInt(1024000),
    mimeType: 'application/pdf',
    storageKey: 'uploads/123456/uuid-123.pdf',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'processing',
    s3UploadId: null,
    uploadedById: 'user-123',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = createMockStorageProvider();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('with no processors', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ObjectProcessingService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        ],
      }).compile();

      service = module.get<ObjectProcessingService>(ObjectProcessingService);
    });

    it('should mark object as ready when no processors are registered', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);

      await service.run(mockStorageObject as any);

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          status: 'ready',
          metadata: expect.objectContaining({
            _processing: {},
            _processedAt: expect.any(String),
          }),
        },
      });
    });

    it('reports that no processing job is needed', () => {
      expect(service.appliesTo(mockStorageObject as any)).toBe(false);
      expect(service.applicableProcessors(mockStorageObject as any)).toEqual([]);
    });

    describe('markAbandoned', () => {
      it('fails an object still processing, conditionally on that status', async () => {
        mockPrisma.storageObject.findUnique.mockResolvedValue({
          status: 'processing',
          metadata: { userProvided: 'value' },
        } as any);
        mockPrisma.storageObject.updateMany.mockResolvedValue({ count: 1 } as any);

        await expect(service.markAbandoned('obj-123', 'job gave up')).resolves.toBe(true);

        expect(mockPrisma.storageObject.updateMany).toHaveBeenCalledWith({
          where: { id: 'obj-123', status: 'processing' },
          data: {
            status: 'failed',
            metadata: expect.objectContaining({
              userProvided: 'value',
              _processing: {},
              _processingFailed: true,
              _processingError: 'job gave up',
              _processedAt: expect.any(String),
            }),
          },
        });
      });

      it.each(['ready', 'failed'])('leaves a %s object alone', async (status) => {
        mockPrisma.storageObject.findUnique.mockResolvedValue({
          status,
          metadata: null,
        } as any);

        await expect(service.markAbandoned('obj-123', 'job gave up')).resolves.toBe(false);
        expect(mockPrisma.storageObject.updateMany).not.toHaveBeenCalled();
      });

      it('leaves a deleted object alone', async () => {
        mockPrisma.storageObject.findUnique.mockResolvedValue(null);

        await expect(service.markAbandoned('obj-123', 'job gave up')).resolves.toBe(false);
        expect(mockPrisma.storageObject.updateMany).not.toHaveBeenCalled();
      });

      it('reports false when the row left processing between read and write', async () => {
        mockPrisma.storageObject.findUnique.mockResolvedValue({
          status: 'processing',
          metadata: null,
        } as any);
        mockPrisma.storageObject.updateMany.mockResolvedValue({ count: 0 } as any);

        await expect(service.markAbandoned('obj-123', 'job gave up')).resolves.toBe(false);
      });
    });
  });

  describe('with processors', () => {
    let mockProcessor1: jest.Mocked<ObjectProcessor>;
    let mockProcessor2: jest.Mocked<ObjectProcessor>;

    beforeEach(async () => {
      mockProcessor1 = {
        name: 'processor1',
        priority: 10,
        canProcess: jest.fn().mockReturnValue(true),
        process: jest.fn().mockResolvedValue({
          success: true,
          metadata: { key1: 'value1' },
        }),
      };

      mockProcessor2 = {
        name: 'processor2',
        priority: 20,
        canProcess: jest.fn().mockReturnValue(true),
        process: jest.fn().mockResolvedValue({
          success: true,
          metadata: { key2: 'value2' },
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ObjectProcessingService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
          {
            provide: OBJECT_PROCESSOR,
            useValue: [mockProcessor1, mockProcessor2],
          },
        ],
      }).compile();

      service = module.get<ObjectProcessingService>(ObjectProcessingService);
    });

    it('reports that a processing job is needed when any processor applies', () => {
      mockProcessor1.canProcess.mockReturnValue(false);

      expect(service.appliesTo(mockStorageObject as any)).toBe(true);
      expect(service.applicableProcessors(mockStorageObject as any)).toEqual([mockProcessor2]);

      mockProcessor2.canProcess.mockReturnValue(false);

      expect(service.appliesTo(mockStorageObject as any)).toBe(false);
    });

    it('returns the outcome it wrote', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({} as any);

      await expect(service.run(mockStorageObject as any)).resolves.toBe('ready');

      mockProcessor2.process.mockResolvedValue({ success: false, error: 'bad' });

      await expect(service.run(mockStorageObject as any)).resolves.toBe('failed');
    });

    it('propagates a failure outside the processors so the job retries', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockRejectedValue(new Error('db down'));

      await expect(service.run(mockStorageObject as any)).rejects.toThrow('db down');
    });

    it("drops a previous run's failure markers when a re-run succeeds", async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: {
          userProvided: 'value',
          _processingFailed: true,
          _processingError: 'earlier give-up',
        },
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({} as any);

      await service.run(mockStorageObject as any);

      const metadata = mockPrisma.storageObject.update.mock.calls[0][0].data.metadata as any;

      expect(metadata.userProvided).toBe('value');
      expect(metadata).not.toHaveProperty('_processingFailed');
      expect(metadata).not.toHaveProperty('_processingError');
    });

    it('should run processors in priority order', async () => {
      const executionOrder: string[] = [];

      mockProcessor1.process.mockImplementation(async () => {
        executionOrder.push('processor1');
        return { success: true, metadata: { key1: 'value1' } };
      });

      mockProcessor2.process.mockImplementation(async () => {
        executionOrder.push('processor2');
        return { success: true, metadata: { key2: 'value2' } };
      });

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      await service.run(mockStorageObject as any);

      expect(executionOrder).toEqual(['processor1', 'processor2']);
    });

    it('should aggregate metadata from all processors', async () => {
      mockProcessor1.process.mockResolvedValue({
        success: true,
        metadata: { from: 'processor1', count: 10 },
      });

      mockProcessor2.process.mockResolvedValue({
        success: true,
        metadata: { from: 'processor2', size: 100 },
      });

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      await service.run(mockStorageObject as any);

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          status: 'ready',
          metadata: expect.objectContaining({
            _processing: {
              processor1: { from: 'processor1', count: 10 },
              processor2: { from: 'processor2', size: 100 },
            },
          }),
        },
      });
    });

    it('should mark object as failed when any processor fails', async () => {
      mockProcessor1.process.mockResolvedValue({
        success: true,
        metadata: { key1: 'value1' },
      });

      mockProcessor2.process.mockResolvedValue({
        success: false,
        error: 'Processing failed',
      });

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'failed',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      await service.run(mockStorageObject as any);

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          status: 'failed',
          metadata: expect.objectContaining({
            _processing: expect.objectContaining({
              processor1: { key1: 'value1' },
              processor2_error: 'Processing failed',
            }),
            _processingFailed: true,
          }),
        },
      });
    });

    it('should continue processing even when one processor throws', async () => {
      mockProcessor1.process.mockRejectedValue(new Error('Processor 1 crashed'));

      mockProcessor2.process.mockResolvedValue({
        success: true,
        metadata: { key2: 'value2' },
      });

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'failed',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      await service.run(mockStorageObject as any);

      // Both processors should be called
      expect(mockProcessor1.process).toHaveBeenCalled();
      expect(mockProcessor2.process).toHaveBeenCalled();

      // Status should be failed due to exception
      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          status: 'failed',
          metadata: expect.objectContaining({
            _processing: expect.objectContaining({
              processor1_error: 'Processor 1 crashed',
              processor2: { key2: 'value2' },
            }),
            _processingFailed: true,
          }),
        },
      });
    });

    it('should provide fresh stream to each processor', async () => {
      const streamFactory = jest.fn();
      mockProcessor1.process.mockImplementation(async (obj, getStream) => {
        await getStream();
        return { success: true };
      });

      mockProcessor2.process.mockImplementation(async (obj, getStream) => {
        await getStream();
        return { success: true };
      });

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.download.mockImplementation(() => {
        streamFactory();
        return Promise.resolve(Readable.from(['test content']));
      });

      await service.run(mockStorageObject as any);

      // Verify each processor got a stream
      expect(mockProcessor1.process).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
      );
      expect(mockProcessor2.process).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
      );

      // Verify stream factory was called for each processor
      expect(streamFactory).toHaveBeenCalledTimes(2);
    });

    it('should skip processors that return false from canProcess', async () => {
      mockProcessor1.canProcess.mockReturnValue(false); // Skip this one
      mockProcessor2.canProcess.mockReturnValue(true);

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      await service.run(mockStorageObject as any);

      expect(mockProcessor1.process).not.toHaveBeenCalled();
      expect(mockProcessor2.process).toHaveBeenCalled();
    });

    it('should merge with existing metadata', async () => {
      const existingMetadata = {
        userProvided: 'value',
        custom: 'data',
      };

      mockProcessor1.process.mockResolvedValue({
        success: true,
        metadata: { key1: 'value1' },
      });

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: existingMetadata,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      await service.run(mockStorageObject as any);

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          status: 'ready',
          metadata: expect.objectContaining({
            userProvided: 'value',
            custom: 'data',
            _processing: expect.any(Object),
          }),
        },
      });
    });

    it('should handle processor that returns no metadata', async () => {
      // Configure processor1 to skip processing
      mockProcessor1.canProcess.mockReturnValue(false);

      // Configure processor2 to skip processing
      mockProcessor2.canProcess.mockReturnValue(false);

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      await service.run(mockStorageObject as any);

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          status: 'ready',
          metadata: expect.objectContaining({
            _processing: {}, // No processor metadata added
            _processedAt: expect.any(String),
          }),
        },
      });
    });

    it('should set _processedAt timestamp in metadata', async () => {
      mockProcessor1.process.mockResolvedValue({
        success: true,
        metadata: { key1: 'value1' },
      });

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      const beforeTime = new Date().toISOString();

      await service.run(mockStorageObject as any);

      const afterTime = new Date().toISOString();

      const updateCall = mockPrisma.storageObject.update.mock.calls[0][0];
      const metadata = updateCall.data.metadata as any;

      expect(metadata._processedAt).toBeDefined();
      expect(new Date(metadata._processedAt).getTime()).toBeGreaterThanOrEqual(new Date(beforeTime).getTime());
      expect(new Date(metadata._processedAt).getTime()).toBeLessThanOrEqual(new Date(afterTime).getTime());
    });
  });

  describe('with single processor', () => {
    let mockProcessor: jest.Mocked<ObjectProcessor>;

    beforeEach(async () => {
      mockProcessor = {
        name: 'single-processor',
        priority: 50,
        canProcess: jest.fn().mockReturnValue(true),
        process: jest.fn().mockResolvedValue({
          success: true,
          metadata: { processed: true },
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ObjectProcessingService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
          {
            provide: OBJECT_PROCESSOR,
            useValue: mockProcessor, // Single processor, not array
          },
        ],
      }).compile();

      service = module.get<ObjectProcessingService>(ObjectProcessingService);
    });

    it('should handle single processor injection', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: null,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from(['test content']),
      );

      await service.run(mockStorageObject as any);

      expect(mockProcessor.process).toHaveBeenCalled();
      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          status: 'ready',
          metadata: expect.objectContaining({
            _processing: {
              'single-processor': { processed: true },
            },
          }),
        },
      });
    });
  });
});
