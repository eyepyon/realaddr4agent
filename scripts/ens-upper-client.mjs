import { createUpperFlow } from './ens-upper-flow.mjs';

export function upperErrorMessage(error) {
  const code = error?.message ?? '';
  if (/unknown|do_not_resend|persistence_failed|state_persistence|revision|state_conflict/.test(code)) return '送信結果または保存状態が不明です。再送せず、保存済み取引の照合を依頼してください。';
  if (/not_finalized|receipt_pending|pending_receipt/.test(code)) return 'チェーンの最終確定を待っています。再送せず、数分後に確認ボタンを押してください。';
  if (/user_rejected/.test(code) || error?.code === 4001) return 'walletで承認されませんでした。状態を確認してから次の操作を判断してください。';
  if (/already_submitted/.test(code)) return 'この操作は送信済みです。再送せず、保存済み取引の確認を行ってください。';
  if (/mismatch|changed|unsupported_wrapper|occupied/.test(code)) return '計画とチェーンまたはwalletの情報が一致しません。送信せず、既存取引と設定の照合を依頼してください。';
  if (/wrong_chain|chain/.test(code)) return 'MetaMaskの接続先をEthereum Sepoliaへ確認してください。';
  return '処理を完了できませんでした。再送せず、保存済み状態とチェーンを確認してください。';
}
export function createUpperStateSaver({ fetcher, storage, browserKey, metadata, revision }) {
  return async next => {
    const snapshot = { state: structuredClone(next), revision: revision + 1 };
    storage.setItem(browserKey, JSON.stringify(snapshot));
    const response = await fetcher('/state', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ens-helper-token': metadata.token }, body: JSON.stringify({ state: snapshot.state, revision }) });
    if (!response.ok) throw new Error('state_persistence_failed_do_not_resend');
    const saved = await response.json(); if (saved.revision !== revision + 1) throw new Error('state_revision_mismatch_do_not_resend'); revision = saved.revision;
  };
}
export async function installUpperClient({ document, storage, provider, fetcher, flowFactory = createUpperFlow }) {
  const status = document.querySelector('#status'), controls = document.querySelector('#controls');
  async function read(path) { const response = await fetcher(path); if (!response.ok) throw new Error('helper_read_failed'); return response.json(); }
  const metadata = await read('/plan'), serverState = await read('/state');
  const browserKey = `ens-upper-${metadata.manifestHash}-${metadata.wrapperPolicyHash}`;
  let local, invalidLocal = false;
  try { local = JSON.parse(storage.getItem(browserKey) ?? 'null'); } catch { invalidLocal = true; }
  const state = structuredClone(serverState.state);
  if (invalidLocal || (local && JSON.stringify(local) !== JSON.stringify(serverState))) state.unknown = true;
  const plan = metadata.manifest;
  document.querySelector('#details').textContent = JSON.stringify({ parentName: plan.parentName, upperRegistry: plan.upper.address, chain: 'Ethereum Sepolia testnet', owner: plan.owner, manifestHash: metadata.manifestHash, wrapperPolicyHash: metadata.wrapperPolicyHash, namespaceReady: false }, null, 2);
  if (!provider) { status.textContent = 'MetaMaskが必要です。walletを有効にして画面を開き直してください。'; return; }
  const flow = flowFactory({ manifest: plan, provider, state, wrapperPolicy: metadata.wrapperPolicy, save: createUpperStateSaver({ fetcher, storage, browserKey, metadata, revision: serverState.revision }) });
  let busy = false;
  const availability = new WeakMap();
  const optionalButtons = new WeakSet();
  const refreshButtons = () => { for (const node of controls.querySelectorAll('button')) { const available = availability.get(node)(); node.disabled = busy || !available; node.hidden = optionalButtons.has(node) && !available; } };
  function button(label, action, available = () => true, optional = false) {
    const node = document.createElement('button'); node.textContent = label; availability.set(node, available); if (optional) optionalButtons.add(node); node.disabled = !available(); node.hidden = optional && !available();
    node.addEventListener('click', async () => {
      if (busy || !available()) return; busy = true;
      for (const b of controls.querySelectorAll('button')) b.disabled = true;
      try { const result = await action(); status.textContent = JSON.stringify(result, null, 2); }
      catch (error) { status.textContent = upperErrorMessage(error); }
      finally { busy = false; refreshButtons(); }
    }); controls.append(node);
  }
  button('1. MetaMask接続・Sepoliaとowner確認', () => flow.connect().then(() => ({ connected: true, namespaceReady: false })));
  const names = { deploy_upper: '2. サブネーム用の登録先を作成', set_upper_parent: '3. 登録先に親名を設定', attach_upper: '4. 親名と登録先を接続' };
  for (const call of plan.calls) {
    button(names[call.action], () => flow.execute(call.action));
    button(`拒否した操作${plan.calls.indexOf(call) + 2}を再試行可能にする`, () => flow.resetRejected(call.action), () => state.unknown === false && state.steps[call.action]?.rejected === true && !state.steps[call.action]?.hash, true);
  }
  button('5. 送信済み取引の確定・接続を確認', () => flow.verify());
  status.textContent = state.unknown ? '不明な保存状態があります。再送禁止。保存済み取引の照合を依頼してください。' : Object.keys(state.steps).length ? '送信履歴を復元しました。送信済み操作は再送せず、確認ボタンから照合してください。' : '未送信。各送信後は最終確定を待ってから次へ進みます。確認ボタンで状況を確認できます。上位接続後も拠点namespaceの構築は別作業です。';
  return { state, flow };
}
if (typeof document !== 'undefined') {
  installUpperClient({ document, storage: localStorage, provider: window.ethereum, fetcher: fetch }).catch(error => { document.querySelector('#status').textContent = upperErrorMessage(error); });
}
