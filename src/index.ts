import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { parseConfig } from './config/env.js';
import { buildApp } from './app.js';
import { SqliteFileCatalog } from './services/file-catalog.js';
import { TelegramMTProtoService } from './services/telegram/telegram-mtproto-service.js';
import { TelegramMTProtoBotService } from './services/telegram/telegram-mtproto-bot-service.js';
import { CloudflareR2Storage } from './services/r2/r2-storage-service.js';
import type { TelegramFileMetadata, TelegramService } from './services/types.js';
import type { ObjectMetadata, ObjectRead, R2StorageService } from './services/r2/types.js';
import { StorageUnavailableError, TelegramUnavailableError } from './utils/errors.js';

class UnconfiguredTelegram implements TelegramService {
  async connect(): Promise<void> { throw new TelegramUnavailableError('MTProto is not configured'); }
  async inspectMessage(_messageId: string): Promise<TelegramFileMetadata> { throw new TelegramUnavailableError('MTProto is not configured'); }
  async *downloadFile(_messageId: string): AsyncIterable<Uint8Array> { throw new TelegramUnavailableError('MTProto is not configured'); }
  async checkConnection(): Promise<boolean> { return false; }
  async checkAccess(): Promise<boolean> { return false; }
  async close(): Promise<void> {}
}

class UnconfiguredR2 implements R2StorageService {
  private failure(): StorageUnavailableError { return new StorageUnavailableError('R2 is not configured'); }
  async exists(_key: string): Promise<boolean> { throw this.failure(); }
  async get(_key: string, _range?: { start: number; end: number }): Promise<ObjectRead> { throw this.failure(); }
  async upload(_key: string, _source: Readable, _size: number, _contentType: string): Promise<void> { throw this.failure(); }
  async delete(_key: string): Promise<void> { throw this.failure(); }
  async metadata(_key: string): Promise<ObjectMetadata | undefined> { throw this.failure(); }
  async check(): Promise<boolean> { return false; }
}

async function main(): Promise<void> {
  const config = parseConfig();
  if (config.DATABASE_PATH !== ':memory:') mkdirSync(dirname(config.DATABASE_PATH), { recursive: true, mode: 0o700 });
  const catalog = new SqliteFileCatalog(config.DATABASE_PATH);
  const telegramConfigured = Boolean(config.TELEGRAM_API_ID && config.TELEGRAM_API_HASH && config.TELEGRAM_SESSION && config.TELEGRAM_STORAGE_CHAT_ID);
  const r2Configured = Boolean(config.CF_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && config.R2_BUCKET_NAME);
  const telegram: TelegramService = telegramConfigured ? new TelegramMTProtoService(config) : new UnconfiguredTelegram();
  const r2: R2StorageService = r2Configured ? new CloudflareR2Storage(config) : new UnconfiguredR2();
  const app = buildApp({ config, catalog, telegram, r2 });
  const botConfigured = telegramConfigured && r2Configured && Boolean(config.TELEGRAM_BOT_TOKEN && config.STREAM_TOKEN_SECRET);
  const bot = botConfigured
    ? new TelegramMTProtoBotService(config, catalog, catalog, telegram, (message, errorName) => app.log.warn({ errorName }, message))
    : undefined;

  if (!telegramConfigured) app.log.warn('MTProto is not configured; management ingest and cache misses will be unavailable');
  else app.log.info({ connected: await telegram.checkConnection(), channelAccessible: await telegram.checkAccess() }, 'MTProto startup check completed');
  if (!r2Configured) app.log.warn('R2 is not configured; file delivery is unavailable');
  else app.log.info({ available: await r2.check() }, 'R2 startup check completed');
  if (bot) {
    try {
      await bot.start();
      app.log.info({ allowlistEntries: config.TELEGRAM_BOT_ALLOWED_USER_IDS.length }, 'Telegram MTProto upload bot started');
      if (config.TELEGRAM_BOT_ALLOWED_USER_IDS.length === 0) app.log.warn('Telegram MTProto bot allowlist is empty; uploads are denied');
    } catch (error) {
      app.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Telegram MTProto upload bot did not start');
    }
  } else if (config.TELEGRAM_BOT_TOKEN) {
    app.log.warn('Telegram MTProto bot is configured incompletely; bot intake is disabled until Telegram, R2, and signing secrets are available');
  }

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info({ host: config.HOST, port: config.PORT }, 'stream server listening');
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'graceful shutdown started');
    await bot?.close();
    await app.close();
    catalog.close();
    await telegram.close();
    if ('close' in r2 && typeof r2.close === 'function') await r2.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error: unknown) => {
  // Do not print error payloads; startup failures may contain library details.
  console.error('Server startup failed', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
});
