import { compare } from 'bcryptjs';
import crypto from 'node:crypto';

export function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.get('HX-Request')) return res.status(401).set('HX-Redirect', '/login').end();
  return res.redirect('/login');
}

export function authHandlers(config) {
  return {
    login: async (req, res, next) => {
      try {
        const validUsername = String(req.body.username || '') === config.ADMIN_USERNAME;
        const validPassword = await compare(String(req.body.password || ''), config.ADMIN_PASSWORD_HASH);
        if (!validUsername || !validPassword) return res.status(401).render('login', { error: req.t('auth.invalid') });
        await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
        req.session.authenticated = true;
        req.session.actor = 'admin';
        req.session.locale = req.body.locale || req.locale;
        req.session.csrfToken = crypto.randomUUID();
        return res.redirect('/candidates');
      } catch (error) { return next(error); }
    },
    logout: (req, res, next) => req.session.destroy((error) => error ? next(error) : res.redirect('/login'))
  };
}
