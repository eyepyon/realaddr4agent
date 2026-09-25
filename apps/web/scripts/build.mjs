import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { PUBLIC_ORIGIN, PUBLIC_PAGES, canonicalUrl, llmsTxt, robotsTxt, sitemapXml } from "../src/public-content.ts";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(appRoot, "../..");
const dist = join(appRoot, "dist");
const prerenderDir = join(appRoot, ".tmp", "prerender");

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

function setPublicMetadata(html, page) {
  const config = PUBLIC_PAGES[page];
  let result = html.replace(/<title>[^<]*<\/title>/, `<title>${config.title}</title>`);
  result = result.replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${config.description}" />`);
  result = result.replace("<meta name=\"theme-color\" content=\"#f5f7fa\" />", `<meta name="theme-color" content="#f5f7fa" />\n    <meta name="robots" content="index,follow" />\n    <meta property="og:type" content="website" />\n    <meta property="og:title" content="${config.title}" />\n    <meta property="og:description" content="${config.description}" />\n    <meta property="og:url" content="${canonicalUrl(page)}" />\n    <link rel="canonical" href="${canonicalUrl(page)}" />`);
  const markup = renderPublicPage(page);
  result = result.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root" data-prerender="public">${markup}</div>`);
  return result;
}

function setPrivateShell(html, title, message) {
  let result = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  result = result.replace("<meta name=\"theme-color\" content=\"#f5f7fa\" />", `<meta name="theme-color" content="#f5f7fa" />\n    <meta name="robots" content="noindex,nofollow" />`);
  result = result.replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${message}" />`);
  return result;
}

for (const page of ["home", "developers", "faq"]) {
  const output = page === "home" ? join(dist, "index.html") : join(dist, page, "index.html");
  if (page !== "home") await mkdir(dirname(output), { recursive: true });
  await writeFile(output, setPublicMetadata(baseHtml, page), "utf8");
}

const privatePages = [
  ["app", "利用者画面 | RealAddr for Agents", "認証後にご自身の契約状態を表示します。"],
  ["admin", "運用者画面 | RealAddr for Agents", "運用者認証後に管理データを表示します。"],
  ["approve", "人間による確認 | RealAddr for Agents", "対象情報は確認前には表示されません。"],
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
await cp(join(projectRoot, "docs", "openapi.json"), join(dist, "openapi.json"));
await rm(join(appRoot, ".tmp"), { recursive: true, force: true });
console.log(`Built known route HTML under ${dist} for ${PUBLIC_ORIGIN}`);
