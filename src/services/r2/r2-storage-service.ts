import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import type { AppConfig } from '../../config/env.js';
import { StorageUnavailableError } from '../../utils/errors.js';
import type { ObjectMetadata, ObjectRead, R2StorageService } from './types.js';

export class CloudflareR2Storage implements R2StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(config: AppConfig, client?: S3Client) {
    if (!config.CF_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY || !config.R2_BUCKET_NAME) {
      throw new StorageUnavailableError('R2 credentials are not configured');
    }
    this.bucket = config.R2_BUCKET_NAME;
    this.client = client ?? new S3Client({
      region: 'auto', endpoint: `https://${config.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
      forcePathStyle: true,
    });
  }
  async exists(key: string): Promise<boolean> {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; }
    catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return false;
      throw new StorageUnavailableError('Could not check R2 object', { cause: error });
    }
  }
  async metadata(key: string): Promise<ObjectMetadata | undefined> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (result.ContentLength === undefined) throw new Error('R2 object is missing content length');
      return { size: result.ContentLength, contentType: result.ContentType ?? 'application/octet-stream', ...(result.ETag ? { etag: result.ETag } : {}) };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return undefined;
      throw new StorageUnavailableError('Could not read R2 object metadata', { cause: error });
    }
  }
  async get(key: string, range?: { start: number; end: number }): Promise<ObjectRead> {
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }));
      if (!output.Body) throw new Error('R2 returned an empty body');
      const result: ObjectRead = {
        body: output.Body as Readable,
        size: output.ContentLength ?? 0,
        contentType: output.ContentType ?? 'application/octet-stream',
        ...(output.ETag ? { etag: output.ETag } : {}),
        ...(output.ContentRange ? { contentRange: output.ContentRange } : {}),
      };
      return result;
    } catch (error) {
      throw new StorageUnavailableError('Could not read video from R2', { cause: error });
    }
  }
  async upload(key: string, source: Readable, size: number, contentType: string): Promise<void> {
    try {
      const upload = new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: key, Body: source, ContentLength: size, ContentType: contentType },
        queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false,
      });
      await upload.done();
    } catch (error) {
      if (source.errored) throw source.errored;
      throw new StorageUnavailableError('Could not upload video to R2', { cause: error });
    }
  }
  async delete(key: string): Promise<void> {
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (error) { throw new StorageUnavailableError('Could not delete R2 object', { cause: error }); }
  }
  async check(): Promise<boolean> {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return true; }
    catch { return false; }
  }
  async close(): Promise<void> { this.client.destroy(); }
}

export function iterableToReadable(iterable: AsyncIterable<Uint8Array>): Readable {
  return Readable.from(iterable, { objectMode: false });
}
