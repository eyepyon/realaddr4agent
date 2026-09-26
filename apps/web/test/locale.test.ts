import assert from 'node:assert/strict';
import test from 'node:test';
import { localeHref, resolveLocale } from '../src/locale.js';

test('locale selection defaults to English and explicit query overrides saved choice', () => {
  assert.equal(resolveLocale(''), 'en');
  assert.equal(resolveLocale('', 'ja'), 'ja');
  assert.equal(resolveLocale('?lang=en', 'ja'), 'en');
  assert.equal(resolveLocale('?lang=ja', 'en'), 'ja');
  for (const query of ['?lang=fr', '?lang=', '?lang=ja&lang=en', '?lang=ja&lang=ja']) {
    assert.equal(resolveLocale(query, 'ja'), 'en');
  }
  assert.equal(localeHref('/admin?section=locations#form', 'ja'), '/admin?section=locations&lang=ja#form');
  assert.equal(localeHref('https://identity.example/authorize', 'ja'), 'https://identity.example/authorize');
  assert.equal(localeHref('//identity.example/authorize', 'ja'), '//identity.example/authorize');
});
