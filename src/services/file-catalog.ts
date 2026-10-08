import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileCatalog, FileRecord, TelegramFileMetadata } from './types.js';

interface Row { id: string; telegram_chat_id: string; message_id: string; file_name: string; mime_type: string; size: number; telegram_document_id: string | null; created_at: string; }
const toRecord = (row: Row | undefined): FileRecord | undefined => row && ({
  id: row.id, chatId: row.telegram_chat_id, messageId: row.message_id, fileName: row.file_name,
  mimeType: row.mime_type, size: row.size, telegramDocumentId: row.telegram_document_id, createdAt: row.created_at,
});

export class SqliteFileCatalog implements FileCatalog {
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
  close(): void { this.db.close(); }
}
