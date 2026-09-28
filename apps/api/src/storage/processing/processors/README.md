# Storage Object Processors

This directory contains processor implementations for the storage object processing pipeline.

## Overview

Processors are pluggable components that run asynchronously after a file is uploaded. They can:
- Extract metadata (dimensions, duration, etc.)
- Generate thumbnails or previews
- Scan for viruses
- Validate file integrity
- Index content for search
- Any other post-upload processing

## Creating a Processor

### 1. Implement the `ObjectProcessor` Interface

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import {
  ObjectProcessor,
  ObjectProcessorResult,
} from '../object-processor.interface';

@Injectable()
export class MyCustomProcessor implements ObjectProcessor {
  private readonly logger = new Logger(MyCustomProcessor.name);

  readonly name = 'my-custom-processor';
  readonly priority = 100; // Lower = runs earlier

  canProcess(object: StorageObject): boolean {
    // Return true if this processor should handle this object
    return object.mimeType.startsWith('image/');
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    try {
      // Get a fresh stream of the file content
      const stream = await getStream();

      // Do your processing...
      const metadata = {
        // Your extracted metadata
      };

      return {
        success: true,
        metadata,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
```

### 2. Register the Processor

Add your processor to the module where it should be used:

```typescript
import { Module } from '@nestjs/common';
import { OBJECT_PROCESSOR } from './processing/object-processor.interface';
import { MyCustomProcessor } from './processing/processors/my-custom.processor';

@Module({
  providers: [
    {
      provide: OBJECT_PROCESSOR,
      useClass: MyCustomProcessor,
    },
  ],
})
export class MyModule {}
```

### 3. Register Multiple Processors

Nest has no `multi: true` provider option (that is Angular). `ObjectProcessingService`
accepts either a single processor or an array from `OBJECT_PROCESSOR`
(`processors?: ObjectProcessor | ObjectProcessor[]` in its constructor), so
registering several processors means one factory provider that returns the
array, injecting each processor class as an ordinary provider:

```typescript
@Module({
  providers: [
    ImageMetadataProcessor,
    ThumbnailGenerator,
    VirusScanner,
    {
      provide: OBJECT_PROCESSOR,
      useFactory: (
        imageMetadata: ImageMetadataProcessor,
        thumbnail: ThumbnailGenerator,
        virusScanner: VirusScanner,
      ) => [imageMetadata, thumbnail, virusScanner],
      inject: [ImageMetadataProcessor, ThumbnailGenerator, VirusScanner],
    },
  ],
})
export class StorageProcessorsModule {}
```

## Processor Lifecycle

Post-upload processing is the server-only queue job `storage.object.process`
(`apps/api/src/storage/handlers/storage-object-process.handler.ts`), not an
event listener:

1. **Upload completes**: inside the same transaction that closes it,
   `ObjectsService` (`completeUpload`/`simpleUpload`) asks
   `ObjectProcessingService.appliesTo(object)`.
2. **No processor applies**: the row is marked `ready` right there — no job.
3. **A processor applies**: the row is marked `processing` and a
   `storage.object.process` job is enqueued in that same transaction
   (`enqueueWithin`), deduplicated per object.
4. **The job runs**: `StorageObjectProcessHandler.process` resolves the object
   and calls `ObjectProcessingService.run(object)` on a worker slot.
5. **Processor Selection**: `canProcess()` called on all registered processors.
6. **Priority Sorting**: applicable processors sorted by priority (lower first).
7. **Sequential Execution**: each processor runs in order.
8. **Metadata Aggregation**: results merged into object metadata.
9. **Status Update**: object marked as `ready` (or `failed` if any processor
   reported an error or threw).
10. **Give-up**: if the job exhausts its attempts, times out, or is reaped
    after a dead executor, a `job.settled` listener marks a still-`processing`
    object `failed` so it never stays `processing` forever.

The queue is **at-least-once**: a retry after a transient failure, or a
reaper requeue after a dead executor, can call a processor again for the same
object. Every processor MUST be idempotent — safe to run twice on the same
object without corrupting its metadata or duplicating a side effect (write a
thumbnail to a stable key and overwrite it, rather than appending a new one
each run).

## Metadata Storage

Each processor's results are stored in the object's metadata field:

```json
{
  "metadata": {
    "_processing": {
      "image-metadata": {
        "width": 1920,
        "height": 1080,
        "format": "jpeg"
      },
      "thumbnail-generator": {
        "thumbnailKey": "thumbnails/abc123.jpg"
      }
    },
    "_processedAt": "2025-01-24T10:30:00.000Z"
  }
}
```

## Error Handling

- Individual processor failures don't stop other processors
- Errors are logged and stored in metadata:
  ```json
  {
    "_processing": {
      "virus-scanner_error": "Scan timeout"
    },
    "_processingFailed": true
  }
  ```
- Object status set to `failed` if any processor fails

## Best Practices

1. **Idempotent Processing**: Ensure processors can be safely re-run
2. **Stream Handling**: Always destroy streams to prevent leaks
3. **Error Handling**: Catch all errors and return proper results
4. **Logging**: Use structured logging with object IDs
5. **Performance**: Keep processing fast; consider queues for heavy work
6. **Priority Order**: Set appropriate priority for dependencies

## Example Processors

See `example-metadata.processor.ts` for a basic implementation example.

Common processor types:
- **Metadata Extraction**: Extract file properties (dimensions, duration, etc.)
- **Preview Generation**: Create thumbnails, previews, or transcoded versions
- **Content Analysis**: OCR, image recognition, content classification
- **Security Scanning**: Virus scanning, content policy validation
- **Indexing**: Extract searchable text, tags, or embeddings
