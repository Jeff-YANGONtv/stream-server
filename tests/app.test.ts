import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/env.js';
import { SqliteFileCatalog } from '../src/services/file-catalog.js';
import type { FileRecord, TelegramFileMetadata, TelegramService } from '../src/services/types.js';
import type { ObjectMetadata, ObjectRead, R2StorageService } from '../src/services/r2/types.js';
import { createSignedToken } from '../src/security/signed-url.js';
import { StorageUnavailableError, TelegramUnavailableError } from '../src/utils/errors.js';

const bytes = Buffer.from('0123456789abcdef');
const managementToken = 'test-management-token-that-is-long-enough';
const streamSecret = 'test-stream-signing-secret-with-at-least-32-bytes';

function setup(options: { telegramFails?: boolean; r2Fails?: boolean } = {}) {
  const config = parseConfig({ APP_ENV: 'test', APP_URL: 'https://stream-server-1.ygntv.org',
    MANAGEMENT_API_TOKEN: managementToken, STREAM_TOKEN_SECRET: streamSecret, DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent' });
  const catalog = new SqliteFileCatalog(':memory:');
  const metadata: TelegramFileMetadata = { chatId: '-1001234567890', messageId: '17', fileName: 'sample movie.mp4', mimeType: 'video/mp4', size: bytes.length, documentId: '987654' };
  let downloads = 0;
  const telegram: TelegramService = {
    connect: vi.fn(async () => {}),
    inspectMessage: vi.fn(async () => metadata),
    async *downloadFile() {
      downloads += 1;
      if (options.telegramFails) throw new TelegramUnavailableError('test Telegram fault');
      yield bytes;
    },
    checkConnection: vi.fn(async () => true), checkAccess: vi.fn(async () => true), close: vi.fn(async () => {}),
  };
  const objects = new Map<string, { data: Buffer; contentType: string }>();
  const r2: R2StorageService = {
    exists: vi.fn(async (key) => { if (options.r2Fails) throw new StorageUnavailableError(); return objects.has(key); }),
    async upload(key, source, _size, contentType) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      objects.set(key, { data: Buffer.concat(chunks), contentType });
    },
    async metadata(key): Promise<ObjectMetadata | undefined> {
      if (options.r2Fails) throw new StorageUnavailableError();
      const item = objects.get(key);
      return item ? { size: item.data.length, contentType: item.contentType, etag: '"fixture-etag"' } : undefined;
    },
    async get(key, range): Promise<ObjectRead> {
      if (options.r2Fails) throw new StorageUnavailableError();
      const item = objects.get(key);
      if (!item) throw new StorageUnavailableError();
      const selected = range ? item.data.subarray(range.start, range.end + 1) : item.data;
      return { body: Readable.from(selected), size: selected.length, contentType: item.contentType, etag: '"fixture-etag"' };
    },
    async delete(key) { objects.delete(key); },
    check: vi.fn(async () => !options.r2Fails),
  };
  const app = buildApp({ config, catalog, telegram, r2 });
  return { app, catalog, telegram, r2, objects, get downloads() { return downloads; }, metadata, config };
}

const auth = { authorization: `Bearer ${managementToken}` };
async function register(f: ReturnType<typeof setup>) {
  const response = await f.app.inject({ method: 'POST', url: '/api/files', headers: auth, payload: { messageId: '17' } });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string; streamUrl: string; fileName: string }>();
}

afterEach(() => vi.restoreAllMocks());

describe('stream server API', () => {
  it('returns a public health status and has authenticated diagnostics', async () => {
    const f = setup();
    expect((await f.app.inject('/health')).json()).toEqual({ status: 'ok' });
    expect((await f.app.inject('/api/diagnostics')).statusCode).toBe(401);
    const diagnostic = await f.app.inject({ url: '/api/diagnostics', headers: auth });
    expect(diagnostic.statusCode).toBe(200);
    expect(diagnostic.json().checks).toEqual({ application: true, mtproto: true, storageChannel: true, r2: true });
    await f.app.close(); f.catalog.close();
  });

  it('registers a Telegram message once and returns opaque metadata', async () => {
    const f = setup();
    const first = await register(f);
    const second = await f.app.inject({ method: 'POST', url: '/api/files', headers: auth, payload: { messageId: '17' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.id);
    expect(f.telegram.inspectMessage).toHaveBeenCalledOnce();
    expect(first.fileName).toBe('sample movie.mp4');
    expect(JSON.stringify(first)).not.toContain('987654');
    await f.app.close(); f.catalog.close();
  });

  it('streams cached videos with byte ranges and avoids repeat Telegram fetches', async () => {
    const f = setup();
    const file = await register(f);
    const range = await f.app.inject({ url: `/file/${file.id}`, headers: { range: 'bytes=2-5' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe('bytes 2-5/16');
    expect(range.headers['content-length']).toBe('4');
    expect(range.headers['accept-ranges']).toBe('bytes');
    expect(range.body).toBe('2345');
    const whole = await f.app.inject(`/file/${file.id}`);
    expect(whole.statusCode).toBe(200);
    expect(whole.body).toBe(bytes.toString());
    expect(f.downloads).toBe(1);
    await f.app.close(); f.catalog.close();
  });

  it('de-duplicates simultaneous Telegram downloads for the same file', async () => {
    const f = setup();
    const file = await register(f);
    const [first, second] = await Promise.all([
      f.app.inject(`/file/${file.id}`),
      f.app.inject(`/file/${file.id}`),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(f.downloads).toBe(1);
    await f.app.close(); f.catalog.close();
  });

  it('supports open-ended and suffix ranges and rejects unsatisfiable ranges', async () => {
    const f = setup();
    const file = await register(f);
    const open = await f.app.inject({ url: `/file/${file.id}`, headers: { range: 'bytes=10-' } });
    expect(open.statusCode).toBe(206); expect(open.body).toBe('abcdef');
    const suffix = await f.app.inject({ url: `/file/${file.id}`, headers: { range: 'bytes=-3' } });
    expect(suffix.statusCode).toBe(206); expect(suffix.body).toBe('def');
    const unsat = await f.app.inject({ url: `/file/${file.id}`, headers: { range: 'bytes=99-' } });
    expect(unsat.statusCode).toBe(416); expect(unsat.headers['content-range']).toBe('bytes */16');
    await f.app.close(); f.catalog.close();
  });

  it('provides attachment downloads with safe original filenames', async () => {
    const f = setup(); const file = await register(f);
    const response = await f.app.inject(`/download/${file.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain('sample%20movie.mp4');
    await f.app.close(); f.catalog.close();
  });

  it('serves valid signed URLs and rejects invalid or expired tokens', async () => {
    const f = setup(); const file = await register(f);
    const parsed = new URL(file.streamUrl);
    const valid = await f.app.inject(parsed.pathname);
    expect(valid.statusCode).toBe(200);
    expect(valid.headers['cache-control']).toBe('private, no-store');
    const invalid = await f.app.inject('/v/not.a.valid.token');
    expect(invalid.statusCode).toBe(403);
    const expired = createSignedToken(file.id, streamSecret, 60, Date.now() - 120_000);
    expect((await f.app.inject(`/v/${expired}`)).statusCode).toBe(403);
    await f.app.close(); f.catalog.close();
  });

  it('requires authorization for management endpoints and returns 404 for unknown IDs', async () => {
    const f = setup();
    expect((await f.app.inject({ method: 'POST', url: '/api/files', payload: { messageId: 17 } })).statusCode).toBe(401);
    expect((await f.app.inject('/file/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    await f.app.close(); f.catalog.close();
  });

  it('maps Telegram source failures to 502', async () => {
    const f = setup({ telegramFails: true }); const file = await register(f);
    const response = await f.app.inject(`/file/${file.id}`);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('TELEGRAM_UNAVAILABLE');
    await f.app.close(); f.catalog.close();
  });

  it('maps R2 failures to 503 without exposing details', async () => {
    const f = setup({ r2Fails: true }); const file = await register(f);
    const response = await f.app.inject(`/file/${file.id}`);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('test');
    await f.app.close(); f.catalog.close();
  });

  it('deletes only the cache entry and catalog row with management authorization', async () => {
    const f = setup(); const file = await register(f);
    await f.app.inject(`/file/${file.id}`);
    expect((await f.app.inject({ method: 'DELETE', url: `/api/files/${file.id}`, headers: auth })).statusCode).toBe(204);
    expect(f.catalog.get(file.id)).toBeUndefined();
    await f.app.close(); f.catalog.close();
  });
});
