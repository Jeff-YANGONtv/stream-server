export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'File not found') { super(message, 404, 'NOT_FOUND'); }
}

export class TelegramUnavailableError extends AppError {
  constructor(message = 'Telegram source is unavailable', options?: ErrorOptions) {
    super(message, 502, 'TELEGRAM_UNAVAILABLE', options);
  }
}

export class StorageUnavailableError extends AppError {
  constructor(message = 'Object storage is unavailable', options?: ErrorOptions) {
    super(message, 503, 'STORAGE_UNAVAILABLE', options);
  }
}
