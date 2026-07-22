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

  test('stored images are proxied through authenticated same-origin routes', async () => {
    const loaded = [];
    const imageLoader = async (url) => {
      loaded.push(url);
      return { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' };
    };
    const account = (await pool.query(`
      insert into instagram_accounts(username,instagram_url,source_type)
      values ('security_media_proxy','https://www.instagram.com/security_media_proxy/','manual')
      returning id
    `)).rows[0];
    await pool.query(`
      insert into account_profiles(account_id,username,avatar_url,profile_status,provider,fetched_at)
      values ($1,'security_media_proxy','https://cdn.example.invalid/avatar.jpg','available','fixture',now())
    `, [account.id]);
    const reel = (await pool.query(`
      insert into reels(account_id,instagram_media_id,reel_url,thumbnail_url,fetched_at)
      values ($1,'security-media-proxy','https://www.instagram.com/reel/security-media-proxy/',
        'https://cdn.example.invalid/thumbnail.jpg',now()) returning id
    `, [account.id])).rows[0];

    try {
      const app = createApp({ config: config(), pool, logger, imageLoader });
      await request(app).get(`/media/accounts/${account.id}/avatar`)
        .expect(302).expect('Location', '/login');

      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      await agent.post('/auth/login').type('form').send({
        _csrf: csrfFrom(loginPage), username: 'admin', password
      }).expect(302);

      await agent.get(`/media/accounts/${account.id}/avatar`)
        .expect(200).expect('Content-Type', 'image/png')
        .expect('Cache-Control', 'private, max-age=600');
      await agent.get(`/media/reels/${reel.id}/thumbnail`)
        .expect(200).expect('Content-Type', 'image/png');
      await agent.get('/media/accounts/not-a-number/avatar').expect(400);
      await agent.get('/media/reels/999999999/thumbnail').expect(404);
      assert.deepEqual(loaded, [
        'https://cdn.example.invalid/avatar.jpg',
        'https://cdn.example.invalid/thumbnail.jpg'
      ]);
    } finally {
      await pool.query('delete from instagram_accounts where id=$1', [account.id]);
    }
  });

  test('list pages reject malformed pagination and unsupported filters with 400', async () => {
    const app = createApp({ config: config(), pool, logger });
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    await agent.post('/auth/login').type('form').send({
      _csrf: csrfFrom(loginPage), username: 'admin', password
    }).expect(302);

    const invalidUrls = [
      '/candidates?offset=-1',
      '/bloggers?offset=NaN',
      '/reels?offset=10001',
      '/candidates?status=approved',
      '/bloggers?status=rejected',
      '/reels?quality=excellent',
      '/queue?status=unknown',
      '/queue?jobType=drop_table',
      '/queue?offset=0&offset=1'
    ];
    for (const url of invalidUrls) await agent.get(url).expect(400);

    await agent.get('/candidates?status=candidate&offset=10000').expect(200);
    await agent.get('/reels?quality=useful').expect(200);
    await agent.get('/queue?status=failed&jobType=fetch_profile').expect(200);
  });

  test('AI discovery query request requires CSRF and enqueues a criteria proposal job', async () => {
    const insertedCriteria = await pool.query(`
      insert into criteria_versions(version_number,checklist_markdown,search_queries,transcript_rules,status,source)
      select coalesce(max(version_number),0)+1,'integration criteria','["fashion"]','{}','active','manual'
      from criteria_versions
      where not exists(select 1 from criteria_versions where status='active')
      returning id
    `);
    const app = createApp({ config: config(), pool, logger });
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    await agent.post('/auth/login').type('form').send({
      _csrf: csrfFrom(loginPage), username: 'admin', password
    }).expect(302);
    const candidates = await agent.get('/candidates').expect(200);
    const csrf = csrfFrom(candidates);

    await agent.post('/discovery-query-suggestions')
      .set('HX-Request', 'true')
      .expect(403);
    const response = await agent.post('/discovery-query-suggestions')
      .set('HX-Request', 'true')
      .set('X-CSRF-Token', csrf)
      .expect(200);
    const jobId = response.text.match(/\/ui\/discovery-query-suggestions\/(\d+)/)?.[1];
    assert.ok(jobId);
    const job = await pool.query('select job_type,status from jobs where id=$1', [jobId]);
    assert.deepEqual(job.rows[0], { job_type: 'propose_criteria', status: 'pending' });

    await pool.query('delete from jobs where id=$1', [jobId]);
    if (insertedCriteria.rowCount) await pool.query('delete from criteria_versions where id=$1', [insertedCriteria.rows[0].id]);
  });

  test('LLM prompt edits require CSRF and create an inactive criteria draft', async () => {
    const insertedCriteria = await pool.query(`
      insert into criteria_versions(version_number,checklist_markdown,search_queries,transcript_rules,status,source)
      select coalesce(max(version_number),0)+1,'prompt integration criteria','["fashion"]','{}','active','manual'
      from criteria_versions
      where not exists(select 1 from criteria_versions where status='active')
      returning id
    `);
    const active = (await pool.query(`select * from criteria_versions where status='active' limit 1`)).rows[0];
    const app = createApp({ config: config(), pool, logger });
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    await agent.post('/auth/login').type('form').send({
      _csrf: csrfFrom(loginPage), username: 'admin', password
    }).expect(302);
    const settings = await agent.get('/settings').expect(200);
    const csrf = csrfFrom(settings);

    await agent.post('/prompts/drafts').type('form').send({
      candidateEvaluation: 'custom analysis', outreachProposal: 'custom outreach'
    }).expect(403);

    await agent.post('/prompts/drafts').type('form').send({
      _csrf: csrf,
      candidateEvaluation: '  custom analysis  ',
      outreachProposal: 'custom outreach'
    }).expect(303).expect('Location', '/settings');

    const draft = (await pool.query(`
      select * from criteria_versions
      where parent_version_id=$1 and diff_summary='LLM prompts updated'
      order by version_number desc limit 1
    `, [active.id])).rows[0];
    assert.ok(draft);
    assert.equal(draft.status, 'draft');
    assert.deepEqual(draft.transcript_rules.llmPrompts, {
      candidateEvaluation: 'custom analysis', outreachProposal: 'custom outreach'
    });
    assert.equal((await pool.query(`select status from criteria_versions where id=$1`, [active.id])).rows[0].status, 'active');

    await agent.post('/prompts/drafts').type('form').send({
      _csrf: csrf, candidateEvaluation: ' ', outreachProposal: 'custom outreach'
    }).expect(400);

    await pool.query('delete from criteria_versions where id=$1', [draft.id]);
    if (insertedCriteria.rowCount) await pool.query('delete from criteria_versions where id=$1', [insertedCriteria.rows[0].id]);
  });

  test('automation settings are validated and saved as an inactive criteria draft', async () => {
    const insertedCriteria = await pool.query(`
      insert into criteria_versions(version_number,checklist_markdown,search_queries,transcript_rules,status,source)
      select coalesce(max(version_number),0)+1,'automation criteria','["fashion"]','{}','active','manual'
      from criteria_versions where not exists(select 1 from criteria_versions where status='active')
      returning id
    `);
    const active = (await pool.query(`select * from criteria_versions where status='active' limit 1`)).rows[0];
    const app = createApp({ config: config(), pool, logger });
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    await agent.post('/auth/login').type('form').send({
      _csrf: csrfFrom(loginPage), username: 'admin', password
    }).expect(302);
    const settingsPage = await agent.get('/settings').expect(200);
    const csrf = csrfFrom(settingsPage);

    await agent.post('/automation/drafts').type('form').send({
      _csrf: csrf, criteriaEnabled: 'on', decisionThreshold: 5, refreshHours: 12,
      discoveryEnabled: 'on', dailyDiscoveryLimit: 30, perQueryLimit: 6
    }).expect(303).expect('Location', '/settings');
    const draft = (await pool.query(`
      select * from criteria_versions
      where parent_version_id=$1 and diff_summary='Criteria automation settings updated'
      order by version_number desc limit 1
    `, [active.id])).rows[0];
    assert.deepEqual(draft.transcript_rules.criteriaAutomation, {
      criteriaEnabled: true, decisionThreshold: 5, refreshHours: 12,
      discoveryEnabled: true, dailyDiscoveryLimit: 30, perQueryLimit: 6
    });
    assert.equal(draft.status, 'draft');

    await agent.post('/automation/drafts').type('form').send({
      _csrf: csrf, decisionThreshold: 0, refreshHours: 12,
      dailyDiscoveryLimit: 30, perQueryLimit: 6
    }).expect(400);

    await pool.query('delete from criteria_versions where id=$1', [draft.id]);
    if (insertedCriteria.rowCount) await pool.query('delete from criteria_versions where id=$1', [insertedCriteria.rows[0].id]);
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

  test('CSV upload returns safe 4xx errors and keeps parallel previews one-time', async () => {
    const app = createApp({ config: config(), pool, logger });
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    const loginCsrf = csrfFrom(loginPage);
    await agent.post('/auth/login').type('form').send({
      _csrf: loginCsrf,
      username: 'admin',
      password
    }).expect(302);
    const candidates = await agent.get('/candidates').expect(200);
    const csrf = csrfFrom(candidates);

    await agent.post('/imports/csv/preview')
      .set('X-CSRF-Token', csrf)
      .set('HX-Request', 'true')
      .attach('file', Buffer.from('source_note\nmissing identity\n'), 'bad.csv')
      .expect(400)
      .expect(/requires a username or url header/);

    await agent.post('/imports/csv/preview')
      .set('X-CSRF-Token', csrf)
      .set('HX-Request', 'true')
      .attach('other', Buffer.from('username\nwrong_field\n'), 'bad.csv')
      .expect(400)
      .expect(/LIMIT_UNEXPECTED_FILE/);

    await agent.post('/imports/csv/preview')
      .set('X-CSRF-Token', csrf)
      .set('HX-Request', 'true')
      .attach('file', Buffer.alloc(config().uploadMaxBytes + 1, 0x61), 'large.csv')
      .expect(413)
      .expect(/CSV file is too large/);

    const first = await agent.post('/imports/csv/preview')
      .set('X-CSRF-Token', csrf)
      .attach('file', Buffer.from('username\nparallel_csv_one\n'), 'one.csv')
      .expect(200);
    const second = await agent.post('/imports/csv/preview')
      .set('X-CSRF-Token', csrf)
      .attach('file', Buffer.from('username\nparallel_csv_two\n'), 'two.csv')
      .expect(200);
    const token = (response) => response.text.match(/name="previewId" value="([^"]+)"/)[1];
    const firstId = token(first);
    const secondId = token(second);
    assert.notEqual(firstId, secondId);

    await agent.post('/imports/csv/commit').type('form').send({
      _csrf: csrf, previewId: firstId, previewVersion: 1
    }).expect(303);
    await agent.post('/imports/csv/commit').type('form').send({
      _csrf: csrf, previewId: secondId, previewVersion: 1
    }).expect(303);
    await agent.post('/imports/csv/commit').type('form').send({
      _csrf: csrf, previewId: firstId, previewVersion: 1
    }).expect(409);

    const imported = await pool.query(`
      select username from instagram_accounts
      where username in ('parallel_csv_one','parallel_csv_two') order by username
    `);
    assert.deepEqual(imported.rows.map((row) => row.username), ['parallel_csv_one', 'parallel_csv_two']);
  });
});
