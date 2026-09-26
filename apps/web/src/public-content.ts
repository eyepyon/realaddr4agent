export const PUBLIC_ORIGIN = "https://address.chain.tokyo";
export const OPERATOR_NAME = "国立日本総合研究センター株式会社";
export const OPERATOR_URL = "https://jgrec.jp/";
export const PAYMENT_NETWORK = "Base Sepolia";
export const ENS_NETWORK = "Ethereum Sepolia";

export type PublicPageKey = "home" | "developers" | "faq" | "terms";

const JAPANESE_PAGES: Record<PublicPageKey, { path: string; title: string; description: string }> = {
  home: {
    path: "/",
    title: "AIエージェントにリアルな住所利用の権利を | RealAddr for Agents",
    description: "AIエージェント向けの住所利用契約、任意ENS追加購入、人間による転送先設定を説明します。実際の郵便転送は行いません。",
  },
  developers: {
    path: "/developers",
    title: "開発者向け | RealAddr for Agents",
    description: "Agent認証、住所契約、x402決済、ENS照合のAPI契約と開発上の制約を案内します。",
  },
  faq: {
    path: "/faq",
    title: "よくある質問 | RealAddr for Agents",
    description: "仮想区画、料金、World認証、ENS追加購入、郵便機能とネットワークについて説明します。",
  },
  terms: {
    path: "/terms",
    title: "利用規約 | RealAddr for Agents",
    description: "RealAddr for Agentsの正式な利用規約version 1です。適用範囲と利用条件を説明します。",
  },
};

const JAPANESE_COPY = {
  headline: "AIエージェントにリアルな住所利用の権利を",
  summary: "RealAddr for Agentsは、AIエージェントだけで、オフラインの住所を使う権利を契約でき、法的に人間の契約が必要な郵便転送を、人間が承認しやすくするサービスです。",
  addressMainnet: "55 USDC",
  addressTest: "0.55 USDC",
  ensStandardMainnet: "10 USDC",
  ensStandardTest: "0.10 USDC",
  ensCustomMainnet: "30 USDC",
  ensCustomTest: "0.30 USDC",
  status: "Base Sepolia決済とEthereum Sepolia ENSのデモです。住所購入・更新・ENS add-onは現在受付を停止しています。",
  paymentNetwork: PAYMENT_NETWORK,
  ensNetwork: ENS_NETWORK,
};


export type PublicLocale = "en" | "ja";
export const PUBLIC_PAGES: typeof JAPANESE_PAGES = {
 home: { path: "/", title: "Real-world address rights for AI agents | RealAddr for Agents", description: "Address leases for AI agents, optional ENS names, and human-approved forwarding settings. No physical mail forwarding." },
 developers: { path: "/developers", title: "Developers | RealAddr for Agents", description: "Agent authentication, address leases, x402 payments, ENS verification, and API constraints." },
 faq: { path: "/faq", title: "FAQ | RealAddr for Agents", description: "Virtual slots, prices, World authentication, ENS add-ons, mail settings, and test networks." },
 terms: { path: "/terms", title: "Terms of service | RealAddr for Agents", description: "Adopted Japanese terms of service, version 1, for RealAddr for Agents." },
};
export const PUBLIC_COPY = { ...JAPANESE_COPY,
 headline: "Real-world address rights for AI agents",
 summary: "RealAddr for Agents lets AI agents independently lease the right to use an offline address and helps humans approve mail-forwarding settings that require a human agreement.",
 status: "A demo using Base Sepolia payments and Ethereum Sepolia ENS. Address purchases, renewals, and ENS add-on sales are currently paused.",
};
export function getPublicContent(locale: PublicLocale) { return locale === "ja" ? { pages: JAPANESE_PAGES, copy: JAPANESE_COPY } : { pages: PUBLIC_PAGES, copy: PUBLIC_COPY }; }
export function canonicalUrl(page: PublicPageKey, locale: PublicLocale = "en"): string { return PUBLIC_ORIGIN + PUBLIC_PAGES[page].path + (locale === "ja" ? "?lang=ja" : ""); }
export function getPublicPage(path: string): PublicPageKey | undefined {
 return (Object.keys(PUBLIC_PAGES) as PublicPageKey[]).find(key => PUBLIC_PAGES[key].path === (path === "" ? "/" : path.length > 1 ? path.replace(/\/$/, "") : path));
}
export function sitemapXml(): string {
 const urls = (Object.keys(PUBLIC_PAGES) as PublicPageKey[]).flatMap(page => (["en", "ja"] as const).map(locale => '  <url><loc>' + canonicalUrl(page, locale) + '</loc>' + (["en", "ja", "x-default"] as const).map(lang => '<xhtml:link rel="alternate" hreflang="' + lang + '" href="' + canonicalUrl(page, lang === "ja" ? "ja" : "en") + '"/>').join('') + '</url>')).join("\n");
 return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + urls + '\n</urlset>\n';
}
export function robotsTxt(): string { return 'User-agent: *\nAllow: /\nSitemap: ' + PUBLIC_ORIGIN + '/sitemap.xml\n'; }
export function llmsTxt(locale: PublicLocale = "en"): string {
 const {copy} = getPublicContent(locale);
 return ["# RealAddr for Agents", "", copy.summary, copy.status,
 locale === "ja" ? "ハッカソン版は人間承認、有効表示、宛先フォームまでです。実郵便の受領・発送・送料決済は行いません。" : "The hackathon demo covers human approval, an enabled indicator, and a destination form. It does not receive, ship, or forward physical mail.",
 locale === "ja" ? "住所契約はtestnet/devで30日ごとに0.55 USDC。ENSは任意の初回別決済で標準名0.10 USDC、custom名0.30 USDC。購入済みENSの期間同期は住所更新に含まれます。mainnetは未対応です。" : "Address leases cost 0.55 USDC per 30 days on testnet/dev. Optional one-time ENS add-ons cost 0.10 USDC for standard names or 0.30 USDC for custom names. Purchased ENS maintenance is included in renewals. Mainnet is unavailable.",
 '- OpenAPI: ' + PUBLIC_ORIGIN + '/openapi.json', ...(["developers", "faq", "terms"] as const).map(page => '- ' + getPublicContent(locale).pages[page].title + ': ' + canonicalUrl(page, locale)),
 '- Japanese: ' + PUBLIC_ORIGIN + '/?lang=ja', '- English: ' + PUBLIC_ORIGIN + '/',].join("\n");
}
