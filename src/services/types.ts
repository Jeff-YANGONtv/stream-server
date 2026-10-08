export interface FileRecord {
  id: string;
  chatId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  size: number;
  telegramDocumentId: string | null;
  createdAt: string;
}

export interface TelegramFileMetadata {
  chatId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  size: number;
  documentId: string | null;
}

export interface FileCatalog {
  get(id: string): FileRecord | undefined;
  findByMessage(messageId: string): FileRecord | undefined;
  create(metadata: TelegramFileMetadata): FileRecord;
  delete(id: string): boolean;
  close?(): void;
}

export interface TelegramService {
  connect(): Promise<void>;
  inspectMessage(messageId: string): Promise<TelegramFileMetadata>;
  downloadFile(messageId: string, offset?: number, limit?: number): AsyncIterable<Uint8Array>;
  checkConnection(): Promise<boolean>;
  checkAccess(): Promise<boolean>;
  close(): Promise<void>;
}
