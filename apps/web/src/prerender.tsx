import { renderToString } from "react-dom/server";
import { PublicPage } from "./PublicPages";
import { getPublicContent, type PublicPageKey } from "./public-content";
import { LanguageSwitcher, LocaleProvider, type Locale } from "./i18n";

export function renderPublicPage(page: PublicPageKey, locale: Locale = "en"): string {
  return renderToString(<LocaleProvider initialLocale={locale} restorePreference={false}><LanguageSwitcher path={getPublicContent(locale).pages[page].path} /><PublicPage page={page} /></LocaleProvider>);
}
