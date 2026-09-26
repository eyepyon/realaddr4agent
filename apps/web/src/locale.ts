export type Locale = "en" | "ja";
export const LOCALE_STORAGE_KEY = "realaddr.locale";

export function isLocale(value: unknown): value is Locale { return value === "en" || value === "ja"; }

export function resolveLocale(search: string, saved?: unknown): Locale {
  const query = new URLSearchParams(search);
  if (query.has("lang")) {
    const values = query.getAll("lang");
    return values.length === 1 && isLocale(values[0]) ? values[0] : "en";
  }
  return isLocale(saved) ? saved : "en";
}

export function localeHref(path: string, locale: Locale): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  const url = new URL(path, "https://locale.invalid");
  url.searchParams.set("lang", locale);
  return `${url.pathname}${url.search}${url.hash}`;
}
