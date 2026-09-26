import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LOCALE_STORAGE_KEY, localeHref, resolveLocale, type Locale } from "./locale";
export { localeHref, type Locale } from "./locale";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (ja: string, en: string) => string;
  href: (path: string) => string;
};
const LocaleContext = createContext<LocaleContextValue>({ locale: "en", setLocale: () => {}, t: (_ja, en) => en, href: path => localeHref(path, "en") });

function savedLocale(): string | null {
  try { return window.localStorage.getItem(LOCALE_STORAGE_KEY); } catch { return null; }
}

export function LocaleProvider({ initialLocale = "en", restorePreference = true, children }: { initialLocale?: Locale; restorePreference?: boolean; children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(initialLocale);
  useEffect(() => {
    if (!restorePreference) return;
    const restore = () => updateLocale(resolveLocale(window.location.search, savedLocale()));
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [restorePreference]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const setLocale = useCallback((next: Locale) => {
    updateLocale(next);
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* The current page can still switch when storage is unavailable. */ }
    try {
      const nextUrl = localeHref(`${window.location.pathname}${window.location.search}${window.location.hash}`, next);
      window.history.replaceState(window.history.state, "", nextUrl);
    } catch { /* Keep the selected language even if history is unavailable. */ }
  }, []);
  const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale, t: (ja, en) => locale === "ja" ? ja : en, href: path => localeHref(path, locale) }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue { return useContext(LocaleContext); }

export function LanguageSwitcher({ path = "/" }: { path?: string }) {
  const { locale, setLocale } = useLocale();
  const normalizedPath = path === "/" ? path : path.replace(/\/$/, "");
  return <div className="language-bar"><nav aria-label="Language / 言語" className="language-switcher">
    {(["en", "ja"] as const).map(language => <a key={language} href={localeHref(normalizedPath, language)} lang={language} hrefLang={language} aria-current={locale === language ? "true" : undefined} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); setLocale(language);
    }}>{language === "en" ? "English" : "日本語"}</a>)}
  </nav></div>;
}
