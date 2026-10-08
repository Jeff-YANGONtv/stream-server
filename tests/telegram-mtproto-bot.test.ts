import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelegramClient } from 'teleproto';
import { Api } from 'teleproto/tl';
import type { NewMessageEvent } from 'teleproto/events';
import { parseConfig } from '../src/config/env.js';
import { verifySignedToken } from '../src/security/signed-url.js';
import { SqliteFileCatalog } from '../src/services/file-catalog.js';
import { TelegramMTProtoBotService } from '../src/services/telegram/telegram-mtproto-bot-service.js';
import type { TelegramFileMetadata, TelegramService } from '../src/services/types.js';

afterEach(() => vi.restoreAllMocks());

const streamSecret = 'test-stream-secret-for-mtproto-bot-32-bytes';
const metadata: TelegramFileMetadata = {
  chatId: '-1009876543210', messageId: '55', fileName: 'uploaded-video.mp4', mimeType: 'video/mp4', size: 128_000_000, documentId: 'doc-55',
};

function setup(options: { allowedIds?: string; inspectFailsOnce?: boolean } = {}) {
  const config = parseConfig({
    APP_ENV: 'test', APP_URL: 'https://stream-server-1.ygntv.org',
    TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'test-api-hash',
    TELEGRAM_BOT_TOKEN: 'fake-bot-token', TELEGRAM_STORAGE_CHAT_ID: '-1009876543210',
    TELEGRAM_BOT_ALLOWED_USER_IDS: options.allowedIds ?? '1234567',
    STREAM_TOKEN_SECRET: streamSecret, DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent',
  });
  const catalog = new SqliteFileCatalog(':memory:');
  const inspectMessage = options.inspectFailsOnce
    ? vi.fn().mockRejectedValueOnce(new Error('test inspection fault')).mockResolvedValue(metadata)
    : vi.fn(async () => metadata);
  const telegram: TelegramService = {
    connect: vi.fn(async () => {}), inspectMessage,
    async *downloadFile() {},
    checkConnection: vi.fn(async () => true), checkAccess: vi.fn(async () => true), close: vi.fn(async () => {}),
  };
  const client = {
    start: vi.fn(async () => {}), getEntity: vi.fn(async () => ({})),
    addEventHandler: vi.fn(), removeEventHandler: vi.fn(), disconnect: vi.fn(async () => {}),
    forwardMessages: vi.fn(async () => [{ id: 55 }]),
  } as unknown as TelegramClient;
  const service = new TelegramMTProtoBotService(config, catalog, catalog, telegram, vi.fn(), client);
  return { config, catalog, telegram, service, client };
}

function documentMessage(senderId = 1234567, messageId = 18): Api.Message {
  const document = Object.create(Api.Document.prototype) as Api.Document;
  const media = Object.create(Api.MessageMediaDocument.prototype) as Api.MessageMediaDocument;
  Object.defineProperty(media, 'document', { value: document });
  return { id: messageId, out: false, senderId: { toString: () => String(senderId) }, media } as unknown as Api.Message;
}

function event(senderId = 1234567, messageId = 18, hasDocument = true): NewMessageEvent {
  const message = hasDocument
    ? documentMessage(senderId, messageId)
    : ({ id: messageId, out: false, senderId: { toString: () => String(senderId) }, media: undefined } as unknown as Api.Message);
  return {
    message,
    chatId: { toString: () => String(senderId) },
    isPrivate: true,
    reply: vi.fn(async () => undefined),
  } as unknown as NewMessageEvent;
}

describe('TelegramMTProtoBotService', () => {
  it('authorizes the bot token over MTProto, forwards a large document, and replies with a signed URL', async () => {
    const f = setup();
    await f.service.start();
    expect(f.client.start).toHaveBeenCalledWith({ botAuthToken: 'fake-bot-token' });
    expect(f.client.getEntity).toHaveBeenCalledWith('-1009876543210');
    const incoming = event();
    await f.service.handleIncomingMessage(incoming);

    expect(f.client.forwardMessages).toHaveBeenCalledOnce();
    const call = vi.mocked(f.client.forwardMessages).mock.calls[0];
    expect(call?.[0]).toBe('-1009876543210');
    expect(call?.[1]).toMatchObject({ dropAuthor: true });
    expect(f.telegram.inspectMessage).toHaveBeenCalledWith('55');
    const replyText = vi.mocked(incoming.reply).mock.calls[0]?.[0].message ?? '';
    const token = replyText.match(/\/v\/([^\s]+)/)?.[1];
    expect(token).toBeTruthy();
    const fileId = verifySignedToken(token!, streamSecret);
    expect(f.catalog.get(fileId)?.size).toBe(128_000_000);
    await f.service.close();
    f.catalog.close();
  });

  it('denies users unless their Telegram numeric ID is on the allowlist', async () => {
    const f = setup({ allowedIds: '24680' });
    const incoming = event(1234567, 22);
    await f.service.handleIncomingMessage(incoming);
    expect(f.client.forwardMessages).not.toHaveBeenCalled();
    expect(vi.mocked(incoming.reply).mock.calls[0]?.[0].message).toContain('ခွင့်မရှိပါ');
    f.catalog.close();
  });

  it('fails closed when the allowlist is empty', async () => {
    const f = setup({ allowedIds: '' });
    const incoming = event(1234567, 26);
    await f.service.handleIncomingMessage(incoming);
    expect(f.client.forwardMessages).not.toHaveBeenCalled();
    expect(vi.mocked(incoming.reply).mock.calls[0]?.[0].message).toContain('ခွင့်မရှိပါ');
    f.catalog.close();
  });

  it('does not forward non-document messages', async () => {
    const f = setup();
    const incoming = event(1234567, 23, false);
    await f.service.handleIncomingMessage(incoming);
    expect(f.client.forwardMessages).not.toHaveBeenCalled();
    expect(vi.mocked(incoming.reply).mock.calls[0]?.[0].message).toContain('document');
    f.catalog.close();
  });

  it('deduplicates completed MTProto messages and reuses the registered file', async () => {
    const f = setup();
    const first = event(1234567, 24);
    const duplicate = event(1234567, 24);
    await f.service.handleIncomingMessage(first);
    await f.service.handleIncomingMessage(duplicate);
    expect(f.client.forwardMessages).toHaveBeenCalledOnce();
    expect(f.telegram.inspectMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(duplicate.reply).mock.calls[0]?.[0].message).toContain('/v/');
    f.catalog.close();
  });

  it('remembers the copied channel message and does not forward it twice after an inspection failure', async () => {
    const f = setup({ inspectFailsOnce: true });
    const first = event(1234567, 25);
    const retry = event(1234567, 25);
    await f.service.handleIncomingMessage(first);
    await f.service.handleIncomingMessage(retry);
    expect(f.client.forwardMessages).toHaveBeenCalledOnce();
    expect(vi.mocked(retry.reply).mock.calls[0]?.[0].message).toContain('/v/');
    f.catalog.close();
  });

  it('uses both source chat and message ID as the persistent deduplication key', () => {
    const catalog = new SqliteFileCatalog(':memory:');
    const first = catalog.claim('1001', 9);
    const second = catalog.claim('1002', 9);
    expect(first.kind).toBe('acquired');
    expect(second.kind).toBe('acquired');
    catalog.close();
  });
});
