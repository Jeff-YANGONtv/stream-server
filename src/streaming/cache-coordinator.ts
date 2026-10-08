import type { FileRecord, TelegramService } from '../services/types.js';
import type { R2StorageService } from '../services/r2/types.js';
import { iterableToReadable } from '../services/r2/r2-storage-service.js';
import { NotFoundError, TelegramUnavailableError } from '../utils/errors.js';

export class CacheCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(private readonly telegram: TelegramService, private readonly r2: R2StorageService) {}
  key(file: FileRecord): string { return `videos/${file.id}.mp4`; }
  async ensureCached(file: FileRecord): Promise<'HIT' | 'MISS'> {
    const key = this.key(file);
    if (await this.r2.exists(key)) return 'HIT';
    let pending = this.inFlight.get(file.id);
    if (!pending) {
      pending = this.fetchAndCache(file, key).finally(() => this.inFlight.delete(file.id));
      this.inFlight.set(file.id, pending);
    }
    await pending;
    return 'MISS';
  }
  private async fetchAndCache(file: FileRecord, key: string): Promise<void> {
    try {
      if (await this.r2.exists(key)) return;
      const source = iterableToReadable(this.telegram.downloadFile(file.messageId));
      await this.r2.upload(key, source, file.size, file.mimeType);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      if ((error as { statusCode?: number }).statusCode === 503) throw error;
      throw new TelegramUnavailableError('Unable to retrieve source media from Telegram', { cause: error });
    }
  }
}
