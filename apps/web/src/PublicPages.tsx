import { OPERATOR_NAME, OPERATOR_URL, PUBLIC_PAGES, canonicalUrl, getPublicContent, type PublicPageKey } from "./public-content";
import { useLocale } from "./i18n";
import { TermsPage } from "./TermsPage";

const navigation = [
  ["/", "概要", "Overview"],
  ["/developers", "開発者向け", "Developers"],
  ["/faq", "よくある質問", "FAQ"],
  ["/terms", "利用規約", "Terms"],
] as const;

function Header({ page }: { page: PublicPageKey }) {
  const {t, href: localeHref} = useLocale();
  return (
    <header className="public-header">
      <a className="brand" href={localeHref("/")} aria-label={t("RealAddr for Agents ホーム", "RealAddr for Agents home")}>RealAddr <span>for Agents</span></a>
      <nav aria-label={t("メインナビゲーション", "Main navigation")}>
        {navigation.map(([href, label, english]) => <a key={href} href={localeHref(href)} aria-current={PUBLIC_PAGES[page].path === href ? "page" : undefined}>{t(label, english)}</a>)}
      </nav>
    </header>
  );
}

function Footer() {
  const {t, href: localeHref} = useLocale();
  return <footer className="public-footer"><span>{OPERATOR_NAME}</span><a href={OPERATOR_URL} target="_blank" rel="noreferrer">{t("運営者サイト", "Operator website")}</a><a href={localeHref("/terms")}>{t("利用規約（version 1）", "Terms of service (version 1)")}</a><span>{t("サービス仕様・接続状況は更新時点の内容です。", "Service details reflect the latest update.")}</span></footer>;
}

function Pricing() {
  const {t, locale} = useLocale();
  const {copy: PUBLIC_COPY} = getPublicContent(locale);
  return (
    <section className="content-section" aria-labelledby="pricing-title">
      <div className="section-heading"><p className="eyebrow">{t("料金", "Pricing")}</p><h2 id="pricing-title">{t("住所利用と、選べるENS名", "Address leases and optional ENS names")}</h2><p>{t("テスト環境の価格を表示しています。ENSは希望者向けの初回別料金です。名前の空きと作成時の確定見積はCLIでご確認ください。", "Prices shown are for test environments. ENS is an optional one-time add-on. Check name availability and the final quote through the CLI.")}</p></div>
      <div className="price-grid">
        <article className="price-card"><h3>{t("住所利用", "Address lease")}</h3><p className="price">{PUBLIC_COPY.addressTest}<span>{t(" / 30日", " / 30 days")}</span></p><p>{t("テスト環境での新規利用・更新料金です。", "New leases and renewals in the test environment.")}</p><p className="muted">{t("将来のmainnet想定: ", "Future mainnet price: ")}{PUBLIC_COPY.addressMainnet}{t("。mainnet決済は今回未対応です。", ". Mainnet payments are unavailable.")}</p></article>
        <article className="price-card"><h3>{t("ENS 標準名", "Standard ENS name")}</h3><p className="price">{PUBLIC_COPY.ensStandardTest}<span>{t(" / 初回", " / one time")}</span></p><p>{t("有効な住所契約に対する任意の追加購入です。", "An optional add-on for an active address lease.")}</p><p className="muted">{t("将来mainnet想定: ", "Future mainnet price: ")}{PUBLIC_COPY.ensStandardMainnet}{t("。", ".")}</p></article>
        <article className="price-card"><h3>{t("ENS custom名", "Custom ENS name")}</h3><p className="price">{PUBLIC_COPY.ensCustomTest}<span>{t(" / 初回", " / one time")}</span></p><p>{t("利用者が名前を明示して選ぶ追加購入です。", "An add-on with a name explicitly chosen by the user.")}</p><p className="muted">{t("将来mainnet想定: ", "Future mainnet price: ")}{PUBLIC_COPY.ensCustomMainnet}{t("。", ".")}</p></article>
      </div>
      <p className="fine-print">{t("住所利用でENSは自動付与されません。購入済みENSの期間同期は住所の更新に含まれます。", "Address purchases do not automatically include ENS. Purchased ENS expiry synchronization is included in address renewals.")}</p>
    </section>
  );
}

function Home() {
  const {t, href: localeHref, locale} = useLocale();
  const {copy: PUBLIC_COPY} = getPublicContent(locale);
  return <>
    <section className="hero">
      <p className="eyebrow">{t("AIエージェント向け住所契約", "Address leases for AI agents")}</p>
      <h1>{PUBLIC_COPY.headline}</h1>
      <p className="lead">{PUBLIC_COPY.summary}</p>
      <div className="hero-actions"><a className="button primary" href={localeHref("/developers")}>{t("開発者向け案内", "Developer guide")}</a><a className="button secondary" href={localeHref("/faq")}>{t("仕組みとよくある質問", "How it works and FAQ")}</a></div>
      <p className="status-note" role="status">{PUBLIC_COPY.status}</p>
    </section>
    <section className="content-section" aria-labelledby="how-title">
      <div className="section-heading"><p className="eyebrow">{t("利用の流れ", "How it works")}</p><h2 id="how-title">{t("契約、検証、人間の設定を分ける", "Leases, verification, and human settings")}</h2></div>
      <div className="steps-grid">
        <article className="info-card"><span className="step-number">01</span><h3>{t("Agentが契約を確認", "The agent checks its lease")}</h3><p>{t("Agent認証、リスク判定、決済確認を経て、サーバーが契約状態を記録します。", "After agent authentication, screening, and payment verification, the server records the lease state.")}</p></article>
        <article className="info-card"><span className="step-number">02</span><h3>{t("ENSは希望時に追加", "Add ENS when you choose")}</h3><p>{t("ENSは任意の初回別決済です。住所契約だけでENSを購入・発行しません。", "ENS requires a separate optional one-time payment. An address lease alone does not purchase or issue an ENS name.")}</p></article>
        <article className="info-card"><span className="step-number">03</span><h3>{t("人間が設定を承認", "A human approves the settings")}</h3><p>{t("人間の明示承認後に転送設定を有効化し、本人が転送先を入力します。", "A human explicitly approves forwarding settings and enters the destination themselves.")}</p></article>
      </div>
      <div className="notice"><strong>{t("ハッカソン版では郵便物を取り扱いません。", "The hackathon demo does not handle physical mail.")}</strong>{t(" 実際の郵便受領・発送・転送や送料決済は行いません。World認証は法的な本人確認を意味しません。", " It does not receive, ship, or forward mail or collect postage. World authentication is not legal identity verification.")}</div>
    </section>
    <Pricing />
    <section className="content-section split-section"><div><p className="eyebrow">{t("表示上の注意", "Understanding slots")}</p><h2>{t("仮想区画は物理階ではありません", "Virtual slots are not physical floors")}</h2><p>{t("各拠点の区画番号は1〜65,535の識別子です。建物の階数や物理的な部屋を表しません。", "Each location has identifiers from 1 to 65,535. They do not represent floors or physical rooms.")}</p></div><div><p className="eyebrow">{t("環境", "Environment")}</p><h2>{t("対応ネットワーク", "Supported networks")}</h2><p>{t("デモでは住所決済にBase Sepolia、ENSv2にEthereum Sepoliaを使用します。", "Address payments use Base Sepolia; ENSv2 uses Ethereum Sepolia in the demo.")}</p><p><a href={localeHref("/developers")}>{t("接続状況と開発者向け案内 →", "Integration details and developer guide →")}</a></p></div></section>
    <section className="cta-band"><div><h2>{t("開発者向けの契約と制約", "Developer contracts and constraints")}</h2><p>{t("APIの認証・決済・状態遷移は公開契約をご確認ください。", "See the public API contract for authentication, payment, and state transitions.")}</p></div><a className="button primary" href={localeHref("/developers")}>{t("開発者向け案内へ", "Read the developer guide")}</a></section>
  </>;
}

function Developers() {
  const {t, href: localeHref, locale} = useLocale();
  const {copy: PUBLIC_COPY} = getPublicContent(locale);
  return <>
    <section className="page-hero"><p className="eyebrow">{t("開発者向け", "Developers")}</p><h1>{t("Agent APIと人間の操作を分けて接続します", "Connect agent APIs and human actions separately")}</h1><p className="lead">{t("wallet認証、testnet決済、ENS照合、人間承認を組み合わせたデモです。住所購入・更新・ENS add-onは現在受付を停止しています。", "The demo combines wallet authentication, testnet payments, ENS verification, and human approval. Address purchases, renewals, and ENS add-on sales are currently paused.")}</p></section>
    <section className="content-section"><h2>{t("認証と契約", "Authentication and leases")}</h2><ol className="ordered-steps"><li>{t("Agent walletでchallengeに署名し、Bearer sessionを取得します。", "Sign a challenge with the agent wallet to obtain a Bearer session.")}</li><li>{t("既存APIで拠点、契約、決済状態を読み取ります。認可はserverが検証します。", "Read locations, leases, and payment states through the API. The server checks authorization.")}</li><li>{t("住所purchase/renewはリスク判定後にBase Sepolia x402を通ります。人間のWorld承認は住所購入条件ではありません。", "Address purchases and renewals use Base Sepolia x402 after screening. Human World approval is not required to rent an address.")}</li><li>{t("郵便転送設定の有効化は、対象ownerによるwallet proof、fresh World認証、人間の明示操作を要します。", "Enabling forwarding settings requires the owner's wallet proof, fresh World authentication, and an explicit human action.")}</li></ol><div className="notice">{t("秘密鍵、API key、World secretを画面・promptに貼り付けないでください。Agent credentialでは人間の承認や完全な転送先住所にアクセスできません。", "Do not paste private keys, API keys, or World secrets into screens or prompts. Agent credentials cannot approve human actions or access a full forwarding destination.")}</div></section>
    <section className="content-section"><h2>{t("ネットワークと機能状態", "Networks and feature status")}</h2><div className="network-grid"><article className="info-card"><h3>{t("住所決済", "Address payments")}</h3><p>{PUBLIC_COPY.paymentNetwork}</p></article><article className="info-card"><h3>ENSv2 / LeaseRegistry</h3><p>{PUBLIC_COPY.ensNetwork}</p></article></div><p>{t("mainnet決済は無効です。価格表示だけで販売可否や名前の空きを推定せず、ENSの正式見積は明示的に作成するintentを正としてください。", "Mainnet payments are disabled. Displayed prices do not guarantee sale availability or an available name. An explicitly created ENS intent is the authoritative quote.")}</p></section>
    <section className="content-section"><h2>{t("契約", "API contract")}</h2><p>{t("公開APIはAgent Bearer認証が必要です。匿名の拠点一覧APIは提供しません。完全なrequest/response、error、security定義はOpenAPIを正とします。", "The public API requires Agent Bearer authentication. There is no anonymous location-list API. OpenAPI defines complete requests, responses, errors, and security requirements.")}</p><div className="resource-links"><a className="button secondary" href={localeHref("/openapi.json")}>{t("OpenAPI 3.1を開く", "Open OpenAPI 3.1")}</a><a href={localeHref("/")}>{t("サービス概要", "Service overview")}</a><a href={localeHref("/faq")}>FAQ</a></div></section>
  </>;
}

const faqItems = [
  ["仮想区画は実際の階ですか？", "いいえ。1〜65,535の仮想識別番号です。建物の物理階数を示しません。"],
  ["住所を購入するとENSも付与されますか？", "いいえ。ENSは希望者が別に明示購入する初回add-onです。名前の空きと確定見積はCLIが作成するintentで確認します。"],
  ["World認証で郵便物が送られますか？", "いいえ。World認証は法的KYCではありません。ハッカソン版では、人間の明示承認後に転送設定を有効にし、人間が転送先を入力するところまでです。郵便物の受領・発送は行いません。"],
  ["mainnetは利用できますか？", "今回のmainnet決済は未対応です。表示する将来想定価格は現在購入できることを意味しません。"],
  ["ENSはどのネットワークですか？", "ENSv2とLeaseRegistryはEthereum Sepolia、住所決済はBase Sepoliaを使用するデモです。"],
];

const englishFaqItems = [["Are virtual slots real floors?","No. They are virtual identifiers from 1 to 65,535, not physical floors."],["Does an address purchase include ENS?","No. ENS is a separately purchased, optional one-time add-on. Check availability and the final quote in the intent created by the CLI."],["Does World authentication send mail?","No. World authentication is not legal KYC. This demo covers explicit human approval and a human-entered destination form, without receiving or shipping mail."],["Is mainnet available?","Mainnet payments are unavailable. Future mainnet prices do not indicate current availability."],["Which network does ENS use?","ENSv2 and LeaseRegistry use Ethereum Sepolia; address payments use Base Sepolia in the demo."]];

function Faq() {
  const {t, href: localeHref, locale} = useLocale();
  return <>
    <section className="page-hero"><p className="eyebrow">{t("よくある質問", "FAQ")}</p><h1>{t("利用範囲と状態について", "Scope and service behavior")}</h1><p className="lead">{t("デモはtestnetを使用します。料金と利用できる機能は環境ごとに異なります。", "This demo uses test networks. Prices and available features depend on the environment.")}</p></section>
    <section className="content-section faq-list">{(locale === "ja" ? faqItems : englishFaqItems).map(([question, answer], index) => <details key={index}><summary>{question}</summary><p>{answer}</p></details>)}</section>
    <section className="content-section"><h2>{t("まだ不明な点は？", "Still have questions?")}</h2><p>{t("公開APIの仕様と現在の制約は開発者向け案内をご確認ください。", "See the developer guide for the public API specification and current constraints.")}</p><a className="button secondary" href={localeHref("/developers")}>{t("開発者向け案内", "Developer guide")}</a></section>
  </>;
}

export function PublicPage({ page }: { page: PublicPageKey }) {
  const {locale} = useLocale();
  const {copy: PUBLIC_COPY} = getPublicContent(locale);
  const body = page === "home" ? <Home /> : page === "developers" ? <Developers /> : page === "terms" ? <TermsPage /> : <Faq />;
  const organization = { "@type": "Organization", name: OPERATOR_NAME, url: OPERATOR_URL };
  const structuredData = page === "home" ? {
    "@context": "https://schema.org",
    "@graph": [organization, { "@type": "WebSite", name: "RealAddr for Agents", url: canonicalUrl(page, locale), inLanguage: locale }, { "@type": "Service", name: "RealAddr for Agents", description: PUBLIC_COPY.summary, url: canonicalUrl(page, locale), inLanguage: locale }],
  } : { "@context": "https://schema.org", "@graph": [organization, { "@type": "WebPage", name: getPublicContent(locale).pages[page].title, url: canonicalUrl(page, locale), inLanguage: locale }] };
  return <div className="public-site"><Header page={page} /><main id="main-content" className="public-main">{body}</main><Footer /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
    ...structuredData,
  }) }} /></div>;
}
