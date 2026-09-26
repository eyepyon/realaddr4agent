import { createParentFlow } from './ens-parent-flow.mjs';

const status = document.querySelector('#status');
const controls = document.querySelector('#controls');
const metadata = await fetch('/plan').then(response => response.json());
const browserKey = `ens-parent-${metadata.manifestHash}`;
let local;
try { local = JSON.parse(localStorage.getItem(browserKey) ?? 'null'); } catch { local = { unknown: true, steps: {} }; }
const serverState = await fetch('/state').then(response => response.json());
const state = (local ?? serverState).state;
let revision = serverState.revision;
if (local && JSON.stringify(local) !== JSON.stringify(serverState)) state.unknown = true;
const provider = window.ethereum;
document.querySelector('#details').textContent = JSON.stringify({ parentName: metadata.manifest.parentName, chain: 'Ethereum Sepolia testnet', owner: metadata.manifest.owner, token: metadata.manifest.paymentToken, testTokenPrice: metadata.manifest.price.totalAtomic, durationSeconds: metadata.manifest.durationSeconds, manifestHash: metadata.manifestHash, namespaceReady: false }, null, 2);
if (!provider) throw new Error('MetaMask wallet required');
const flow = createParentFlow({ manifest: metadata.manifest, provider, state, wrapperPolicy: metadata.wrapperPolicy, save: async next => {
  localStorage.setItem(browserKey, JSON.stringify({ state: next, revision: revision + 1 }));
  const response = await fetch('/state', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ens-helper-token': metadata.token }, body: JSON.stringify({ state: next, revision }) });
  if (!response.ok) throw new Error('state persistence failed');
  const saved = await response.json(); if (saved.revision !== revision + 1) throw new Error('revision mismatch'); revision = saved.revision;
} });
function button(label, action) {
  const node = document.createElement('button'); node.textContent = label;
  node.addEventListener('click', async () => {
    for (const b of controls.querySelectorAll('button')) b.disabled = true;
    try { status.textContent = JSON.stringify(await action(), null, 2); }
    catch (error) {
      status.textContent = error.message==='registration_not_finalized' ? '登録取引は確認できました。チェーンの最終確定を待っています。再送せず、数分後に最後の確認ボタンを押してください。'
        : error.message==='transaction_mismatch' || error.message.startsWith('unsupported_wrapper_') ? '送信済み取引の形式を照合できません。再送せず、既存取引の確認を依頼してください。' : error.message;
    }
    finally { for (const b of controls.querySelectorAll('button')) b.disabled = false; }
  });
  controls.append(node);
}
button('1. MetaMask接続・Sepolia確認', () => flow.connect().then(() => ({ connected: true })));
for (const step of metadata.manifest.steps) {
  const names = { test_token_mint: 'テストtoken不足分をmint', reset_token_allowance: '既存allowanceを0へ', approve_exact_token_amount: '必要額だけapprove', commit_parent: '親名commit', wait_commitment_age: 'commit待機を確認', register_parent: '親名register' };
  button(names[step.action], () => flow.execute(step.action));
  if (step.transaction) button(`${names[step.action]} receipt確認`, () => flow.check(step.action));
}
button('registerのfinality確認', () => flow.finalize());
const submitted=Object.entries(state.steps).filter(([,step])=>step.hash || step.started);
status.textContent = state.unknown ? '不明結果があるため再送禁止。履歴を照合してください。' : submitted.length ? `送信履歴を復元しました。${submitted.map(([action,step])=>`${action}: ${step.confirmed?'確認済み':'receipt確認待ち'}`).join(' / ')}。送信済みの操作は再送せず、receipt確認ボタンから再開してください。` : '未送信。各操作は人間のwallet承認が必要です。親名取得後も上位・拠点接続は別作業です。';
