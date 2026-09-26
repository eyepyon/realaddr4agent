import { createLocationFlow } from './ens-location-flow.mjs';

const locationStepNumbers = { deploy_location: 2, set_location_parent: 3, grant_location_controller: 4, register_location: 5, configure_location_namespace: 6 };
export function locationJstTime(value) {
  const date = new Date(value);
  if (typeof value !== 'string' || !Number.isFinite(date.getTime())) return '取得できません';
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date) + ' JST';
}
function locationPendingDetails(result) {
  const lines = [];
  if (result.receiptConfirmed === true) lines.push(`取引のブロック: ${result.receiptBlockNumber}（${locationJstTime(result.receiptBlockTime)}）`);
  if (result.finalizedBlockNumber) lines.push(`最終確定済みブロック: ${result.finalizedBlockNumber}（${locationJstTime(result.finalizedBlockTime)}）`);
  if (result.latestBlockNumber) lines.push(`最新ブロック: ${result.latestBlockNumber}（${locationJstTime(result.latestBlockTime)}）`);
  if (/^[0-9]+$/.test(result.latestFinalizedLagBlocks ?? '')) lines.push(`最新と最終確定の差: ${result.latestFinalizedLagBlocks}ブロック（完了予定時間ではありません）`);
  if (/^[0-9]+$/.test(result.receiptFinalizedGapBlocks ?? '')) lines.push(`取引のブロックと最終確定の差: ${result.receiptFinalizedGapBlocks}ブロック`);
  if (result.checkedAt) lines.push(`今回の確認時刻: ${locationJstTime(result.checkedAt)}`);
  if (/^0x[0-9a-fA-F]{64}$/.test(result.transactionHash ?? '')) lines.push(`取引hash: ${result.transactionHash}`);
  return lines.length ? '\n\n' + lines.join('\n') : '';
}
export function locationResultMessage(result) {
  const step = locationStepNumbers[result?.pendingAction ?? result?.action];
  if (result?.pendingAction && step && result.receiptFinalized === false) {
    const progress = result.receiptConfirmed === true ? '成功した取引がブロックに取り込まれたことを今回の照会で確認しました。チェーンの最終確定を待っています。' : result.receiptConfirmed === false ? '送信済みですが、取引の採掘結果は今回の照会ではまだ確認できません。' : '取引は送信済みです。チェーンの最終確定を待っています。';
    return `操作${step}: ${progress}${step}は再送せず、しばらくして7で確認してください。` + locationPendingDetails(result);
  }
  if (result?.action && step && typeof result.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(result.hash)) return `操作${step}の取引を送信しました。${step}は再送せず、最終確定を待って7で確認してください。\n取引hash: ${result.hash}`;
  if (result?.connected === true) return 'MetaMaskの接続先がEthereum Sepoliaで、ownerが計画と一致することを確認しました。送信履歴がある場合は7で確認してください。未送信の場合だけ2へ進んでください。';
  const resetStep = locationStepNumbers[result?.rejectedStepReset];
  if (resetStep) return `walletで拒否した操作${resetStep}を再試行可能にしました。内容を確認してから${resetStep}を押してください。取引はまだ送信していません。`;
  if (result?.locationConnected === true && result.receiptFinalized === true) return '操作2〜6の最終確定と拠点Registry・NameControllerの接続を確認しました。実際の名前解決とアプリ設定の検証は別作業で、ENS販売はまだ有効になりません。';
  if (result?.locationConnected === false && result.completedSteps > 0 && result.completedSteps < 5) return `操作${result.completedSteps + 1}までの最終確定を確認しました。次は${result.completedSteps + 2}へ進んでください。送信済み操作は再送しないでください。`;
  if (result?.completedSteps === 0) return '照合できた取引はまだありません。送信操作を始めていなければ2へ進んでください。不明な場合は再送しないでください。';
  return '状態を取得しました。最終確定の完了はまだ確認できません。送信済み操作は再送せず、7で確認してください。';
}

export function locationErrorMessage(error) {
  const code = error?.message ?? '';
  if (/unknown|do_not_resend|persistence_failed|state_persistence|revision|state_conflict/.test(code)) return '送信結果または保存状態が不明です。再送せず、保存済み取引の照合を依頼してください。';
  if (/not_finalized|receipt_pending|pending_receipt/.test(code)) return 'チェーンの最終確定を待っています。再送せず、数分後に確認ボタンを押してください。';
  if (/user_rejected/.test(code) || error?.code === 4001) return 'walletで承認されませんでした。状態を確認してから次の操作を判断してください。';
  if (/already_submitted/.test(code)) return 'この操作は送信済みです。再送せず、保存済み取引の確認を行ってください。';
  if (/mismatch|changed|unsupported_wrapper|occupied/.test(code)) return '計画とチェーンまたはwalletの情報が一致しません。送信せず、既存取引と設定の照合を依頼してください。';
  if (/wrong_chain|chain/.test(code)) return 'MetaMaskの接続先をEthereum Sepoliaへ確認してください。';
  return '処理を完了できませんでした。再送せず、保存済み状態とチェーンを確認してください。';
}
export function createLocationStateSaver({ fetcher, storage, browserKey, metadata, revision }) {
  return async next => {
    const snapshot = { state: structuredClone(next), revision: revision + 1 };
    const serialized = JSON.stringify(snapshot);
    storage.setItem(browserKey, serialized);
    if (storage.getItem(browserKey) !== serialized) throw new Error('browser_state_persistence_failed_do_not_resend');
    const response = await fetcher('/state', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ens-helper-token': metadata.token }, body: JSON.stringify({ state: snapshot.state, revision }) });
    if (!response.ok) throw new Error('state_persistence_failed_do_not_resend');
    const saved = await response.json(); if (saved.revision !== revision + 1) throw new Error('state_revision_mismatch_do_not_resend'); revision = saved.revision;
  };
}
export async function installLocationClient({ document, storage, provider, fetcher, flowFactory = createLocationFlow }) {
  const status = document.querySelector('#status'), controls = document.querySelector('#controls');
  async function read(path) { const response = await fetcher(path); if (!response.ok) throw new Error('helper_read_failed'); return response.json(); }
  const metadata = await read('/plan'), serverState = await read('/state');
  const browserKey = `ens-location-${metadata.manifestHash}-${metadata.wrapperPolicyHash}`;
  let local, invalidLocal = false;
  try { local = JSON.parse(storage.getItem(browserKey) ?? 'null'); } catch { invalidLocal = true; }
  const state = structuredClone(serverState.state);
  if (invalidLocal || (local && JSON.stringify(local) !== JSON.stringify(serverState))) state.unknown = true;
  const plan = metadata.manifest;
  document.querySelector('#details').textContent = JSON.stringify({ parentName: plan.parentName, locationSlug: plan.locationSlug, namespaceName: `${plan.locationSlug}.${plan.parentName}`, buildingKey: plan.buildingKey, location: plan.location, pins: plan.pins, expectedPostconditions: plan.expectedPostconditions, roles: 'ownerにはsetParentとController権限の管理だけを設定します。Controllerにはregister・renew・unregisterだけを付与します。拠点登録ownerの名前権限は0です。', value: '0（Sepolia gasのみ）', chain: 'Ethereum Sepolia testnet', owner: plan.owner, publisher: plan.publisher, manifestHash: metadata.manifestHash, wrapperPolicyHash: metadata.wrapperPolicyHash, namespaceReady: false }, null, 2);
  if (!provider) { status.textContent = 'MetaMaskが必要です。walletを有効にして画面を開き直してください。'; return; }
  const flow = flowFactory({ manifest: plan, provider, state, wrapperPolicy: metadata.wrapperPolicy, save: createLocationStateSaver({ fetcher, storage, browserKey, metadata, revision: serverState.revision }) });
  let busy = false;
  const availability = new WeakMap();
  const optionalButtons = new WeakSet();
  const refreshButtons = () => { for (const node of controls.querySelectorAll('button')) { const available = availability.get(node)(); node.disabled = busy || !available; node.hidden = optionalButtons.has(node) && !available; } };
  function button(label, action, available = () => true, optional = false) {
    const node = document.createElement('button'); node.textContent = label; availability.set(node, available); if (optional) optionalButtons.add(node); node.disabled = !available(); node.hidden = optional && !available();
    node.addEventListener('click', async () => {
      if (busy || !available()) return; busy = true;
      for (const b of controls.querySelectorAll('button')) b.disabled = true;
      try { const result = await action(); status.textContent = locationResultMessage(result); }
      catch (error) { status.textContent = locationErrorMessage(error); }
      finally { busy = false; refreshButtons(); }
    }); controls.append(node);
  }
  button('1. MetaMask接続・Sepoliaとowner確認', () => flow.connect().then(() => ({ connected: true, namespaceReady: false })));
  const labels = { deploy_location: '2. 拠点Registryを作成', set_location_parent: '3. 拠点Registryの親名を設定', grant_location_controller: '4. Controllerに発行・更新・取消権限を付与', register_location: '5. 上位Registryに拠点名を登録', configure_location_namespace: '6. Controllerに拠点namespaceを設定' };
  for (const [index, call] of plan.calls.entries()) {
    const previousReady = () => plan.calls.slice(0, index).every(prior => state.steps[prior.action]?.finalized === true);
    button(labels[call.action], () => flow.execute(call.action), () => !state.unknown && previousReady() && !Object.hasOwn(state.steps, call.action));
    button('拒否した操作' + (index + 2) + 'を再試行可能にする', () => flow.resetRejected(call.action), () => {
      const step = state.steps[call.action];
      return state.unknown === false && previousReady() && step?.rejected === true && !step.hash && !step.receipt && !step.confirmed && !step.finalized;
    }, true);
  }
  button('7. 送信済み取引の確定・接続を確認', () => flow.verify());
  status.textContent = state.unknown ? '不明な保存状態があります。再送禁止。保存済み取引の照合を依頼してください。' : Object.keys(state.steps).length ? '送信履歴を復元しました。送信済み操作は再送せず、確認ボタンから照合してください。' : '未送信。各送信後は最終確定を待ってから次へ進みます。確認ボタンで状況を確認できます。接続後も実際の名前解決とアプリ設定の検証が必要です。';
  return { state, flow };
}
export async function detectLocationMetaMask(window) {
  const candidates = [];
  const listener = event => { if (event.detail?.info?.rdns === 'io.metamask' && event.detail?.provider && !candidates.includes(event.detail.provider)) candidates.push(event.detail.provider); };
  window.addEventListener('eip6963:announceProvider', listener);
  window.dispatchEvent(new window.Event('eip6963:requestProvider'));
  await new Promise(done => window.setTimeout(done, 150));
  window.removeEventListener('eip6963:announceProvider', listener);
  if (candidates.length > 1) throw new Error('wallet_provider_ambiguous');
  return candidates[0] ?? (window.ethereum?.isMetaMask === true ? window.ethereum : window.ethereum?.providers?.find(provider => provider.isMetaMask === true));
}
if (typeof document !== 'undefined') {
  Promise.resolve().then(async () => installLocationClient({ document, storage: localStorage, provider: await detectLocationMetaMask(window), fetcher: fetch })).catch(error => { document.querySelector('#status').textContent = locationErrorMessage(error); });
}
