import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server.js';

test('public HTML serves both languages and keeps private routes out of caches', async () => {
  const app = createApp({ appEnv: 'event', origin: 'https://service.example', port: 8080,
    projectId: 'fixture', databaseId: 'realaddr', collectionPrefix: 'realaddr_event_',
    termsVersion: 'realaddr-v1', rateLimitKey: Buffer.alloc(32, 1), pricing: null }, null, null);
  try {
    for (const path of ['/', '/developers', '/faq', '/terms']) {
      for (const locale of ['en', 'ja']) {
        const response = await app.inject(`${path}?lang=${locale}`);
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-language'], locale);
        assert.match(response.body, new RegExp(`<html lang="${locale}"`));
        assert.match(response.body, /hreflang="en"/);
        assert.match(response.body, /hreflang="ja"/);
        assert.match(response.body, /<h1/);
        const switchPath = path === '/' ? '/' : path;
        assert.ok(response.body.includes(`href="${switchPath}?lang=ja"`));
      }
    }
    for (const suffix of ['', '?lang=invalid', '?lang=ja&lang=en']) {
      const response = await app.inject(`/${suffix}`);
      assert.equal(response.headers['content-language'], 'en');
      assert.match(response.body, /<html lang="en"/);
    }
    const terms = await app.inject('/terms?lang=en');
    assert.match(terms.body, /lang="ja"/);
    assert.match(terms.body, /realaddr-v1/);
    const guide = await app.inject('/llms.txt?lang=ja');
    assert.equal(guide.headers['content-language'], 'ja');
    for (const path of ['/app?lang=ja', '/admin?lang=en']) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
    }
  } finally { await app.close(); }
});
