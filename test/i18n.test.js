import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLocale } from '../src/i18n/index.js';

test('selects session, cookie, browser and fallback locale in order', () => {
  assert.equal(selectLocale({ sessionLocale: 'ru', cookieLocale: 'en', browserLocale: 'en' }), 'ru');
  assert.equal(selectLocale({ cookieLocale: 'ru', browserLocale: 'en' }), 'ru');
  assert.equal(selectLocale({ browserLocale: 'ru' }), 'ru');
  assert.equal(selectLocale({ browserLocale: 'fr' }), 'en');
});
