import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const views = path.resolve(testDir, '../src/views');

test('candidate page explains discovery and hides the discovery run table', async () => {
  const html = await ejs.renderFile(path.join(views, 'accounts.ejs'), {
    title: 'Candidates', locale: 'ru', csrfToken: 'csrf-token', active: 'candidates',
    t: (key) => key, mode: 'candidates', accounts: [], query: {},
    config: { DISCOVERY_MAX_LIMIT: 50, DISCOVERY_DEFAULT_LIMIT: 5 }
  });

  assert.match(html, /Поиск новых блогеров/);
  assert.match(html, /Что искать в Instagram/);
  assert.match(html, /Предложить запрос через ИИ/);
  assert.match(html, /\/discovery-query-suggestions/);
  assert.doesNotMatch(html, /Discovery runs|fashion moscow|\/ui\/discovery-runs/);
});

test('LLM query suggestion polls safely and exposes generated choices', async () => {
  const template = path.join(views, 'partials/discovery-query-suggestion.ejs');
  const pending = await ejs.renderFile(template, {
    job: { id: 42, status: 'pending' }, queries: [], csrfToken: 'csrf-token'
  });
  assert.match(pending, /\/ui\/discovery-query-suggestions\/42/);
  assert.match(pending, /every 2s/);

  const completed = await ejs.renderFile(template, {
    job: { id: 42, status: 'succeeded' },
    queries: ['fashion & style "moscow"', 'wildberries looks'],
    csrfToken: 'csrf-token'
  });
  assert.match(completed, /data-discovery-query-default="fashion &amp; style &#34;moscow&#34;"/);
  assert.match(completed, /data-discovery-query="wildberries looks"/);
  assert.doesNotMatch(completed, /hx-trigger="every 2s"/);
});
