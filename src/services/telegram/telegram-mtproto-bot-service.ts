import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TelegramClient } from 'teleproto';
import { NewMessage, type NewMessageEvent } from 'teleproto/events';
import { StoreSession } from 'teleproto/sessions';
import { Api } from 'teleproto/tl';
import type { AppConfig } from '../../config/env.js';
import { createSignedToken } from '../../security/signed-url.js';
import type { BotUpdateStore, FileCatalog, TelegramService } from '../types.js';

export type BotLogger = (message: string, errorName?: string) => void;

export class TelegramMTProtoBotService {
  private readonly client: TelegramClient;
  private readonly messageBuilder = new NewMessage({ incoming: true });
  private connected = false;
  private readonly eventHandler = (event: NewMessageEvent): void => {
    void this.handleIncomingMessage(event).catch((error: unknown) => {
      this.log('Telegram MTProto bot event processing failed', error instanceof Error ? error.name : 'UnknownError');
    });
  };

  constructor(
    private readonly config: AppConfig,
    private readonly catalog: FileCatalog,
    private readonly updates: BotUpdateStore,
    private readonly telegram: TelegramService,
    private readonly log: BotLogger = () => {},
    client?: TelegramClient,
  ) {
    if (!client) {
      if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH || !config.TELEGRAM_BOT_TOKEN) {
        throw new Error('MTProto bot API ID, API hash, and BotFather token are required');
      }
      const sessionPath = resolve(config.TELEGRAM_BOT_SESSION_PATH);
      mkdirSync(dirname(sessionPath), { recursive: true, mode: 0o700 });
      mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
      chmodSync(sessionPath, 0o700);
      const session = new StoreSession(sessionPath);
      this.client = new TelegramClient(session, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
        connectionRetries: 5,
      });
    } else {
      this.client = client;
    }
  }

  async start(): Promise<void> {
    if (this.connected) return;
    const token = this.config.TELEGRAM_BOT_TOKEN;
    const storageChatId = this.config.TELEGRAM_STORAGE_CHAT_ID;
    if (!token || !storageChatId) throw new Error('MTProto bot token or storage channel is not configured');
    try {
      await this.client.start({ botAuthToken: token });
      await this.client.getEntity(storageChatId);
      this.client.addEventHandler(this.eventHandler, this.messageBuilder);
      this.connected = true;
    } catch (error) {
      await this.client.disconnect().catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.client.removeEventHandler(this.eventHandler, this.messageBuilder);
    await this.client.disconnect();
    this.connected = false;
  }

  async handleIncomingMessage(event: NewMessageEvent): Promise<void> {
    const message = event.message;
    if (message.out || !event.isPrivate) return;

    const sourceChatId = message.senderId?.toString();
    const sourceMessageId = message.id;
    if (!sourceChatId || !Number.isSafeInteger(sourceMessageId) || sourceMessageId < 1) return;

    const claim = this.updates.claim(sourceChatId, sourceMessageId);
    if (claim.kind === 'busy') return;
    if (claim.kind === 'completed') {
      if (claim.status === 'completed' && claim.fileId) await this.sendFileLink(event, claim.fileId);
      return;
    }

    const { leaseToken } = claim;
    try {
      const senderId = Number(sourceChatId);
      if (!Number.isSafeInteger(senderId) || !this.config.TELEGRAM_BOT_ALLOWED_USER_IDS.includes(senderId)) {
        await event.reply({ message: 'ဒီ bot ကို အသုံးပြုရန် ခွင့်မရှိပါ။' });
        this.updates.complete(sourceChatId, sourceMessageId, leaseToken, 'rejected');
        return;
      }

      if (!(message.media instanceof Api.MessageMediaDocument) || !(message.media.document instanceof Api.Document)) {
        await event.reply({ message: 'ဗီဒီယို သို့မဟုတ် document ဖိုင်တစ်ခုကို private chat မှာ ပို့ပါ။' });
        this.updates.complete(sourceChatId, sourceMessageId, leaseToken, 'rejected');
        return;
      }

      let copiedMessageId = claim.copiedMessageId;
      if (copiedMessageId === undefined) {
        const forwarded = await this.client.forwardMessages(this.requireStorageChatId(), {
          messages: message,
          fromPeer: event.chatId ?? sourceChatId,
          dropAuthor: true,
        });
        const storedMessage = forwarded.find((item) => item && Number.isSafeInteger(item.id) && item.id > 0);
        if (!storedMessage) throw new Error('Telegram did not return a stored channel message');
        copiedMessageId = storedMessage.id;
        this.updates.recordCopy(sourceChatId, sourceMessageId, leaseToken, copiedMessageId);
      }

      const existing = this.catalog.findByMessage(String(copiedMessageId));
      const record = existing ?? this.catalog.create(await this.telegram.inspectMessage(String(copiedMessageId)));
      await event.reply({ message: `သင့်ဖိုင်အတွက် stream URL (၁ နာရီအတွင်း သက်တမ်းကုန်မည်):\n${this.streamUrl(record.id)}` });
      this.updates.complete(sourceChatId, sourceMessageId, leaseToken, 'completed', record.id);
    } catch (error) {
      this.updates.release(sourceChatId, sourceMessageId, leaseToken);
      try { await event.reply({ message: 'ဖိုင်ကို ပြင်ဆင်မရပါ။ ခဏကြာပြီးနောက် ထပ်ပို့ကြည့်ပါ။' }); }
      catch { /* The sender can retry by sending the file again. */ }
      this.log('Telegram MTProto bot could not process an upload', error instanceof Error ? error.name : 'UnknownError');
    }
  }

  private async sendFileLink(event: NewMessageEvent, fileId: string): Promise<void> {
    const record = this.catalog.get(fileId);
    if (!record) return;
    await event.reply({ message: `သင့်ဖိုင်အတွက် stream URL (၁ နာရီအတွင်း သက်တမ်းကုန်မည်):\n${this.streamUrl(record.id)}` });
  }

  private streamUrl(fileId: string): string {
    const secret = this.config.STREAM_TOKEN_SECRET;
    if (!secret) throw new Error('STREAM_TOKEN_SECRET is not configured');
    const token = createSignedToken(fileId, secret);
    return `${this.config.APP_URL.replace(/\/$/, '')}/v/${token}`;
  }

  private requireStorageChatId(): string {
    const chatId = this.config.TELEGRAM_STORAGE_CHAT_ID;
    if (!chatId) throw new Error('TELEGRAM_STORAGE_CHAT_ID is not configured');
    return chatId;
  }
}
