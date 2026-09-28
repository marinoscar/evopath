import { Logger } from '@nestjs/common';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  NotFound,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { StorageProviderKind } from '../../../common/schemas/settings.schema';
import { StorageProvider } from '../storage-provider.interface';
import {
  StorageUploadOptions,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
  SignedPutUrlOptions,
} from '../storage-provider.types';

/**
 * The multipart part size used when nothing else says otherwise: 10 MiB.
 *
 * Was `configService.get('storage.partSize', 10485760)` inline; it moved out
 * here when the constructor stopped injecting `ConfigService` (#373 part 2) so
 * the default is stated once rather than re-typed at whichever call site
 * happens to need it. The value is unchanged.
 */
export const DEFAULT_S3_PART_SIZE = 10_485_760;

/**
 * Everything this provider needs to talk to an object store.
 *
 * ── WHY A CONFIG OBJECT AND NOT `ConfigService` (#373 part 2) ───────────────
 *
 * Because there is no longer ONE configuration for the life of the process.
 * Storage is administrator-editable at runtime now, so the provider that
 * actually talks to S3 must be constructible more than once — once per distinct
 * configuration — and a class that reads its settings out of the environment in
 * its constructor cannot be. Taking a plain object turns "which bucket am I?"
 * from something this class decides into something its caller decides, which is
 * what lets `ResolvingStorageProvider` build one of these per configuration and
 * throw it away when the configuration changes.
 *
 * It also makes this class trivially testable and, notably, FREE OF NEST: it is
 * no longer `@Injectable()` and is never constructed by the container.
 *
 * ⚠ `secretAccessKey` is plaintext, necessarily — an S3 client cannot sign
 * without it. Nothing in this class logs it, and nothing should.
 */
export interface S3StorageProviderConfig {
  /**
   * Which vendor's flavour of the S3 protocol this instance is talking to.
   *
   * THE ONLY FIELD THAT CHANGES HOW THE CLIENT IS BUILT (#374) — see
   * {@link buildS3ClientConfig}. It is carried rather than inferred from the
   * shape of the rest: "has an endpoint" and "is R2" are different questions,
   * and inferring one from the other is precisely the conflation
   * `forcePathStyle: !!endpoint` used to make.
   *
   * It is also what {@link S3StorageProvider.providerId} answers with.
   */
  provider: StorageProviderKind;
  /** Bucket every operation addresses. */
  bucket: string;
  /** Signing region. */
  region: string;
  /** Explicit origin, or absent for the SDK's own AWS host. Never `''`. */
  endpoint?: string;
  /** Identifier half of the credential. */
  accessKeyId: string;
  /** ⚠ Plaintext secret half. */
  secretAccessKey: string;
  /**
   * `https://host/bucket/key` (true) over `https://bucket.host/key` (false).
   *
   * OPTIONAL AND NULLABLE, AND NEITHER IS `false`: absent or `null` means "use
   * this provider's convention" ({@link buildS3ClientConfig} — path style for
   * `s3compatible`, virtual-host style for `s3` and `r2`), while `false` is an
   * operator saying virtual-host style about a deployment that might otherwise
   * have defaulted the other way.
   *
   * `null` is accepted beside absent because that is how the stored setting
   * spells "unset" (`systemStorageSchema.forcePathStyle` is tri-state), and
   * `ResolvingStorageProvider` hands this configuration straight through from
   * there. Collapsing `null` on the way in would put the default below out of
   * reach of every settings-configured deployment, which is the defect this
   * shape exists to prevent.
   */
  forcePathStyle?: boolean | null;
  /** Multipart part size in bytes. Defaults to {@link DEFAULT_S3_PART_SIZE}. */
  partSize?: number;
}

/**
 * The `S3Client` options for one provider kind — the whole of what differs
 * between AWS S3, Cloudflare R2 and an S3-compatible endpoint (#374).
 *
 * ── WHY ONE DRIVER AND NOT THREE CLASSES ────────────────────────────────────
 *
 * Because this function IS the difference. All three speak the same protocol
 * through the same SDK; the thirteen method bodies below are byte-for-byte the
 * same work, and `getSignedPutUrl`'s rationale alone runs forty lines that
 * would then exist in triplicate and drift. Three classes would be three copies
 * of everything that is identical, to express the four lines that are not.
 *
 * ── WHAT THIS FUNCTION DECIDES, AND WHAT IT DOES NOT ────────────────────────
 *
 * It decides the PATH-STYLE DEFAULT and the CHECKSUM FLAGS. It deliberately
 * does NOT decide the endpoint or the region: both are already resolved, per
 * provider, by `resolveStorageConfig` in `../../config/storage-config.ts` —
 * R2's account-scoped host from `deriveR2Endpoint`, R2's `auto` and an
 * S3-compatible endpoint's `us-east-1` from the two exported fallback
 * constants. Re-deriving either here would be a second copy of a rule that has
 * exactly one definition today, and the failure mode of a second copy is a
 * settings page reporting one host while the client talks to another. What
 * arrives here is therefore already correct; this function's job is only what
 * the settings namespace cannot express.
 *
 * ── THE TABLE (#374), AS IT IS ACTUALLY ENFORCED ────────────────────────────
 *
 *   | kind           | endpoint            | region      | forcePathStyle | checksums     |
 *   | -------------- | ------------------- | ----------- | -------------- | ------------- |
 *   | `s3`           | unset (SDK's host)  | operator's  | false          | SDK default   |
 *   | `r2`           | derived from acct   | `auto`      | false          | WHEN_REQUIRED |
 *   | `s3compatible` | operator's          | `us-east-1` | true*          | SDK default   |
 *
 * The first two columns are `resolveStorageConfig`'s; the last two are this
 * function's. The endpoint and region cells marked "operator's" and the two
 * derived ones are all fallbacks — a value an administrator typed always wins,
 * for every provider.
 *
 * (*) A DEFAULT, not a rule. `forcePathStyle` is tri-state: an administrator
 * who states `true` or `false` wins for every provider, and `null` (the shipped
 * default) or an absent key is what lets this row apply. See the field's own
 * note.
 *
 * `apps/api/src/storage/providers/s3/s3-storage.provider.spec.ts` asserts the
 * whole row end to end, from a settings literal to the arguments
 * `new S3Client(...)` was actually called with, rather than each half alone.
 *
 * ── WHY IT IS EXPORTED (#375) ───────────────────────────────────────────────
 *
 * Because #375's admin surface builds `S3Client`s this class does not own: the
 * connection test drives `HeadBucket`, and the bucket provisioner drives
 * `CreateBucket`/`PutPublicAccessBlock`/`PutBucketEncryption`/`PutBucketCors` —
 * none of which is a `StorageProvider` operation, and none of which belongs on
 * that interface (see the rule in #375's own header: the interface and its nine
 * consumers are untouched by this feature).
 *
 * Those clients MUST be built the same way this one is, or the test would be
 * testing a differently-configured client than the one that will do the work —
 * a `forcePathStyle` that differs by a default is the exact discrepancy that
 * makes a MinIO connection test pass and every upload fail. Exporting the
 * function is additive: no signature changed, no caller changed, and there is
 * still exactly one place that knows what each vendor's SDK flavour wants.
 */
export function buildS3ClientConfig(config: S3StorageProviderConfig): S3ClientConfig {
  const { provider, region, endpoint, accessKeyId, secretAccessKey } = config;

  const clientConfig: S3ClientConfig = {
    region,
    endpoint,
    credentials:
      accessKeyId && secretAccessKey
        ? {
            accessKeyId,
            secretAccessKey,
          }
        : undefined,
    // Path-style URLs for MinIO/LocalStack/Ceph and anything else behind a
    // certificate that does not cover wildcard subdomains. Was inferred from
    // `!!endpoint` before #373; that inference is wrong for R2, which has an
    // endpoint and wants virtual-host style. What an administrator stored
    // always wins — see the field's note above — and the fallback only names
    // the convention each vendor documents.
    //
    // `??` and not `||`: an explicit `false` is an answer and must survive.
    // It fires for `null` as well as for an absent key, which is what makes
    // the stored tri-state's "unset" reach this line at all.
    forcePathStyle: config.forcePathStyle ?? provider === 's3compatible',
  };

  if (provider === 'r2') {
    // ⚠ DO NOT REMOVE THESE TWO LINES AS "DEFAULTS WE ARE RESTATING".
    //
    // Since v3.729.0, `@aws-sdk/client-s3` computes a CRC32 checksum for every
    // request body by default and sends it as an AWS-specific TRAILER
    // (`x-amz-trailer`, chunked transfer encoding). Cloudflare R2 rejects that
    // trailer: uploads fail with `header 'x-amz-content-sha256' does not match`
    // or a 400 `InvalidRequest` naming the trailer — errors that name the
    // signature rather than the checksum that caused it, on a machine nobody is
    // watching. `WHEN_REQUIRED` keeps checksums for the operations that
    // genuinely mandate one (a multipart complete) and stops volunteering them
    // everywhere else.
    //
    // They are set ONLY for `r2`, and the branch must stay that narrow: AWS S3
    // wants the SDK's default, and an S3-compatible vendor is not R2 merely by
    // not being AWS. If a second vendor turns out to reject the trailer too,
    // the fix is a modelled setting an operator can turn on — not quietly
    // widening this condition to every non-AWS endpoint, which would disable
    // integrity checks for the vendors that do support them.
    clientConfig.requestChecksumCalculation = 'WHEN_REQUIRED';
    clientConfig.responseChecksumValidation = 'WHEN_REQUIRED';
  }

  return clientConfig;
}

/**
 * The `CopySource` for a same-bucket copy of `key`, URL-encoded.
 *
 * ⚠ THE SDK DOES NOT ENCODE THIS FIELD. `CopySource` is the one place in the S3
 * API where a key travels inside a value that is itself parsed as a path, so it
 * must arrive percent-encoded; every other command below takes `Key` raw and
 * the SDK encodes it. Sending it raw was a latent bug (#374): a key containing
 * a space, a `+` or a `%` addressed a DIFFERENT OBJECT or failed outright —
 * `+` reads as a space and `%xx` reads as an already-encoded byte — so
 * `setMetadata` on such a key silently replaced the metadata of whatever object
 * the mangled name happened to hit, or 404'd.
 *
 * ENCODED SEGMENT BY SEGMENT, not with one `encodeURIComponent` over the whole
 * string: the `/` separators are structure here (bucket from key, and the key's
 * own prefixes), and encoding them as `%2F` makes a prefixed key unaddressable
 * on the S3-compatible servers that do not decode them back.
 */
function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * S3-compatible storage provider implementation
 * Supports AWS S3, MinIO, LocalStack, and other S3-compatible storage services
 *
 * Constructed from a {@link S3StorageProviderConfig} rather than resolved by
 * Nest — see that type. One instance is bound to one configuration for its
 * whole life; a configuration change produces a new instance and
 * {@link S3StorageProvider.destroy}s the old one.
 */
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly partSize: number;

  /**
   * Which vendor this client is actually talking to.
   *
   * ── WHY IT EXISTS (#374) ────────────────────────────────────────────────────
   *
   * So that "which provider is in force?" has an authoritative answer on the
   * object that IS the answer, rather than being inferred from the shape of a
   * config (an endpoint means MinIO, no endpoint means AWS) or read from a
   * constant. Before #373 the recording sites wrote the literal `'s3'`; a
   * literal stops being true the moment an operator can choose.
   *
   * ── IT IS NOT A SECOND MECHANISM ────────────────────────────────────────────
   *
   * The rows that RECORD where bytes went (`storage_objects.storage_provider`,
   * `database_backup_runs.storage_provider`) and the rule that compares
   * `databaseBackup.storageProvider` against what is live keep asking
   * `StorageConfigService.activeProvider()`, which reads the same settings
   * namespace the bucket comes from — so a row cannot name one configuration's
   * bucket and another's provider. This field is that same value, carried by
   * the client built from it, for the caller that already holds a driver and
   * would otherwise have to go back to the settings to ask.
   *
   * ⚠ DELIBERATELY NOT ON THE `StorageProvider` INTERFACE. Adding it would
   * oblige `ResolvingStorageProvider` to answer synchronously for a
   * configuration it resolves asynchronously — the same trap `getBucket()`
   * already documents — and `activeProvider()` is the honest async answer that
   * already exists. The nine consumers of `STORAGE_PROVIDER` are untouched.
   */
  readonly providerId: StorageProviderKind;

  constructor(config: S3StorageProviderConfig) {
    const { provider, region, endpoint } = config;

    this.providerId = provider;
    this.bucket = config.bucket;
    this.partSize = config.partSize ?? DEFAULT_S3_PART_SIZE;

    // There is deliberately no "bucket not configured" warning here any more.
    // Completeness is decided in exactly one place — `resolveStorageConfig` in
    // `../../config/storage-config.ts` — which refuses to produce a config
    // without a bucket at all, so this branch became unreachable. A second,
    // weaker copy of the check is how a half-configured client comes to be
    // built anyway, with only a log line to show for it.
    //
    // Everything provider-specific about the client lives in one function, and
    // it is the only thing that differs between the three kinds — see
    // `buildS3ClientConfig` above.
    this.s3Client = new S3Client(buildS3ClientConfig(config));

    this.logger.log(
      `S3StorageProvider initialized - Provider: ${provider}, Bucket: ${this.bucket}, Region: ${region}${endpoint ? `, Endpoint: ${endpoint}` : ''}`,
    );
  }

  /**
   * Release this client's sockets.
   *
   * Called by `ResolvingStorageProvider` when a configuration change makes this
   * instance obsolete. Without it, every settings edit and every credential
   * rotation would leak an `S3Client`'s connection pool for the life of the
   * process — the same leak `SmtpEmailProvider` closes by calling
   * `transport.close()` on the transporter it replaces.
   */
  destroy(): void {
    this.s3Client.destroy();
  }

  /**
   * Simple upload using AWS SDK Upload helper
   * Automatically handles multipart uploads for large files
   */
  async upload(
    key: string,
    stream: Readable,
    options: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
    this.logger.debug(`Starting upload for key: ${key}`);

    try {
      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: stream,
          ContentType: options.mimeType,
          Metadata: options.metadata || {},
          ContentLength: options.contentLength,
        },
        // Use configured part size for automatic multipart uploads
        partSize: this.partSize,
      });

      const result = await upload.done();

      this.logger.log(`Upload completed for key: ${key}`);

      return {
        key,
        bucket: this.bucket,
        location: result.Location || `${this.bucket}/${key}`,
        eTag: result.ETag,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Upload failed for key ${key}: ${message}`, stack);
      throw error;
    }
  }

  /**
   * Initialize multipart upload
   */
  async initMultipartUpload(
    key: string,
    options: StorageUploadOptions,
  ): Promise<MultipartUploadInit> {
    this.logger.debug(`Initiating multipart upload for key: ${key}`);

    try {
      const command = new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.mimeType,
        Metadata: options.metadata || {},
      });

      const result = await this.s3Client.send(command);

      if (!result.UploadId) {
        throw new Error('Failed to initiate multipart upload - no UploadId returned');
      }

      this.logger.log(`Multipart upload initiated for key: ${key}, UploadId: ${result.UploadId}`);

      return {
        uploadId: result.UploadId,
        key,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to initiate multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Generate signed URL for uploading a specific part
   */
  async getSignedUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = 3600,
  ): Promise<string> {
    this.logger.debug(
      `Generating signed upload URL for key: ${key}, part: ${partNumber}`,
    );

    try {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      return signedUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to generate signed upload URL for key ${key}, part ${partNumber}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Complete multipart upload
   */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<StorageUploadResult> {
    this.logger.debug(
      `Completing multipart upload for key: ${key}, ${parts.length} parts`,
    );

    try {
      const command = new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      });

      const result = await this.s3Client.send(command);

      this.logger.log(`Multipart upload completed for key: ${key}`);

      return {
        key,
        bucket: this.bucket,
        location: result.Location || `${this.bucket}/${key}`,
        eTag: result.ETag,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to complete multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Abort multipart upload
   */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.logger.debug(`Aborting multipart upload for key: ${key}`);

    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      });

      await this.s3Client.send(command);

      this.logger.log(`Multipart upload aborted for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to abort multipart upload for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Download file as stream
   */
  async download(key: string): Promise<Readable> {
    this.logger.debug(`Downloading file for key: ${key}`);

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const result = await this.s3Client.send(command);

      if (!result.Body) {
        throw new Error('No body returned from S3');
      }

      // S3 returns a readable stream
      return result.Body as Readable;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to download file for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Generate signed download URL
   */
  async getSignedDownloadUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string> {
    this.logger.debug(`Generating signed download URL for key: ${key}`);

    try {
      const expiresIn = options?.expiresIn || 3600;

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options?.responseContentDisposition,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      return signedUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to generate signed download URL for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Generate a signed URL for a single-shot `PUT` of a whole object.
   *
   * `PutObjectCommand`, deliberately — not `UploadPartCommand`. See the block
   * comment on `getSignedPutUrl` in `../storage-provider.interface.ts` for why
   * a one-part multipart upload was rejected for this.
   *
   * ⚠ `ContentType` IS ONLY SET WHEN THE CALLER SUPPLIED ONE. S3 signs the
   * headers it is given: presigning with a `Content-Type` the uploader then
   * does not send exactly produces a `SignatureDoesNotMatch` on a machine
   * nobody is watching, and the error names the signature rather than the
   * header that caused it. Omitting it leaves the uploader free, which is the
   * right default for a caller that is guessing.
   *
   * The URL itself is NEVER logged, here or anywhere else — it is a bearer
   * write capability for `key` until it expires. The debug line below names
   * the key only, matching `getSignedDownloadUrl` beside it.
   */
  async getSignedPutUrl(
    key: string,
    options?: SignedPutUrlOptions,
  ): Promise<string> {
    this.logger.debug(`Generating signed PUT URL for key: ${key}`);

    try {
      const expiresIn = options?.expiresIn || 3600;

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options?.contentType ? { ContentType: options.contentType } : {}),
      });

      return await getSignedUrl(this.s3Client, command, { expiresIn });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to generate signed PUT URL for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Delete file
   */
  async delete(key: string): Promise<void> {
    this.logger.debug(`Deleting file for key: ${key}`);

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);

      this.logger.log(`File deleted for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to delete file for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Get file metadata
   */
  async getMetadata(key: string): Promise<Record<string, string> | null> {
    this.logger.debug(`Getting metadata for key: ${key}`);

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const result = await this.s3Client.send(command);

      return result.Metadata || {};
    } catch (error) {
      if (error instanceof NotFound || (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound')) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to get metadata for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Set file metadata
   * Uses CopyObject with REPLACE metadata directive
   *
   * ⚠ `CopySource` IS PERCENT-ENCODED AND `Key` IS NOT. That asymmetry is the
   * S3 API's, not a slip — see {@link encodeCopySource} for what sending the
   * raw key here did to any key containing a space, a `+` or a `%`.
   */
  async setMetadata(
    key: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    this.logger.debug(`Setting metadata for key: ${key}`);

    try {
      const command = new CopyObjectCommand({
        Bucket: this.bucket,
        Key: key,
        CopySource: encodeCopySource(this.bucket, key),
        Metadata: metadata,
        MetadataDirective: 'REPLACE',
      });

      await this.s3Client.send(command);

      this.logger.log(`Metadata updated for key: ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to set metadata for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Check if file exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      if (error instanceof NotFound || (error && typeof error === 'object' && 'name' in error && error.name === 'NotFound')) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Error checking existence for key ${key}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  /**
   * Get bucket name
   */
  getBucket(): string {
    return this.bucket;
  }
}
