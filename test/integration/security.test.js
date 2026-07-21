import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { hashSync } from 'bcryptjs';
import pino from 'pino';
import pg from 'pg';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { initializeSchema } from '../../src/db/schema.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const password = 'integration-password';

integration('authentication and request security', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const logger = pino({ level: 'silent' });

  function config(nodeEnv = 'test') {
    return loadConfig({
      NODE_ENV: nodeEnv,
      DATABASE_URL: databaseUrl,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD_HASH: hashSync(password, 4),
      SESSION_SECRET: 'integration-session-secret-at-least-32-characters',
      APP_DOMAIN: 'localhost'
    });
  }

  function cookieFrom(response) {
    return response.headers['set-cookie']?.[0]?.split(';')[0];
  }

  function csrfFrom(response) {
    const match = response.text.match(/name="_csrf"\s+value="([^"]+)"/);
    assert.ok(match, 'login form must contain a CSRF token');
    return match[1];
  }

  before(async () => {
    await initializeSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate table user_sessions');
  });

  after(async () => {
    await pool.end();
  });

  test('login requires CSRF and rotates the session id', async () => {
    const app = createApp({ config: config(), pool, logger });
    const initial = await request(app).get('/login').expect(200);
    const initialCookie = cookieFrom(initial);
    const csrf = csrfFrom(initial);
    assert.ok(initialCookie);

    await request(app)
      .post('/auth/login')
      .set('Cookie', initialCookie)
      .type('form')
      .send({ username: 'admin', password })
      .expect(403);

    const loggedIn = await request(app)
      .post('/auth/login')
      .set('Cookie', initialCookie)
      .type('form')
      .send({ _csrf: csrf, username: 'admin', password })
      .expect(302)
      .expect('Location', '/candidates');
    const authenticatedCookie = cookieFrom(loggedIn);
    assert.ok(authenticatedCookie);
    assert.notEqual(authenticatedCookie, initialCookie);

    await request(app)
      .get('/candidates')
      .set('Cookie', authenticatedCookie)
      .expect(200);
    await request(app)
      .get('/candidates')
      .set('Cookie', initialCookie)
      .expect(302)
      .expect('Location', '/login');
  });

  test('production session cookie is Secure, HttpOnly and SameSite=Lax', async () => {
    const app = createApp({ config: config('production'), pool, logger });
    const response = await request(app)
      .get('/login')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
    const setCookie = response.headers['set-cookie']?.[0] || '';
    assert.match(setCookie, /; Secure/i);
    assert.match(setCookie, /; HttpOnly/i);
    assert.match(setCookie, /; SameSite=Lax/i);
  });

  test('health endpoints do not create sessions and readiness hides database errors', async () => {
    let queries = 0;
    const failingPool = {
      query: async () => {
        queries += 1;
        throw new Error('postgresql://internal-user:secret@database/private');
      }
    };
    const app = createApp({ config: config(), pool: failingPool, logger });
    const live = await request(app).get('/health/live').expect(200);
    assert.equal(live.headers['set-cookie'], undefined);
    assert.equal(queries, 0);

    const ready = await request(app).get('/health/ready').expect(503);
    assert.deepEqual(ready.body, { status: 'unready' });
    assert.equal(ready.headers['set-cookie'], undefined);
    assert.equal(queries, 1);
    assert.doesNotMatch(ready.text, /internal-user|secret|database\/private/);
  });

  test('login is throttled by IP address', async () => {
    const app = createApp({ config: config(), pool, logger });
    const initial = await request(app).get('/login').expect(200);
    const cookie = cookieFrom(initial);
    const csrf = csrfFrom(initial);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app)
        .post('/auth/login')
        .set('Cookie', cookie)
        .type('form')
        .send({ _csrf: csrf, username: 'admin', password: 'wrong' })
        .expect(401);
    }
    await request(app)
      .post('/auth/login')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrf, username: 'admin', password: 'wrong' })
      .expect(429);
  });

  test('login is throttled by normalized username across IP addresses', async () => {
    const app = createApp({ config: config('production'), pool, logger });
    const initial = await request(app)
      .get('/login')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
    const cookie = cookieFrom(initial);
    const csrf = csrfFrom(initial);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app)
        .post('/auth/login')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-For', `198.51.100.${attempt + 1}`)
        .set('Cookie', cookie)
        .type('form')
        .send({ _csrf: csrf, username: attempt % 2 ? 'ADMIN' : 'admin', password: 'wrong' })
        .expect(401);
    }
    await request(app)
      .post('/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-For', '198.51.100.200')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrf, username: ' Admin ', password: 'wrong' })
      .expect(429);
  });
});
