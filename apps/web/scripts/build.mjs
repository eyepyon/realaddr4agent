import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { PUBLIC_ORIGIN, PUBLIC_PAGES, getPublicContent, canonicalUrl, llmsTxt, robotsTxt, sitemapXml } from "../src/public-content.ts";
import { CURRENT_TERMS_VERSION } from "../../../packages/domain/src/terms.ts";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(appRoot, "../..");
const dist = join(appRoot, "dist");
const prerenderDir = join(appRoot, ".tmp", "prerender");
const termsSource = await readFile(join(projectRoot, "docs/terms.md"), "utf8");
if (!termsSource.split("\n").includes(`規約version: ${CURRENT_TERMS_VERSION}`)) throw new Error("terms_document_version_mismatch");

await build({ configFile: join(appRoot, "vite.config.ts") });
await build({
  configFile: join(appRoot, "vite.config.ts"),
  build: {
    ssr: "src/prerender.tsx",
    outDir: ".tmp/prerender",
    emptyOutDir: true,
    rollupOptions: { output: { format: "es", entryFileNames: "prerender.mjs" } },
  },
});

const ssrFile = join(prerenderDir, "prerender.mjs");
const { renderPublicPage } = await import(`${pathToFileURL(ssrFile).href}?v=${Date.now()}`);
const baseHtml = await readFile(join(dist, "index.html"), "utf8");

function escapeHtml(value) { return value.replace(/[&<>"']/g, character => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[character]); }

function setPublicMetadata(html, page, locale) {
  const config = getPublicContent(locale).pages[page];
  html = html.replace(/<html lang="[^"]*">/, `<html lang="${locale}">`);
  let result = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(config.title)}</title>`);
  result = result.replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${escapeHtml(config.description)}" />`);
  result = result.replace("<meta name=\"theme-color\" content=\"#f5f7fa\" />", `<meta name="theme-color" content="#f5f7fa" />\n    <meta name="robots" content="index,follow" />\n    <meta property="og:type" content="website" />\n    <meta property="og:title" content="${escapeHtml(config.title)}" />\n    <meta property="og:description" content="${escapeHtml(config.description)}" />\n    <meta property="og:url" content="${escapeHtml(canonicalUrl(page, locale))}" />\n    <link rel="canonical" href="${escapeHtml(canonicalUrl(page, locale))}" />
    ${["en", "ja", "x-default"].map(lang => `<link rel="alternate" hreflang="${lang}" href="${escapeHtml(canonicalUrl(page, lang === "ja" ? "ja" : "en"))}" />`).join("\n    ")}`);
  const markup = renderPublicPage(page, locale);
  result = result.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root" data-prerender="public">${markup}</div>`);
  return result;
}

function setPrivateShell(html, title, message) {
  let result = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  result = result.replace("<meta name=\"theme-color\" content=\"#f5f7fa\" />", `<meta name="theme-color" content="#f5f7fa" />\n    <meta name="robots" content="noindex,nofollow" />`);
  result = result.replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${message}" />`);
  return result;
}

for (const locale of ["en", "ja"]) {
 for (const page of ["home", "developers", "faq", "terms"]) {
  const root = locale === "ja" ? join(dist, "ja") : dist;
  const output = page === "home" ? join(root, "index.html") : join(root, page, "index.html");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, setPublicMetadata(baseHtml, page, locale), "utf8");
 }
}

const privatePages = [
  ["app", "Account | RealAddr for Agents", "Authenticate to view your leases."],
  ["admin", "Operator | RealAddr for Agents", "Operator authentication is required."],
  ["approve", "Human approval | RealAddr for Agents", "Authenticate to review this request."],
];
for (const [directory, title, message] of privatePages) {
  const output = join(dist, directory, "index.html");
  await mkdir(dirname(output), { recursive: true });
  const shell = setPrivateShell(baseHtml, title, message).replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root"><main class="loading-shell"><p>${message}</p></main></div>`);
  await writeFile(output, shell, "utf8");
}

await writeFile(join(dist, "robots.txt"), robotsTxt(), "utf8");
await writeFile(join(dist, "sitemap.xml"), sitemapXml(), "utf8");
await writeFile(join(dist, "llms.txt"), `${llmsTxt()}\n`, "utf8");
await writeFile(join(dist, "ja", "llms.txt"), `${llmsTxt("ja")}\n`, "utf8");
await cp(join(projectRoot, "docs", "openapi.json"), join(dist, "openapi.json"));
await rm(join(appRoot, ".tmp"), { recursive: true, force: true });
console.log(`Built known route HTML under ${dist} for ${PUBLIC_ORIGIN}`);
