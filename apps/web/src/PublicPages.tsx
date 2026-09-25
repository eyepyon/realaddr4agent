import { OPERATOR_NAME, OPERATOR_URL, PUBLIC_COPY, PUBLIC_ORIGIN, PUBLIC_PAGES, type PublicPageKey } from "./public-content";

const navigation = [
  ["/", "概要"],
  ["/developers", "開発者向け"],
  ["/faq", "よくある質問"],
] as const;

function Header({ page }: { page: PublicPageKey }) {
  return (
    <header className="public-header">
      <a className="brand" href="/" aria-label="RealAddr for Agents ホーム">RealAddr <span>for Agents</span></a>
      <nav aria-label="メインナビゲーション">
        {navigation.map(([href, label]) => <a key={href} href={href} aria-current={PUBLIC_PAGES[page].path === href ? "page" : undefined}>{label}</a>)}
      </nav>
    </header>
  );
}

function Footer() {
  return <footer className="public-footer"><span>{OPERATOR_NAME}</span><a href={OPERATOR_URL} target="_blank" rel="noreferrer">運営者サイト</a><span>サービス仕様・接続状況は更新時点の内容です。</span></footer>;
}

function Pricing() {
  return (
    <section className="content-section" aria-labelledby="pricing-title">
      <div className="section-heading"><p className="eyebrow">料金</p><h2 id="pricing-title">住所利用と、選べるENS名</h2><p>テスト環境の価格を表示しています。ENSは希望者向けの初回別料金です。名前の空きと作成時の確定見積はCLIでご確認ください。</p></div>
      <div className="price-grid">
        <article className="price-card"><h3>住所利用</h3><p className="price">{PUBLIC_COPY.addressTest}<span> / 30日</span></p><p>テスト環境での新規利用・更新料金です。</p><p className="muted">将来のmainnet想定: {PUBLIC_COPY.addressMainnet}。mainnet決済は今回未対応です。</p></article>
        <article className="price-card"><h3>ENS 標準名</h3><p className="price">{PUBLIC_COPY.ensStandardTest}<span> / 初回</span></p><p>有効な住所契約に対する任意の追加購入です。</p><p className="muted">将来mainnet想定: {PUBLIC_COPY.ensStandardMainnet}。</p></article>
        <article className="price-card"><h3>ENS custom名</h3><p className="price">{PUBLIC_COPY.ensCustomTest}<span> / 初回</span></p><p>利用者が名前を明示して選ぶ追加購入です。</p><p className="muted">将来mainnet想定: {PUBLIC_COPY.ensCustomMainnet}。</p></article>
      </div>
      <p className="fine-print">住所利用でENSは自動付与されません。購入済みENSの期間同期は住所の更新に含まれます。</p>
    </section>
  );
}

function Home() {
  return <>
    <section className="hero">
      <p className="eyebrow">AIエージェント向け住所契約</p>
      <h1>{PUBLIC_COPY.headline}</h1>
      <p className="lead">{PUBLIC_COPY.summary}</p>
      <div className="hero-actions"><a className="button primary" href="/developers">開発者向け案内</a><a className="button secondary" href="/faq">仕組みとよくある質問</a></div>
      <p className="status-note" role="status">{PUBLIC_COPY.status}</p>
    </section>
    <section className="content-section" aria-labelledby="how-title">
      <div className="section-heading"><p className="eyebrow">利用の流れ</p><h2 id="how-title">契約、検証、人間の設定を分ける</h2></div>
      <div className="steps-grid">
        <article className="info-card"><span className="step-number">01</span><h3>Agentが契約を確認</h3><p>Agent認証、リスク判定、決済確認を経て、サーバーが契約状態を記録します。</p></article>
        <article className="info-card"><span className="step-number">02</span><h3>ENSは希望時に追加</h3><p>ENSは任意の初回別決済です。住所契約だけでENSを購入・発行しません。</p></article>
        <article className="info-card"><span className="step-number">03</span><h3>人間が設定を承認</h3><p>人間の明示承認後に転送設定を有効化し、本人が転送先を入力します。</p></article>
      </div>
      <div className="notice"><strong>ハッカソン版では郵便物を取り扱いません。</strong> 実際の郵便受領・発送・転送や送料決済は行いません。World認証は法的な本人確認を意味しません。</div>
    </section>
    <Pricing />
    <section className="content-section split-section"><div><p className="eyebrow">表示上の注意</p><h2>仮想区画は物理階ではありません</h2><p>各拠点の区画番号は1〜65,535の識別子です。建物の階数や物理的な部屋を表しません。</p></div><div><p className="eyebrow">環境</p><h2>対応ネットワーク</h2><p>住所決済はBase Sepolia、ENSv2照合はEthereum Sepoliaを予定しています。</p><p><a href="/developers">接続状況と開発者向け案内 →</a></p></div></section>
    <section className="cta-band"><div><h2>開発者向けの契約と制約</h2><p>APIの認証・決済・状態遷移は公開契約をご確認ください。</p></div><a className="button primary" href="/developers">開発者向け案内へ</a></section>
  </>;
}

function Developers() {
  return <>
    <section className="page-hero"><p className="eyebrow">開発者向け</p><h1>Agent APIと人間の操作を分けて接続します</h1><p className="lead">画面とAPIを実装中です。provider接続・公開deployは未確認です。API契約を参照し、接続済みであるかのように扱わないでください。</p></section>
    <section className="content-section"><h2>認証と契約</h2><ol className="ordered-steps"><li>Agent walletでchallengeに署名し、Bearer sessionを取得します。</li><li>既存APIで拠点、契約、決済状態を読み取ります。認可はserverが検証します。</li><li>住所purchase/renewはリスク判定後にBase Sepolia x402を通ります。人間のWorld承認は住所購入条件ではありません。</li><li>郵便転送設定の有効化は、対象ownerによるwallet proof、fresh World認証、人間の明示操作を要します。</li></ol><div className="notice">秘密鍵、API key、World secretを画面・promptに貼り付けないでください。Agent credentialでは人間の承認や完全な転送先住所にアクセスできません。</div></section>
    <section className="content-section"><h2>ネットワークと機能状態</h2><div className="network-grid"><article className="info-card"><h3>住所決済</h3><p>{PUBLIC_COPY.paymentNetwork}</p></article><article className="info-card"><h3>ENSv2 / LeaseRegistry</h3><p>{PUBLIC_COPY.ensNetwork}</p></article></div><p>mainnet決済は無効です。価格表示だけで販売可否や名前の空きを推定せず、ENSの正式見積は明示的に作成するintentを正としてください。</p></section>
    <section className="content-section"><h2>契約</h2><p>公開APIはAgent Bearer認証が必要です。匿名の拠点一覧APIは提供しません。完全なrequest/response、error、security定義はOpenAPIを正とします。</p><div className="resource-links"><a className="button secondary" href="/openapi.json">OpenAPI 3.1を開く</a><a href="/">サービス概要</a><a href="/faq">FAQ</a></div></section>
  </>;
}

const faqItems = [
  ["仮想区画は実際の階ですか？", "いいえ。1〜65,535の仮想識別番号です。建物の物理階数を示しません。"],
  ["住所を購入するとENSも付与されますか？", "いいえ。ENSは希望者が別に明示購入する初回add-onです。名前の空きと確定見積はCLIが作成するintentで確認します。"],
  ["World認証で郵便物が送られますか？", "いいえ。World認証は法的KYCではありません。ハッカソン版では、人間の明示承認後に転送設定を有効にし、人間が転送先を入力するところまでです。郵便物の受領・発送は行いません。"],
  ["mainnetは利用できますか？", "今回のmainnet決済は未対応です。表示する将来想定価格は現在購入できることを意味しません。"],
  ["ENSはどのネットワークですか？", "ENSv2とLeaseRegistryはEthereum Sepolia、住所決済はBase Sepoliaを予定しています。設定や実接続が確認される前に、成功・稼働中とは表示しません。"],
];

function Faq() {
  return <>
    <section className="page-hero"><p className="eyebrow">よくある質問</p><h1>利用範囲と状態について</h1><p className="lead">料金と機能は環境ごとに異なります。公開済み・実接続済みとは限りません。</p></section>
    <section className="content-section faq-list">{faqItems.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</section>
    <section className="content-section"><h2>まだ不明な点は？</h2><p>公開APIの仕様と現在の制約は開発者向け案内をご確認ください。</p><a className="button secondary" href="/developers">開発者向け案内</a></section>
  </>;
}

export function PublicPage({ page }: { page: PublicPageKey }) {
  const body = page === "home" ? <Home /> : page === "developers" ? <Developers /> : <Faq />;
  const organization = { "@type": "Organization", name: OPERATOR_NAME, url: OPERATOR_URL };
  const structuredData = page === "home" ? {
    "@context": "https://schema.org",
    "@graph": [organization, { "@type": "WebSite", name: "RealAddr for Agents", url: PUBLIC_ORIGIN }, { "@type": "Service", name: "RealAddr for Agents", description: PUBLIC_COPY.summary, url: PUBLIC_ORIGIN }],
  } : { "@context": "https://schema.org", ...organization };
  return <div className="public-site"><Header page={page} /><main id="main-content" className="public-main">{body}</main><Footer /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
    ...structuredData,
  }) }} /></div>;
}
