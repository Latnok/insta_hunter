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
    t: (key) => key, mode: 'candidates', accounts: [], query: {}, aiSearchQueries: [],
    config: { DISCOVERY_MAX_LIMIT: 50, DISCOVERY_DEFAULT_LIMIT: 5 }
  });

  assert.match(html, /Поиск новых блогеров/);
  assert.match(html, /Поисковый запрос/);
  assert.match(html, /Предложить запрос через ИИ/);
  assert.match(html, /\/discovery-query-suggestions/);
  assert.doesNotMatch(html, /Discovery runs|fashion moscow|\/ui\/discovery-runs/);
});

test('approved blogger drawer presents personalized outreach for human approval', async () => {
  const html = await ejs.renderFile(path.join(views, 'partials/account-drawer.ejs'), {
    locale: 'ru', csrfToken: 'csrf-token', t: (key) => key,
    config: { REELS_MAX_LIMIT: 20, REELS_DEFAULT_LIMIT: 5 },
    account: {
      id: 7, username: 'warm_creator', lifecycle_status: 'approved', instagram_url: 'https://instagram.com/warm_creator',
      avatar_url: null, display_name: 'Creator', bio: 'Style', followers: 1000, reels_count: 1,
      useful_reels_count: 1, recommendation: 'recommended_approve', confidence: 90, explanation: 'Fits'
    },
    reels: [], audit: [], jobs: [{ id: 12, job_type: 'draft_outreach', status: 'succeeded', created_at: new Date() }],
    outreach: [{
      id: 3, job_id: 12, status: 'draft', message_text: 'Тёплое персональное предложение',
      personalization_reason: 'Подходит стиль и формат контента.'
    }]
  });
  assert.match(html, /Почему пишем именно этому блогеру/);
  assert.match(html, /Тёплое персональное предложение/);
  assert.match(html, /Утвердить этот текст/);
  assert.match(html, /\/outreach\/3\/approve/);
});

test('approved blogger drawer polls while outreach generation is active', async () => {
  const html = await ejs.renderFile(path.join(views, 'partials/account-drawer.ejs'), {
    locale: 'ru', csrfToken: 'csrf-token', t: (key) => key,
    config: { REELS_MAX_LIMIT: 20, REELS_DEFAULT_LIMIT: 5 },
    account: {
      id: 8, username: 'pending_creator', lifecycle_status: 'approved', instagram_url: 'https://instagram.com/pending_creator',
      avatar_url: null, display_name: null, bio: null, followers: null, reels_count: 0,
      useful_reels_count: 0, recommendation: 'recommended_approve', confidence: 80, explanation: 'Fits'
    },
    reels: [], audit: [], outreach: [],
    jobs: [{ id: 13, job_type: 'draft_outreach', status: 'running', created_at: new Date() }]
  });
  assert.match(html, /hx-get="\/ui\/accounts\/8"/);
  assert.match(html, /hx-trigger="every 2s"/);
  assert.match(html, /обновится автоматически/);
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
  assert.match(completed, /Запрос готов/);
  assert.doesNotMatch(completed, /hx-trigger="every 2s"/);
});

test('settings exposes both active LLM prompts as editable draft fields', async () => {
  const now = new Date();
  const html = await ejs.renderFile(path.join(views, 'settings.ejs'), {
    title: 'Settings', locale: 'ru', csrfToken: 'csrf-token', active: 'settings',
    t: (key) => key,
    criteria: [{
      id: 1, version_number: 7, status: 'active', source: 'manual', created_at: now,
      checklist_markdown: 'criteria', transcript_rules: {
        llmPrompts: { candidateEvaluation: 'ANALYSIS PROMPT', outreachProposal: 'OUTREACH PROMPT' }
      }
    }],
    llmLogs: [],
    llmPrompts: { candidateEvaluation: 'ANALYSIS PROMPT', outreachProposal: 'OUTREACH PROMPT' },
    criteriaAutomation: {
      criteriaEnabled: true, decisionThreshold: 10, refreshHours: 24,
      discoveryEnabled: true, dailyDiscoveryLimit: 20, perQueryLimit: 5
    },
    automationStatus: { discovery_used_today: 5, pending_criteria_jobs: 1, last_discovery_at: now }
  });
  assert.match(html, /Промпты LLM/);
  assert.match(html, /name="candidateEvaluation"/);
  assert.match(html, /ANALYSIS PROMPT/);
  assert.match(html, /name="outreachProposal"/);
  assert.match(html, /OUTREACH PROMPT/);
  assert.match(html, /Сохранить как draft/);
  assert.match(html, /нажмите Activate/);
  assert.match(html, /активной версии v7/);
  assert.match(html, /Промпты этой версии/);
  assert.match(html, /Автоматизация поиска/);
  assert.match(html, /name="decisionThreshold"/);
  assert.match(html, /name="dailyDiscoveryLimit"/);
  assert.match(html, /Сохранить настройки как draft/);
  assert.match(html, /5 из 20/);
});
