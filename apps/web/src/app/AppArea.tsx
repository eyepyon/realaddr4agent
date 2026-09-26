import { useEffect, useState } from "react";
import { PUBLIC_ORIGIN } from "../public-content";

type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
declare global { interface Window { ethereum?: Provider } }

type AgentSession = { agentId: string; token: string; expiresAt: string };
type Subscription = { id: string; locationId: string; floor: number; status: string; expiresAt: string; version: number; displayAddress: string; chain: Record<string, unknown>; mail: { status: string; destinationConfigured: boolean; physicalForwardingAvailable: false }; ens: { status: string; network: string; name?: string; expiresAt?: string; lastErrorCode?: string } };
type PaymentIntent = { id: string; kind: string; status: string; amountAtomic: string; network: string; expiresAt: string; createdAt: string; receipt?: { transactionHash?: string } };

const termsVersion = import.meta.env.VITE_TERMS_VERSION;
const chainIdHex = "0x14a34";
const apiNetwork = "eip155:84532";

function errorMessage(error: unknown): string {
  const code = (error as { error?: string; code?: string } | null)?.code ?? (error as { error?: string } | null)?.error ?? "";
  if (code === "wallet_network_mismatch") return "ウォレットをBase Sepoliaへ切り替えてから再試行してください。";
  if (code === "challenge_expired") return "wallet challengeの期限が切れました。最初からやり直してください。";
  if (code === "wallet_unavailable") return "ブラウザwalletを利用できません。対応walletを接続してください。";
  if (code === "terms_unconfigured") return "Agent規約versionが設定されていないため、認証を開始できません。";
  if (code === "challenge_invalid") return "challengeの内容または有効期限を検証できません。署名しませんでした。";
  if (error instanceof TypeError) return "APIに接続できませんでした。";
  return "認証またはデータ取得を完了できませんでした。画面を再読み込みして状態を確認してください。";
}

async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: "same-origin", redirect: "error", cache: "no-store", headers: { "content-type": "application/json", ...options.headers } });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(String(data.error ?? response.status)) as Error & { status?: number; code?: string };
    error.status = response.status; error.code = typeof data.error === "string" ? data.error : undefined; throw error;
  }
  return data as T;
}

function labelStatus(value: string): string {
  const labels: Record<string, string> = { active: "有効", enabled: "有効", disabled: "無効", suspended: "停止", expired: "期限切れ", pending: "処理待ち", settling: "決済確認中", reconciling: "照合中", fulfilled: "完了", not_purchased: "未購入", pending_readback: "反映確認中", unknown: "結果不明", manual_review: "要確認", failed: "失敗" };
  return labels[value] ?? value;
}

function formatDate(value?: string): string { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date); }

export function AppArea() {
  const [consented, setConsented] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [challenge, setChallenge] = useState<{ challengeId: string; message: string; expiresAt: string } | null>(null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [payments, setPayments] = useState<PaymentIntent[] | null>(null);
  const [selectedSubscription, setSelectedSubscription] = useState<Subscription | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentCursor, setPaymentCursor] = useState<string | null>(null);
  const [subscriptionCursor, setSubscriptionCursor] = useState<string | null>(null);

  const loadData = async (bearer: string) => {
    setBusy(true); setError(""); setNotice("自分の契約と決済情報を取得しています。");
    try {
      const headers = { Authorization: `Bearer ${bearer}` };
      const [subsResult, paysResult] = await Promise.allSettled([
        apiJson<{ subscriptions: Subscription[]; nextCursor: string | null }>("/v1/subscriptions?limit=20", { headers }),
        apiJson<{ paymentIntents: PaymentIntent[]; nextCursor: string | null }>("/v1/payment-intents?limit=20", { headers }),
      ]);
      if (subsResult.status === "fulfilled") { setSubscriptions(subsResult.value.subscriptions); setSubscriptionCursor(subsResult.value.nextCursor); }
      else { setSubscriptions(null); setSubscriptionCursor(null); }
      if (paysResult.status === "fulfilled") { setPayments(paysResult.value.paymentIntents); setPaymentCursor(paysResult.value.nextCursor); }
      else { setPayments(null); setPaymentCursor(null); }
      const failures = [subsResult, paysResult].filter((result) => result.status === "rejected");
      if (failures.length) { setError("一部の利用者データを取得できませんでした。成功した一覧だけを表示しています。"); setNotice(""); }
      else { setError(""); setNotice("表示中のページを取得しました。全件数ではありません。"); }
    } catch (caught) { setError(errorMessage(caught)); setNotice(""); }
    finally { setBusy(false); }
  };

  const connectWallet = async () => {
    setBusy(true); setError(""); setNotice(""); setChallenge(null);
    try {
      if (!termsVersion) throw Object.assign(new Error("terms_unconfigured"), { code: "terms_unconfigured" });
      if (!window.ethereum) throw Object.assign(new Error("wallet_unavailable"), { code: "wallet_unavailable" });
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw Object.assign(new Error("wallet_unavailable"), { code: "wallet_unavailable" });
      const address = accounts[0];
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      if (String(chainId).toLowerCase() !== chainIdHex) throw Object.assign(new Error("wallet_network_mismatch"), { code: "wallet_network_mismatch" });
      setWalletAddress(address);
      const created = await apiJson<{ challengeId: string; message: string; expiresAt: string }>("/v1/auth/challenges", { method: "POST", body: JSON.stringify({ walletAddress: address, network: apiNetwork, termsVersion }) });
      const expiry = new Date(created.expiresAt);
      const localHosts = ["localhost", "127.0.0.1", "::1"];
      const localHostname = window.location.hostname.toLowerCase();
      if (import.meta.env.VITE_APP_ENV === "local" && !localHosts.includes(localHostname)) throw Object.assign(new Error("challenge_invalid"), { code: "challenge_invalid" });
      const origin = import.meta.env.VITE_APP_ENV === "local" ? localHostname : new URL(PUBLIC_ORIGIN).hostname;
      const lines = created.message.split("\n");
      const nonceLine = lines[3] ?? "";
      const expectedExpiry = expiry.toISOString();
      const messageValid = lines.length === 6
        && lines[0] === `${origin} wants you to sign in to RealAddr for Agents`
        && lines[1] === `Wallet: ${address.toLowerCase()}`
        && lines[2] === `Chain: ${apiNetwork}`
        && nonceLine.startsWith("Nonce: ") && nonceLine.slice(7).trim().length > 0
        && lines[4] === `Expires: ${expectedExpiry}`
        && lines[5] === `Terms: ${termsVersion}`;
      if (!created.challengeId || !created.message || Number.isNaN(expiry.valueOf()) || expiry.valueOf() <= Date.now() || expiry.valueOf() > Date.now() + 5 * 60 * 1000 || !messageValid) throw Object.assign(new Error("challenge_invalid"), { code: "challenge_invalid" });
      setChallenge(created);
      setNotice("Challengeを取得しました。署名前に内容を確認してください。");
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };

  const signChallenge = async () => {
    if (!challenge || !walletAddress || !window.ethereum) return;
    setBusy(true); setError("");
    try {
      const expiry = new Date(challenge.expiresAt);
      if (expiry.valueOf() <= Date.now()) throw Object.assign(new Error("challenge_expired"), { code: "challenge_expired" });
      const signature = await window.ethereum.request({ method: "personal_sign", params: [challenge.message, walletAddress] });
      if (typeof signature !== "string" || !/^0x[\da-f]+$/i.test(signature)) throw new Error("signature_invalid");
      const created = await apiJson<AgentSession>("/v1/auth/sessions", { method: "POST", body: JSON.stringify({ challengeId: challenge.challengeId, signature }) });
      if (!created.token || !created.expiresAt) throw new Error("session_invalid");
      setSession(created); setChallenge(null);
      await loadData(created.token);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };

  const revokeSession = async () => {
    if (!session) return;
    setBusy(true);
    try { await apiJson("/v1/auth/session", { method: "DELETE", headers: { Authorization: `Bearer ${session.token}`, "Idempotency-Key": crypto.randomUUID() } }); }
    catch { /* Local credential is discarded even if revocation response is unavailable. */ }
    setSession(null); setSubscriptions(null); setPayments(null); setWalletAddress(""); setSelectedSubscription(null); setBusy(false);
  };

  const loadMore = async (kind: "subscriptions" | "payments") => {
    if (!session) return;
    const cursor = kind === "subscriptions" ? subscriptionCursor : paymentCursor;
    if (!cursor) return;
    setBusy(true); setError("");
    try {
      const headers = { Authorization: `Bearer ${session.token}` };
      if (kind === "subscriptions") {
        const data = await apiJson<{ subscriptions: Subscription[]; nextCursor: string | null }>(`/v1/subscriptions?limit=20&cursor=${encodeURIComponent(cursor)}`, { headers });
        setSubscriptions((current) => current ? [...current, ...data.subscriptions] : data.subscriptions); setSubscriptionCursor(data.nextCursor);
      } else {
        const data = await apiJson<{ paymentIntents: PaymentIntent[]; nextCursor: string | null }>(`/v1/payment-intents?limit=20&cursor=${encodeURIComponent(cursor)}`, { headers });
        setPayments((current) => current ? [...current, ...data.paymentIntents] : data.paymentIntents); setPaymentCursor(data.nextCursor);
      }
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const path = window.location.pathname;
    const match = path.match(/^\/app\/subscriptions\/([^/]+)\/?$/);
    if (match && session) {
      void apiJson<Subscription>(`/v1/subscriptions/${encodeURIComponent(match[1]!)}`, { headers: { Authorization: `Bearer ${session.token}` } })
        .then((data) => setSelectedSubscription(data)).catch((caught) => setError(errorMessage(caught)));
    }
  }, [session]);

  return <main className="app-page" id="main-content">
    <header className="app-header"><a className="brand" href="/">RealAddr <span>for Agents</span></a><nav aria-label="利用者ナビ"><a href="/app">概要</a><a href="/app/subscriptions">契約</a><a href="/app/payments">決済</a></nav>{session && <button className="admin-button" onClick={() => void revokeSession()} disabled={busy}>walletを切断</button>}</header>
    <section className="app-content"><p className="eyebrow">利用者ポータル</p><h1>{session ? "ご自身の契約" : "walletで接続"}</h1>
      {!session && <div className="login-card"><p>接続したwalletの署名でAgent APIへ認証します。秘密鍵を入力する欄はありません。署名はAPI sessionの取得だけに使い、決済や契約更新は実行しません。</p>
        {!termsVersion && <div className="notice warning">Agent規約versionが設定されていないため、wallet認証を利用できません。</div>}
        <section className="notice terms-summary" aria-labelledby="terms-title"><h2 id="terms-title">利用条件の要点（{termsVersion || "未設定"}）</h2><ul><li>この署名はAgent APIへの認証だけに使い、購入・更新・送金を実行しません。</li><li>住所利用は30日単位の契約です。ENS名は別途選択する任意の初回追加購入です。</li><li>Agent APIは人間が入力した完全な転送先住所を表示せず、郵便転送の有効化は人間の明示承認を必要とします。</li><li>ハッカソン版では郵便物の受領・発送や送料決済を行いません。World認証は法的本人確認を意味しません。</li><li>利用できる販売環境、決済、拠点は運用者による有効化が必要です。画面の表示だけで利用可能とは限りません。</li></ul><p><a href="/faq">サービスの範囲とFAQを見る</a></p><p><a href="/terms">利用規約原案の全文を見る</a>。正式な規約は未確定で、この原案は現在のwallet認証の同意対象ではありません。</p></section>
        <label className="consent-row"><input type="checkbox" checked={consented} onChange={(event) => { setConsented(event.target.checked); setChallenge(null); }} /> <span>上記の利用条件（{termsVersion || "未設定"}）を読み、内容を理解したうえでwallet challengeを確認して署名します。</span></label>
        {!challenge ? <button className="admin-button primary" disabled={busy || !consented || !termsVersion} onClick={() => void connectWallet()}>{busy ? "接続中…" : "Base Sepolia walletを接続"}</button> : <div className="challenge-box"><h2>署名前に確認してください</h2><p>このメッセージに秘密鍵・支払い指示が含まれていないこと、domain、wallet、chain、terms、expiryが一致していることを確認してください。</p><pre>{challenge.message}</pre><p>期限: {formatDate(challenge.expiresAt)}</p><button className="admin-button primary" disabled={busy || !consented || new Date(challenge.expiresAt).valueOf() <= Date.now()} onClick={() => void signChallenge()}>内容を確認して署名</button><button className="admin-button" disabled={busy} onClick={() => setChallenge(null)}>キャンセル</button></div>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>}
      {session && <><div className="toolbar"><p>接続wallet: <code>{walletAddress}</code> · session期限 {formatDate(session.expiresAt)}</p><button className="admin-button" disabled={busy} onClick={() => void loadData(session.token)}>更新</button></div>
        {notice && <div className="notice" role="status" aria-live="polite">{notice}</div>}{error && <div className="notice error" role="alert">{error}</div>}
        {selectedSubscription && <section className="panel"><div className="detail-header"><div><p className="eyebrow">契約詳細</p><h2>{selectedSubscription.id}</h2></div><button className="admin-button" onClick={() => setSelectedSubscription(null)}>一覧へ戻る</button></div><dl className="detail-grid"><div className="detail-row"><dt>仮想区画</dt><dd>V{String(selectedSubscription.floor).padStart(5, "0")}</dd></div><div className="detail-row"><dt>契約状態</dt><dd>{labelStatus(selectedSubscription.status)}</dd></div><div className="detail-row"><dt>期限</dt><dd>{formatDate(selectedSubscription.expiresAt)}</dd></div><div className="detail-row"><dt>住所</dt><dd>{selectedSubscription.displayAddress}</dd></div><div className="detail-row"><dt>ENS名</dt><dd>{selectedSubscription.ens.name ?? "未購入"}</dd></div><div className="detail-row"><dt>ENS状態</dt><dd>{labelStatus(selectedSubscription.ens.status)} · {selectedSubscription.ens.network}</dd></div><div className="detail-row"><dt>転送設定</dt><dd>{labelStatus(selectedSubscription.mail.status)} · 転送先 {selectedSubscription.mail.destinationConfigured ? "登録済み" : "未登録"}</dd></div></dl>{selectedSubscription.ens.status === "not_purchased" && <p>ENS追加の名前選択・見積はCLIで確認してください。Web画面は新しい署名・支払いを開始しません。</p>}<p className="muted">契約更新は対応するCLI操作へ引き渡します。Agent APIでは人間が入力した完全な転送先住所を表示しません。</p></section>}
        <section className="panel"><h2>契約</h2>{subscriptions === null ? <div className="empty-state" role="status">契約一覧を取得できません。</div> : <><p className="muted">読み込んだ範囲: {subscriptions.length}件。すべての契約件数ではありません。</p>{subscriptions.length ? <div className="table-wrap"><table><thead><tr><th>契約ID</th><th>拠点</th><th>仮想区画</th><th>状態</th><th>期限</th><th>ENS</th><th>転送設定</th></tr></thead><tbody>{subscriptions.map((item) => <tr key={item.id}><td><button className="row-button" onClick={() => setSelectedSubscription(item)}>{item.id}</button></td><td>{item.locationId}</td><td>V{String(item.floor).padStart(5, "0")}</td><td>{labelStatus(item.status)}</td><td>{formatDate(item.expiresAt)}</td><td>{item.ens.name ?? `未購入 · ${labelStatus(item.ens.status)}`}</td><td>{labelStatus(item.mail.status)} · {item.mail.destinationConfigured ? "登録済み" : "未登録"}</td></tr>)}</tbody></table></div> : <div className="empty-state"><p>契約はまだありません。</p><a href="/developers">開発者向けの利用案内</a></div>}{subscriptionCursor && <button className="admin-button" disabled={busy} onClick={() => void loadMore("subscriptions")}>次の20件</button>}</>}</section>
        <section className="panel"><h2>決済</h2>{payments === null ? <div className="empty-state" role="status">決済一覧を取得できません。</div> : <><p className="muted">読み込んだ範囲: {payments.length}件。全件数ではありません。</p>{payments.length ? <div className="table-wrap"><table><thead><tr><th>Intent</th><th>状態</th><th>金額</th><th>作成日時</th></tr></thead><tbody>{payments.map((item) => <tr key={item.id}><td>{item.id}</td><td>{labelStatus(item.status)}</td><td>{item.amountAtomic} atomic</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <div className="empty-state">表示する決済記録はありません。</div>}{paymentCursor && <button className="admin-button" disabled={busy} onClick={() => void loadMore("payments")}>次の20件</button>}</>}</section>
      </>}
    </section>
  </main>;
}
