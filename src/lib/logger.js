import pino from 'pino';

const redact = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-api-key',
  'config.ADMIN_PASSWORD_HASH',
  'config.SESSION_SECRET',
  'config.SCRAPECREATORS_API_KEY',
  'config.SOCIALCRAWL_API_KEY',
  'config.GROQ_API_KEY',
  'config.LLM_API_KEY'
];

export function createLogger(service = 'web', level = process.env.LOG_LEVEL || 'info') {
  return pino({ level, base: { service }, redact });
}
