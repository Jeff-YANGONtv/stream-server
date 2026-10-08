import 'dotenv/config';
import { z } from 'zod';

const optionalString = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());
const optionalPositiveInt = z.preprocess((value) => value === '' ? undefined : value, z.coerce.number().int().positive().optional());

const schema = z.object({
  APP_ENV: z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.toLowerCase();
    return normalized === 'prod' ? 'production' : normalized === 'dev' ? 'development' : normalized;
  }, z.enum(['development', 'test', 'production']).default('development')),
  APP_URL: z.string().url().default('http://localhost:3000'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.preprocess((value) => value === '' ? undefined : value, z.coerce.number().int().min(1).max(65535).default(3000)),
  TELEGRAM_API_ID: optionalPositiveInt,
  TELEGRAM_API_HASH: optionalString,
  TELEGRAM_SESSION: optionalString,
  TELEGRAM_STORAGE_CHAT_ID: optionalString,
  CF_ACCOUNT_ID: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET_NAME: optionalString,
  STREAM_TOKEN_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  MANAGEMENT_API_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(24).optional()),
  DATABASE_PATH: z.string().default('./data/catalog.sqlite'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof schema>;

export function parseConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const summary = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${summary}`);
  }
  return parsed.data;
}
