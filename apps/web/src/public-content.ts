export const PUBLIC_ORIGIN = "https://address.chain.tokyo";
export const OPERATOR_NAME = "国立日本総合研究センター株式会社";
export const OPERATOR_URL = "https://jgrec.jp/";
export const PAYMENT_NETWORK = "Base Sepolia";
export const ENS_NETWORK = "Ethereum Sepolia";

export type PublicPageKey = "home" | "developers" | "faq" | "terms";

export const PUBLIC_PAGES: Record<PublicPageKey, { path: string; title: string; description: string }> = {
  home: {
    path: "/",
    title: "AIエージェントの住所利用を、人間が管理できる形に | RealAddr for Agents",
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

export const PUBLIC_COPY = {
  headline: "AIエージェントの住所利用を、人間が管理できる形で。",
  summary: "RealAddr for Agentsは、AIエージェントの住所利用契約と、人間が管理する転送先設定を分離するサービスです。",
  addressMainnet: "55 USDC",
  addressTest: "0.55 USDC",
  ensStandardMainnet: "10 USDC",
  ensStandardTest: "0.10 USDC",
  ensCustomMainnet: "30 USDC",
  ensCustomTest: "0.30 USDC",
  status: "画面とAPIの実装中です。外部サービス接続、提供拠点、公開運用は未確認です。",
  paymentNetwork: PAYMENT_NETWORK,
  ensNetwork: ENS_NETWORK,
};

export function canonicalUrl(page: PublicPageKey): string {
  return `${PUBLIC_ORIGIN}${PUBLIC_PAGES[page].path}`;
}

export function getPublicPage(path: string): PublicPageKey | undefined {
  if (path === "/" || path === "") return "home";
  if (path === "/developers" || path === "/developers/") return "developers";
  if (path === "/faq" || path === "/faq/") return "faq";
  if (path === "/terms" || path === "/terms/") return "terms";
  return undefined;
}

export function sitemapXml(): string {
  const urls = Object.values(PUBLIC_PAGES)
    .map((page) => `  <url><loc>${PUBLIC_ORIGIN}${page.path}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(): string {
  return `User-agent: *\nAllow: /\nSitemap: ${PUBLIC_ORIGIN}/sitemap.xml\n`;
}

export function llmsTxt(): string {
  return [
    "# RealAddr for Agents",
    "",
    PUBLIC_COPY.summary,
    "画面とAPIを実装中です。provider接続・公開deployは未確認です。ハッカソン版では実郵便の受領・発送・送料決済を行いません。",
    "住所契約は30日ごとにtestnet/dev 0.55 USDCです。future mainnet想定55 USDCは今回未対応です。",
    "ENSは任意の初回別決済で、testnet/devは標準名0.10 USDC、custom名0.30 USDCです。購入済みENSは住所更新に期間同期を含みます。",
    `- API契約: ${PUBLIC_ORIGIN}/openapi.json`,
    `- 開発者ガイド: ${PUBLIC_ORIGIN}/developers`,
    `- FAQ: ${PUBLIC_ORIGIN}/faq`,
    `- 利用規約 version 1: ${PUBLIC_ORIGIN}/terms`,
  ].join("\n");
}
