import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalUrl, getPublicContent, llmsTxt, sitemapXml } from "../src/public-content";

for (const locale of ["en", "ja"] as const) {
  for (const page of ["home", "developers", "faq", "terms"] as const) {
    test(`prerender ${page} ${locale} has matching metadata and language`, async () => {
      const prefix = locale === "ja" ? "ja/" : "";
      const html = await readFile(new URL(`../dist/${prefix}${page === "home" ? "" : `${page}/`}index.html`, import.meta.url), "utf8");
      assert.ok(html.includes(`<html lang="${locale}">`));
      assert.ok(html.includes(`<title>${getPublicContent(locale).pages[page].title}</title>`));
      assert.ok(html.includes(`<link rel="canonical" href="${canonicalUrl(page, locale)}"`));
      for (const language of ["en", "ja", "x-default"]) assert.ok(html.includes(`hreflang="${language}"`));
      assert.ok(html.includes('data-prerender="public"'));
      if (page === "home") assert.ok(html.includes(getPublicContent(locale).copy.headline));
      if (page === "terms") {
        assert.ok(html.includes('lang="ja"'));
        assert.ok(html.includes("realaddr-v1"));
        if (locale === "en") assert.ok(html.includes("The adopted terms below are in Japanese."));
      }
    });
  }
}
test("discovery exposes both public languages without private routes", () => {
  const sitemap = sitemapXml();
  assert.equal((sitemap.match(/<loc>/g) ?? []).length, 8);
  assert.ok(sitemap.includes("?lang=ja"));
  assert.ok(!sitemap.includes("/admin"));
  assert.ok(llmsTxt().includes("currently paused"));
  assert.ok(llmsTxt("ja").includes("現在受付を停止"));
});
