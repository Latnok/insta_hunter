import crypto from 'node:crypto';

export function csrfToken(req, _res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomUUID();
  req.csrfToken = req.session.csrfToken;
  next();
}

export function verifyCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const supplied = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session?.csrfToken;
  if (!supplied || !expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).send('Invalid CSRF token');
  }
  next();
}
