import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Api } from 'teleproto/tl';
import type { AppConfig } from '../../config/env.js';
import { NotFoundError, TelegramUnavailableError } from '../../utils/errors.js';
import type { TelegramFileMetadata, TelegramService } from '../types.js';

export class TelegramMTProtoService implements TelegramService {
  private readonly client: TelegramClient;
  private entity: string | undefined;
  private connected = false;

  constructor(private readonly config: AppConfig, client?: TelegramClient) {
    if (!client) {
      if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH || !config.TELEGRAM_SESSION || !config.TELEGRAM_STORAGE_CHAT_ID) {
        throw new TelegramUnavailableError('MTProto credentials, persistent session, and storage channel are required');
      }
      this.client = new TelegramClient(new StringSession(config.TELEGRAM_SESSION), config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
        connectionRetries: 5, maxConcurrentDownloads: 2,
      });
    } else this.client = client;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.client.connect();
      if (!await this.client.checkAuthorization()) {
        await this.client.disconnect();
        throw new Error('Persistent session is not authorized; create a user StringSession before deployment');
      }
      const chatId = this.requireChatId();
      await this.client.getEntity(chatId);
      this.entity = chatId;
      this.connected = true;
    } catch (error) {
      throw new TelegramUnavailableError('Could not connect to Telegram MTProto or resolve the configured storage channel', { cause: error });
    }
  }

  async checkConnection(): Promise<boolean> {
    try { await this.connect(); return true; } catch { return false; }
  }

  async checkAccess(): Promise<boolean> {
    try { await this.connect(); await this.client.getMessages(this.entity, { limit: 1 }); return true; }
    catch { return false; }
  }

  async inspectMessage(messageId: string): Promise<TelegramFileMetadata> {
    await this.connect();
    try {
      const messages = await this.client.getMessages(this.entity, { ids: Number(messageId) });
      const message = messages[0];
      if (!message || !(message.media instanceof Api.MessageMediaDocument) || !(message.media.document instanceof Api.Document)) {
        throw new NotFoundError('Telegram message has no document media');
      }
      const document = message.media.document;
      const filenameAttribute = document.attributes.find((attribute) => attribute instanceof Api.DocumentAttributeFilename);
      const fileName = filenameAttribute instanceof Api.DocumentAttributeFilename ? filenameAttribute.fileName : `${document.id}.bin`;
      const size = Number(document.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new TelegramUnavailableError('Telegram returned an invalid file size');
      return { chatId: this.requireChatId(), messageId: String(message.id), fileName: sanitizeFilename(fileName),
        mimeType: document.mimeType || 'application/octet-stream', size, documentId: document.id.toString() };
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof TelegramUnavailableError) throw error;
      throw new TelegramUnavailableError('Could not inspect Telegram storage message', { cause: error });
    }
  }

  async *downloadFile(messageId: string, offset = 0, limit?: number): AsyncIterable<Uint8Array> {
    await this.connect();
    try {
      const messages = await this.client.getMessages(this.entity, { ids: Number(messageId) });
      const message = messages[0];
      if (!message || !(message.media instanceof Api.MessageMediaDocument) || !(message.media.document instanceof Api.Document)) {
        throw new NotFoundError('Telegram source document is no longer available');
      }
      yield* this.client.iterDownload(message, { offset, ...(limit === undefined ? {} : { limit }), requestSize: 512 * 1024 });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof TelegramUnavailableError) throw error;
      throw new TelegramUnavailableError('Telegram chunk download failed', { cause: error });
    }
  }

  async close(): Promise<void> { if (this.connected) { await this.client.disconnect(); this.connected = false; } }
  private requireChatId(): string {
    const chatId = this.config.TELEGRAM_STORAGE_CHAT_ID;
    if (!chatId) throw new TelegramUnavailableError('TELEGRAM_STORAGE_CHAT_ID is not configured');
    return chatId;
  }
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[\\/\r\n\0]/g, '_').trim().slice(0, 240) || 'video.bin';
}
