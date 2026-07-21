import { z } from 'zod';

const emptyToUndefined = (value) => value === '' ? undefined : value;
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().regex(/^\$2[aby]\$\d{2}\$.{53}$/),
  SESSION_SECRET: z.string().min(32),
  APP_DOMAIN: z.string().min(1).default('localhost'),
  SCRAPECREATORS_API_KEY: optionalString,
  SOCIALCRAWL_API_KEY: optionalString,
  GROQ_API_KEY: optionalString,
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  PROFILE_FRESHNESS_DAYS: z.coerce.number().int().min(1).max(30).default(3),
  DISCOVERY_DEFAULT_LIMIT: z.coerce.number().int().min(1).default(5),
  DISCOVERY_MAX_LIMIT: z.coerce.number().int().min(1).max(500).default(100),
  REELS_DEFAULT_LIMIT: z.coerce.number().int().min(1).default(3),
  REELS_MAX_LIMIT: z.coerce.number().int().min(1).max(100).default(20),
  GROQ_WHISPER_MODEL: z.string().min(1).default('whisper-large-v3-turbo'),
  GROQ_WHISPER_LANGUAGE: z.string().length(2).default('ru'),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(20).default(2),
  CSV_MAX_ROWS: z.coerce.number().int().min(1).max(10000).default(500),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7)
}).superRefine((value, ctx) => {
  if (value.DISCOVERY_DEFAULT_LIMIT > value.DISCOVERY_MAX_LIMIT) {
    ctx.addIssue({ code: 'custom', path: ['DISCOVERY_DEFAULT_LIMIT'], message: 'must not exceed DISCOVERY_MAX_LIMIT' });
  }
  if (value.REELS_DEFAULT_LIMIT > value.REELS_MAX_LIMIT) {
    ctx.addIssue({ code: 'custom', path: ['REELS_DEFAULT_LIMIT'], message: 'must not exceed REELS_MAX_LIMIT' });
  }
});

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const value = parsed.data;
  return Object.freeze({
    ...value,
    isProduction: value.NODE_ENV === 'production',
    sessionTtlMs: value.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    freshnessMs: value.PROFILE_FRESHNESS_DAYS * 24 * 60 * 60 * 1000,
    uploadMaxBytes: value.UPLOAD_MAX_MB * 1024 * 1024
  });
}
