import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from './config/env.js';
import type { FileCatalog, FileRecord, TelegramService } from './services/types.js';
import type { R2StorageService } from './services/r2/types.js';
import { CacheCoordinator } from './streaming/cache-coordinator.js';
import { parseRange } from './streaming/range.js';
import { createSignedToken, verifySignedToken } from './security/signed-url.js';
import { managementAuthorized } from './security/auth.js';
import { AppError, NotFoundError, StorageUnavailableError } from './utils/errors.js';

export interface AppDependencies {
  config: AppConfig;
  catalog: FileCatalog;
  telegram: TelegramService;
  r2: R2StorageService;
}

const idSchema = z.string().uuid();
const createSchema = z.object({ messageId: z.union([z.string(), z.number().int()]) });

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.LOG_LEVEL, redact: ['req.headers.authorization', 'headers.authorization'] },
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { maxParamLength: 512 },
    genReqId: () => randomUUID(),
  });
  const cache = new CacheCoordinator(deps.telegram, deps.r2);

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      requestId: request.id,
      fileId: safeFileId(request),
      endpoint: request.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      responseTimeMs: Math.round(reply.elapsedTime * 100) / 100,
      range: Boolean(request.headers.range),
    }, 'request complete');
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof AppError ? error : undefined;
    const status = appError?.statusCode ?? 500;
    request.log.error({ requestId: request.id, endpoint: request.routeOptions.url ?? 'unmatched', status,
      code: appError?.code ?? 'INTERNAL_ERROR' }, 'request failed');
    if (reply.sent) return;
    return reply.code(status).send({ error: appError?.code ?? 'INTERNAL_ERROR', message: status >= 500 ? 'Request could not be completed' : appError?.message });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/diagnostics', async (request, reply) => {
    if (!managementAuthorized(request, deps.config)) return reply.code(deps.config.MANAGEMENT_API_TOKEN ? 401 : 503).send({ error: 'UNAUTHORIZED', message: 'Management authentication is not configured or invalid' });
    const [telegramConnected, telegramChannelAccess, r2Available] = await Promise.all([
      deps.telegram.checkConnection(), deps.telegram.checkAccess(), deps.r2.check(),
    ]);
    const healthy = telegramConnected && telegramChannelAccess && r2Available;
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded', checks: { application: true, mtproto: telegramConnected, storageChannel: telegramChannelAccess, r2: r2Available },
    });
  });

  app.post('/api/files', async (request, reply) => {
    if (!managementAuthorized(request, deps.config)) return reply.code(deps.config.MANAGEMENT_API_TOKEN ? 401 : 503).send({ error: 'UNAUTHORIZED', message: 'Management authentication is not configured or invalid' });
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('messageId must be a positive Telegram message ID', 400, 'INVALID_REQUEST');
    const messageId = String(parsed.data.messageId);
    if (!/^\d{1,10}$/.test(messageId) || Number(messageId) < 1 || Number(messageId) > 2_147_483_647) {
      throw new AppError('messageId must be a positive Telegram message ID', 400, 'INVALID_REQUEST');
    }
    const existing = deps.catalog.findByMessage(messageId);
    const record = existing ?? deps.catalog.create(await deps.telegram.inspectMessage(messageId));
    request.log.info({ requestId: request.id, fileId: record.id }, existing ? 'file registration reused' : 'file registered from Telegram');
    return reply.code(existing ? 200 : 201).send(publicRecord(record, deps.config, createSignedToken(record.id, deps.config.STREAM_TOKEN_SECRET)));
  });

  app.get<{ Params: { id: string } }>('/api/files/:id', async (request, reply) => {
    if (!managementAuthorized(request, deps.config)) return reply.code(deps.config.MANAGEMENT_API_TOKEN ? 401 : 503).send({ error: 'UNAUTHORIZED', message: 'Management authentication is not configured or invalid' });
    const record = findFile(deps.catalog, request.params.id);
    return reply.send(publicRecord(record, deps.config, createSignedToken(record.id, deps.config.STREAM_TOKEN_SECRET)));
  });

  app.delete<{ Params: { id: string } }>('/api/files/:id', async (request, reply) => {
    if (!managementAuthorized(request, deps.config)) return reply.code(deps.config.MANAGEMENT_API_TOKEN ? 401 : 503).send({ error: 'UNAUTHORIZED', message: 'Management authentication is not configured or invalid' });
    const record = findFile(deps.catalog, request.params.id);
    await deps.r2.delete(cache.key(record));
    deps.catalog.delete(record.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/file/:id', async (request, reply) =>
    streamFile(request, reply, findFile(deps.catalog, request.params.id), false));
  app.get<{ Params: { id: string } }>('/download/:id', async (request, reply) =>
    streamFile(request, reply, findFile(deps.catalog, request.params.id), true));
  app.get<{ Params: { token: string } }>('/v/:token', async (request, reply) => {
    const id = verifySignedToken(request.params.token, deps.config.STREAM_TOKEN_SECRET);
    return streamFile(request, reply, findFile(deps.catalog, id), false, true);
  });

  async function streamFile(request: FastifyRequest, reply: import('fastify').FastifyReply, record: FileRecord, download: boolean, signed = false) {
    const cacheResult = await cache.ensureCached(record);
    request.log.info({ requestId: request.id, fileId: record.id, cache: cacheResult }, 'video cache lookup');
    const metadata = await deps.r2.metadata(cache.key(record));
    if (!metadata) throw new StorageUnavailableError('Cached object disappeared during playback');
    let range;
    try { range = parseRange(request.headers.range, metadata.size); }
    catch (error) {
      if (error instanceof AppError && error.statusCode === 416) {
        return reply.code(416).header('Content-Range', `bytes */${metadata.size}`).header('Accept-Ranges', 'bytes').send();
      }
      throw error;
    }
    const object = await deps.r2.get(cache.key(record), range);
    const responseLength = range ? range.end - range.start + 1 : metadata.size;
    reply.code(range ? 206 : 200)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', responseLength)
      .header('Content-Type', safeContentType(metadata.contentType, record.mimeType))
      .header('ETag', object.etag ?? metadata.etag ?? '"' + record.id + '"')
      .header('Cache-Control', signed ? 'private, no-store' : 'public, max-age=3600, s-maxage=86400')
      .header('Content-Disposition', contentDisposition(record.fileName, download));
    if (range) reply.header('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`);
    return reply.send(object.body);
  }

  return app;
}

function findFile(catalog: FileCatalog, rawId: string): FileRecord {
  if (!idSchema.safeParse(rawId).success) throw new NotFoundError();
  const record = catalog.get(rawId);
  if (!record) throw new NotFoundError();
  return record;
}

function safeFileId(request: FastifyRequest): string | undefined {
  const params = request.params as { id?: unknown };
  return typeof params.id === 'string' && idSchema.safeParse(params.id).success ? params.id : undefined;
}

function publicRecord(record: FileRecord, config: AppConfig, token: string) {
  return { id: record.id, fileName: record.fileName, mimeType: record.mimeType, size: record.size,
    createdAt: record.createdAt, streamUrl: `${config.APP_URL.replace(/\/$/, '')}/v/${token}` };
}

function contentDisposition(filename: string, attachment: boolean): string {
  const safe = filename.replace(/[\r\n"\\]/g, '_').slice(0, 240) || 'video.bin';
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function safeContentType(primary: string, fallback: string): string {
  const valid = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
  return valid.test(primary) ? primary : valid.test(fallback) ? fallback : 'application/octet-stream';
}
