import React, { useEffect } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { PublicPage } from "./PublicPages";
import { canonicalUrl, getPublicContent, getPublicPage } from "./public-content";
import { LanguageSwitcher, LocaleProvider, useLocale } from "./i18n";
import { resolveLocale } from "./locale";
import { AdminApp } from "./admin/AdminApp";
import { AppArea } from "./app/AppArea";
import { ApprovalShell } from "./approve/ApprovalShell";
import "./styles.css";

function RouteApp() {
  const { t, href } = useLocale();
  const path = window.location.pathname;
  const page = getPublicPage(path);
  if (page) return <PublicPage page={page} />;
  if (path === "/admin" || path === "/admin/") return <AdminApp />;
  if (path === "/app" || path.startsWith("/app/")) return <AppArea />;
  if (/^\/approve\/[^/]+\/?$/.test(path)) return <ApprovalShell />;
  return <main className="not-found"><h1>{t("ページが見つかりません", "Page not found")}</h1><p>{t("指定されたページは存在しないか、現在利用できません。", "This page does not exist or is currently unavailable.")}</p><a href={href("/")}>{t("トップへ戻る", "Back to home")}</a></main>;
}

function LocaleMetadata() {
  const { locale, t } = useLocale();
  useEffect(() => {
    const page = getPublicPage(window.location.pathname);
    if (page) {
      const content = getPublicContent(locale).pages[page];
      document.title = content.title;
      document.querySelector('meta[name="description"]')?.setAttribute("content", content.description);
      document.querySelector('meta[property="og:title"]')?.setAttribute("content", content.title);
      document.querySelector('meta[property="og:description"]')?.setAttribute("content", content.description);
      document.querySelector('meta[property="og:url"]')?.setAttribute("content", canonicalUrl(page, locale));
      document.querySelector('link[rel="canonical"]')?.setAttribute("href", canonicalUrl(page, locale));
    } else {
      const name = window.location.pathname.startsWith("/admin") ? t("運営管理", "Operator console") : window.location.pathname.startsWith("/approve") ? t("人間による承認", "Human approval") : t("利用者画面", "Your account");
      document.title = `${name} | RealAddr for Agents`;
    }
  }, [locale, t]);
  return null;
}

const root = document.getElementById("root");
if (root) {
  const initialLocale = root.dataset.prerender === "public" ? (document.documentElement.lang === "ja" ? "ja" : "en") : resolveLocale(window.location.search);
  const app = <React.StrictMode><LocaleProvider initialLocale={initialLocale}><LanguageSwitcher path={window.location.pathname} /><RouteApp /><LocaleMetadata /></LocaleProvider></React.StrictMode>;
  if (root.dataset.prerender === "public") hydrateRoot(root, app);
  else createRoot(root).render(app);
}
