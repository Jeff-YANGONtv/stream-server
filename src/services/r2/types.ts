import type { Readable } from 'node:stream';

export interface ObjectMetadata { size: number; contentType: string; etag?: string; }
export interface ObjectRead extends ObjectMetadata { body: Readable; contentRange?: string; }
export interface R2StorageService {
  exists(key: string): Promise<boolean>;
  get(key: string, range?: { start: number; end: number }): Promise<ObjectRead>;
  upload(key: string, source: Readable, size: number, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  metadata(key: string): Promise<ObjectMetadata | undefined>;
  check(): Promise<boolean>;
}
