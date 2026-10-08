import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotUpdateClaim, BotUpdateStore, FileCatalog, FileRecord, TelegramFileMetadata } from './types.js';

interface Row { id: string; telegram_chat_id: string; message_id: string; file_name: string; mime_type: string; size: number; telegram_document_id: string | null; created_at: string; }
interface BotUpdateRow { source_chat_id: string; source_message_id: number; status: 'processing' | 'completed' | 'rejected'; lease_token: string | null; lease_until: number; copied_message_id: number | null; file_id: string | null; }
const toRecord = (row: Row | undefined): FileRecord | undefined => row && ({
  id: row.id, chatId: row.telegram_chat_id, messageId: row.message_id, fileName: row.file_name,
  mimeType: row.mime_type, size: row.size, telegramDocumentId: row.telegram_document_id, createdAt: row.created_at,
});

export class SqliteFileCatalog implements FileCatalog, BotUpdateStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, telegram_chat_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0),
      telegram_document_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_bot_updates (
      source_chat_id TEXT NOT NULL,
      source_message_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('processing','completed','rejected')),
      lease_token TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0,
      copied_message_id INTEGER,
      file_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(source_chat_id, source_message_id)
    );`);
  }
  get(id: string): FileRecord | undefined {
    return toRecord(this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Row | undefined);
  }
  findByMessage(messageId: string): FileRecord | undefined {
    return toRecord(this.db.prepare('SELECT * FROM files WHERE message_id = ?').get(messageId) as Row | undefined);
  }
  create(metadata: TelegramFileMetadata): FileRecord {
    const prior = this.findByMessage(metadata.messageId);
    if (prior) return prior;
    const record: FileRecord = {
      id: randomUUID(), chatId: metadata.chatId, messageId: metadata.messageId, fileName: metadata.fileName,
      mimeType: metadata.mimeType || 'application/octet-stream', size: metadata.size,
      telegramDocumentId: metadata.documentId, createdAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO files (id,telegram_chat_id,message_id,file_name,mime_type,size,telegram_document_id,created_at)
      VALUES (@id,@chatId,@messageId,@fileName,@mimeType,@size,@telegramDocumentId,@createdAt)`).run(record);
    return record;
  }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM files WHERE id = ?').run(id).changes > 0; }

  claim(sourceChatId: string, sourceMessageId: number): BotUpdateClaim {
    const transaction = this.db.transaction((chatId: string, messageId: number): BotUpdateClaim => {
      const row = this.db.prepare('SELECT * FROM telegram_bot_updates WHERE source_chat_id = ? AND source_message_id = ?')
        .get(chatId, messageId) as BotUpdateRow | undefined;
      const now = Date.now();
      if (row?.status === 'completed' || row?.status === 'rejected') {
        return { kind: 'completed', status: row.status, ...(row.file_id ? { fileId: row.file_id } : {}) };
      }
      if (row?.lease_token && row.lease_until > now) return { kind: 'busy' };
      const leaseToken = randomUUID();
      if (row) {
        this.db.prepare(`UPDATE telegram_bot_updates SET lease_token = ?, lease_until = ?, updated_at = ?
          WHERE source_chat_id = ? AND source_message_id = ?`)
          .run(leaseToken, now + 5 * 60_000, new Date(now).toISOString(), chatId, messageId);
      } else {
        this.db.prepare(`INSERT INTO telegram_bot_updates (source_chat_id,source_message_id,status,lease_token,lease_until,updated_at)
          VALUES (?, ?, 'processing', ?, ?, ?)`)
          .run(chatId, messageId, leaseToken, now + 5 * 60_000, new Date(now).toISOString());
      }
      return { kind: 'acquired', leaseToken, ...(row?.copied_message_id === null || row?.copied_message_id === undefined ? {} : { copiedMessageId: row.copied_message_id }) };
    });
    return transaction.immediate(sourceChatId, sourceMessageId);
  }

  recordCopy(sourceChatId: string, sourceMessageId: number, leaseToken: string, copiedMessageId: number): void {
    const result = this.db.prepare(`UPDATE telegram_bot_updates SET copied_message_id = ?, updated_at = ?
      WHERE source_chat_id = ? AND source_message_id = ? AND status = 'processing' AND lease_token = ?`)
      .run(copiedMessageId, new Date().toISOString(), sourceChatId, sourceMessageId, leaseToken);
    if (result.changes !== 1) throw new Error('Telegram bot update processing lease expired');
  }

  complete(sourceChatId: string, sourceMessageId: number, leaseToken: string, outcome: 'completed' | 'rejected', fileId?: string): void {
    const result = this.db.prepare(`UPDATE telegram_bot_updates SET status = ?, file_id = ?, lease_token = NULL, lease_until = 0, updated_at = ?
      WHERE source_chat_id = ? AND source_message_id = ? AND status = 'processing' AND lease_token = ?`)
      .run(outcome, fileId ?? null, new Date().toISOString(), sourceChatId, sourceMessageId, leaseToken);
    if (result.changes !== 1) throw new Error('Telegram bot update processing lease expired');
  }

  release(sourceChatId: string, sourceMessageId: number, leaseToken: string): void {
    this.db.prepare(`UPDATE telegram_bot_updates SET lease_token = NULL, lease_until = 0, updated_at = ?
      WHERE source_chat_id = ? AND source_message_id = ? AND status = 'processing' AND lease_token = ?`)
      .run(new Date().toISOString(), sourceChatId, sourceMessageId, leaseToken);
  }
  close(): void { this.db.close(); }
}
