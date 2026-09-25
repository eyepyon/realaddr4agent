export function ApprovalShell() {
  return <main className="approval-page" id="main-content"><a className="brand" href="/">RealAddr <span>for Agents</span></a><section className="login-card"><p className="eyebrow">人間の確認</p><h1>承認対象を確認しています</h1><p>このURLだけでは契約や利用者情報は表示されません。承認操作にはowner walletの確認、fresh World認証、人間の明示操作が必要です。</p><div className="notice warning">承認APIと認証経路の実接続が確認されるまで、ここから許可・拒否の成功操作はできません。</div><p><a href="/faq">承認と郵便機能の説明</a></p></section></main>;
}
