import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { authHandlers, requireAuth } from './middleware/auth.js';
import { csrfToken, verifyCsrf } from './middleware/csrf.js';
import { i18nMiddleware } from './i18n/index.js';
import { createPageRouter } from './routes/pages.js';
import { createActionRouter } from './routes/actions.js';
import { getSchemaStatus } from './db/schema.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ config, pool, logger }) {
  const app = express();
  const PgSession = connectPgSimple(session);
  app.set('trust proxy', config.isProduction ? 1 : false);
  app.set('view engine', 'ejs');
  app.set('views', path.join(currentDir, 'views'));
  app.disable('x-powered-by');

  app.use(pinoHttp({ logger, genReqId: (req, res) => {
    const id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  }}));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"], styleSrc: ["'self'"], connectSrc: ["'self'"]
      }
    }
  }));
  app.use(express.urlencoded({ extended: false, limit: `${config.UPLOAD_MAX_MB}mb` }));
  app.use(express.json({ limit: '256kb' }));
  app.use('/assets', express.static(path.join(currentDir, 'public'), { maxAge: config.isProduction ? '1d' : 0 }));
  app.get('/assets/htmx.min.js', (_req, res) => res.sendFile(path.resolve(currentDir, '../node_modules/htmx.org/dist/htmx.min.js')));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      const schema = await getSchemaStatus(pool);
      if (!schema.compatible) return res.status(503).json({ status: 'unready' });
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unready' });
    }
  });
  app.use(session({
    store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
    name: 'ih.sid', secret: config.SESSION_SECRET, resave: false, saveUninitialized: false,
    rolling: true, cookie: { maxAge: config.sessionTtlMs, httpOnly: true, secure: config.isProduction, sameSite: 'lax' }
  }));
  app.use(i18nMiddleware);
  app.use(csrfToken);
  app.use((req, res, next) => {
    res.locals.csrfToken = req.csrfToken;
    res.locals.currentPath = req.path;
    res.locals.authenticated = Boolean(req.session?.authenticated);
    next();
  });

  const auth = authHandlers(config);
  const loginLimitOptions = {
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false
  };
  const loginIpLimiter = rateLimit(loginLimitOptions);
  const loginUsernameLimiter = rateLimit({
    ...loginLimitOptions,
    keyGenerator: (req) => String(req.body?.username || '').trim().toLowerCase() || '<empty>'
  });
  app.get('/login', (req, res) => req.session.authenticated ? res.redirect('/candidates') : res.render('login', { error: null }));
  app.post('/auth/login', loginIpLimiter, loginUsernameLimiter, verifyCsrf, auth.login);
  app.post('/auth/logout', requireAuth, verifyCsrf, auth.logout);

  app.use(requireAuth);
  app.use(verifyCsrf);
  app.use(createPageRouter({ pool, config }));
  app.use(createActionRouter({ pool, config }));

  app.use((req, res) => res.status(404).render('error', { status: 404, message: 'Not found' }));
  app.use((error, req, res, _next) => {
    req.log?.error({ err: error }, 'request failed');
    const status = error.statusCode || (error.code === '23505' ? 409 : 500);
    if (req.get('HX-Request')) {
      const message = status >= 500 ? `Internal server error. Request ID: ${req.id}` : error.message;
      return res.status(status).send(message);
    }
    return res.status(status).render('error', { status, message: status >= 500 ? 'Internal server error' : error.message });
  });
  return app;
}
