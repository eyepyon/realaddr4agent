import { useEffect, useState } from 'react';

type Approval = { id: string; subscriptionId: string; agentId: string; actionHash: string; status: string; expiresAt: string | null; ownerWallet: string; worldAuthenticated: boolean };
type Destination = { country: 'JP'; recipient: string; postalCode: string; prefecture: string; city: string; addressLine1: string; addressLine2: string };
type Profile = { version: number; mail: { status: string; destinationConfigured: boolean }; destination: Destination | null };
const empty: Destination = { country: 'JP', recipient: '', postalCode: '', prefecture: '', city: '', addressLine1: '', addressLine2: '' };
function csrf(): string { return document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith('__Host-realaddr_csrf='))?.slice(21) ?? ''; }
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error('request_failed'), { code: data.error });
  return data as T;
}
export function ApprovalShell() {
  const approvalId = window.location.pathname.split('/')[2] ?? '';
  const path = `/v1/approvals/${approvalId}`;
  const [approval, setApproval] = useState<Approval | null>(null), [challenge, setChallenge] = useState<{ challengeId: string; message: string; expiresAt: string } | null>(null);
  const [wallet, setWallet] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [profile, setProfile] = useState<Profile | null>(null), [destination, setDestination] = useState<Destination>(empty);
  const [confirmed, setConfirmed] = useState(false), [editing, setEditing] = useState(false);
  const load = async () => {
    const current = await api<Approval>(path); setApproval(current);
    if (current.status === 'applied') { const data = await api<Profile>(`/v1/subscriptions/${current.subscriptionId}/mail-profile`); setProfile(data); if (data.destination) setDestination(data.destination); }
  };
  useEffect(() => { void load().catch(() => undefined); if (new URLSearchParams(window.location.search).get('world') === 'failed') setNotice('World認証を確認できませんでした。再認証してください。'); }, []);
  const run = async (work: () => Promise<void>) => { setBusy(true); setNotice(''); try { await work(); } catch (error) { const code = (error as { code?: string }).code; setNotice(code === 'world_unavailable' ? 'World sandboxの接続設定が未完了です。現在は承認できません。' : '操作を完了できませんでした。期限・所有wallet・認証状態を確認して再試行してください。'); } finally { setBusy(false); } };
  const connect = () => run(async () => {
    if (!window.ethereum) throw new Error('wallet_unavailable');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || await window.ethereum.request({ method: 'eth_chainId' }) !== '0x14a34') throw new Error('wallet_network_mismatch');
    setWallet(accounts[0]); setChallenge(await api(path + '/owner-challenge', 'POST', {}));
  });
  const prove = () => run(async () => {
    if (!challenge || !window.ethereum || new Date(challenge.expiresAt).getTime() <= Date.now()) throw new Error('expired');
    const lines = challenge.message.split('\n');
    if (lines.length !== 8 || lines[0] !== `${window.location.hostname} wants you to authorize RealAddr mail owner proof` || lines[1] !== 'Purpose: mail.owner' || lines[2] !== `Approval: ${approvalId}` || lines[4] !== `Wallet: ${wallet.toLowerCase()}` || lines[5] !== 'Chain: eip155:84532' || lines[7] !== `Expires: ${challenge.expiresAt}`) throw new Error('invalid_challenge');
    const hex = '0x' + Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('');
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, wallet] });
    await api(path + '/owner-proof', 'POST', { challengeId: challenge.challengeId, signature }); setChallenge(null); await load();
  });
  const authenticate = () => run(async () => { const result = await api<{ authorizationUrl: string }>(path + '/authenticate', 'POST', {}); const target = new URL(result.authorizationUrl); if (target.origin !== 'https://sandbox.auth.world.org') throw new Error('invalid_authentication_url'); window.location.assign(target.href); });
  const decide = (decision: 'approve' | 'deny') => run(async () => { if (!approval) return; await api(path + '/decision', 'POST', { decision, actionHash: approval.actionHash }); await load(); setConfirmed(false); });
  const save = () => run(async () => { if (!approval || !profile) return; const result = await api<Profile>(`/v1/subscriptions/${approval.subscriptionId}/mail-destination`, 'PUT', { expectedVersion: profile.version, destination }); setProfile(result); setConfirmed(false); setNotice('転送先を保存しました。実際の郵便発送は行いません。'); });
  return <main className="approval-page" id="main-content"><a className="brand" href="/">RealAddr <span>for Agents</span></a><section className="login-card"><p className="eyebrow">人間専用・World sandbox / testnet</p><h1>郵便転送設定の承認</h1><p>この操作で郵便転送設定を有効にします。転送先はこの後、あなたが入力します。郵便物の受領・発送や送料の支払いは行いません。</p><p>World認証は同意や法的本人確認を意味しません。住所契約の有効期間は支払いで決まります。</p>{notice && <div role="status" className="notice warning">{notice}</div>}
  {!approval && <><p>URLだけでは契約情報を表示しません。対象owner walletの署名を確認します。</p><button disabled={busy} onClick={connect}>owner walletを接続</button></>}
  {challenge && <><pre className="challenge-preview">{challenge.message}</pre><button disabled={busy} onClick={prove}>内容を確認して署名</button></>}
  {approval && <><dl><dt>Agent</dt><dd>{approval.agentId}</dd><dt>契約</dt><dd>{approval.subscriptionId}</dd><dt>owner wallet</dt><dd>{approval.ownerWallet}</dd><dt>承認要求の期限</dt><dd>{approval.expiresAt ?? '適用済みの同一宛先への同意に期限はありません。再ログイン用のブラウザsessionは10分です。'}</dd><dt>状態</dt><dd>{approval.status}</dd></dl><button disabled={busy} onClick={authenticate}>Worldで再認証</button>{approval.status !== 'applied' && <><p><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />対象と操作内容を確認し、設定を許可します</label></p><button disabled={busy || !approval.worldAuthenticated || !confirmed} onClick={() => decide('approve')}>許可する</button><button disabled={busy || !approval.worldAuthenticated} onClick={() => decide('deny')}>拒否する</button></>}</>}
  {profile && <><h2>{profile.mail.status === 'enabled' ? '郵便転送可' : '郵便転送設定は停止中'}</h2><p>{profile.mail.destinationConfigured ? '転送先登録済み' : '転送先未登録'}</p>{profile.mail.status === 'enabled' && (!profile.mail.destinationConfigured || editing) && <form onSubmit={e => { e.preventDefault(); void save(); }}>{([['recipient','氏名'],['postalCode','郵便番号（7桁）'],['prefecture','都道府県'],['city','市区町村'],['addressLine1','番地'],['addressLine2','建物名（任意）']] as const).map(([key,label]) => <p key={key}><label>{label}<input required={key !== 'addressLine2'} value={destination[key]} onChange={e => { setDestination({ ...destination, [key]: e.target.value }); setConfirmed(false); }} /></label></p>)}<p><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />入力した転送先を確認しました</label></p><button disabled={busy || !confirmed} type="submit">転送先を保存</button></form>}{profile.mail.destinationConfigured && !editing && <button disabled={busy} onClick={() => run(async () => { if (!approval) return; const result = await api<{ approvalUrl: string }>(`/v1/subscriptions/${approval.subscriptionId}/mail-destination-approval`, 'POST', { expectedVersion: profile.version }); const target = new URL(result.approvalUrl); if (target.origin !== window.location.origin) throw new Error('invalid_approval_url'); window.location.assign(target.href); })}>転送先変更の承認を開始</button>}{profile.mail.destinationConfigured && <button disabled={busy} onClick={() => { setEditing(true); setConfirmed(false); }}>承認済みの変更先を入力</button>}{profile.destination && <address>{profile.destination.recipient}<br />{profile.destination.postalCode} {profile.destination.prefecture}{profile.destination.city}{profile.destination.addressLine1} {profile.destination.addressLine2}</address>}{profile.mail.status === 'enabled' && <button disabled={busy} onClick={() => run(async () => { if (!approval) return; setProfile(await api(`/v1/subscriptions/${approval.subscriptionId}/mail-disable`, 'POST', { expectedVersion: profile.version })); setDestination(empty); })}>設定を無効にする</button>}</>}
  <p><a href="/faq">承認と郵便機能の説明</a></p></section></main>;
}
