export const CHAIN = '0xaa36a7';
const validHash = value => /^0x[0-9a-f]{64}$/i.test(value ?? '');
export async function validateWallet(provider, wallet) {
  const chain = await provider.request({ method: 'eth_chainId' });
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (chain.toLowerCase() !== CHAIN || accounts[0]?.toLowerCase() !== wallet.toLowerCase()) throw new Error('Sepoliaと指定walletを確認してください。');
}
export function transaction(config, gas) {
  if (!/^0x[0-9a-f]+$/i.test(config.data) || !/^0x[0-9a-f]{40}$/i.test(config.wallet)) throw new Error('Invalid configuration');
  return { from: config.wallet, chainId: CHAIN, data: config.data, value: '0x0', ...(gas ? { gas } : {}) };
}
export function createController(provider, config, storage) {
  const key = `realaddr-registry-deploy:${config.wallet.toLowerCase()}:${config.creationHash}`;
  let busy = false;
  const read = () => JSON.parse(storage.getItem(key) ?? 'null');
  const save = value => {
    const encoded = JSON.stringify(value);
    storage.setItem(key, encoded);
    if (storage.getItem(key) !== encoded) throw new Error('試行状態を保存できません。送信を停止しました。');
  };
  return {
    read,
    async estimate() {
      await validateWallet(provider, config.wallet);
      const raw = await provider.request({ method: 'eth_estimateGas', params: [transaction(config)] });
      const estimate = BigInt(raw);
      if (estimate <= 0n || estimate > 10000000n) throw new Error('Gas estimate outside limit');
      return { estimate: raw, gas: `0x${((estimate * 120n + 99n) / 100n).toString(16)}` };
    },
    async send(gas) {
      if (busy || read()?.status && read().status !== 'rejected') throw new Error('既存の試行を確認してください。再送信は禁止されています。');
      busy = true;
      try {
        await validateWallet(provider, config.wallet);
        save({ status: 'pending_unknown', startedAt: new Date().toISOString() });
        if (config.begin) await config.begin();
        let hash;
        try { hash = await provider.request({ method: 'eth_sendTransaction', params: [transaction(config, gas)] }); }
        catch (error) { if (error.code === 4001) { if (config.reject) await config.reject(); save({ status: 'rejected' }); } throw error; }
        if (!validHash(hash)) throw new Error('送信結果不明。walletで確認してください。');
        try { save({ status: 'pending', transactionHash: hash }); }
        catch { throw new Error(`Hash: ${hash}。保存失敗。再送信せずwalletで確認してください。`); }
        return read();
      } finally { busy = false; }
    },
    async receipt() {
      await validateWallet(provider, config.wallet);
      const attempt = read() ?? config.attempt;
      if (!validHash(attempt?.transactionHash)) throw new Error('Hash不明。walletで手動確認してください。');
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [attempt.transactionHash] });
      if (!receipt) return attempt;
      const tx = await provider.request({ method: 'eth_getTransactionByHash', params: [attempt.transactionHash] });
      if (!tx || tx.from?.toLowerCase() !== config.wallet.toLowerCase() || tx.to != null || tx.input?.toLowerCase() !== config.data.toLowerCase() || BigInt(tx.value ?? '-1') !== 0n || BigInt(tx.chainId ?? '-1') !== 11155111n) throw new Error('Transaction不一致。未検証です。');
      if (receipt.transactionHash?.toLowerCase() !== attempt.transactionHash.toLowerCase() || !/^0x[0-9a-f]{40}$/i.test(receipt.contractAddress ?? '') || receipt.status !== '0x1') throw new Error('Receipt失敗または不一致。再送信しないでください。');
      const code = await provider.request({ method: 'eth_getCode', params: [receipt.contractAddress, 'latest'] });
      if (code.toLowerCase() !== config.runtime.toLowerCase()) throw new Error('Runtime不一致。未検証です。');
      const result = { status: 'verified', transactionHash: attempt.transactionHash, contractAddress: receipt.contractAddress, blockNumber: receipt.blockNumber };
      save(result);
      return result;
    },
  };
}

if (typeof document !== 'undefined') {
  const output = document.querySelector('#status');
  const config = await fetch('/config').then(response => response.json());
  const attempt = async action => {
    const response = await fetch('/attempt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': config.token }, body: JSON.stringify({ action }) });
    if (!response.ok) throw new Error('既存の試行または保存失敗。再送信せず手動確認してください。');
  };
  config.begin = () => attempt('begin');
  config.reject = () => attempt('rejected');
  document.querySelector('#details').textContent = JSON.stringify({ chain: 'Ethereum Sepolia (testnet)', wallet: config.wallet, admin: config.wallet, writer: config.wallet, value: '0 ETH', creationSHA256: config.creationHash, runtimeSHA256: config.runtimeHash, status: 'registered_library_only' }, null, 2);
  let provider, controller, gas;
  const discovered = [];
  window.addEventListener('eip6963:announceProvider', event => {
    if (event.detail?.info?.rdns === 'io.metamask') discovered.push(event.detail.provider);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const action = (id, fn) => document.querySelector(id).addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await fn(); } catch (error) { output.textContent = error.message ?? '不明な結果。walletで確認してください。'; }
    finally { button.disabled = false; }
  });
  action('#connect', async () => {
    provider = discovered[0] ?? window.ethereum?.providers?.find(item => item.isMetaMask && !item.isRabby) ?? (window.ethereum?.isMetaMask && !window.ethereum?.isRabby ? window.ethereum : undefined);
    if (!provider) throw new Error('MetaMaskが見つかりません。');
    await provider.request({ method: 'eth_requestAccounts' });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN }] });
    await validateWallet(provider, config.wallet);
    controller = createController(provider, config, localStorage);
    output.textContent = JSON.stringify(controller.read() ?? config.attempt ?? { status: 'registered_library_only' });
  });
  action('#estimate', async () => {
    if (!controller) throw new Error('先に接続してください。');
    const result = await controller.estimate(); gas = result.gas;
    output.textContent = `見積gas: ${BigInt(result.estimate)} / 上限指定gas: ${BigInt(gas)}。手数料はMetaMaskで確認してください。`;
  });
  const publish = async result => {
    const response = await fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': config.token }, body: JSON.stringify(result) });
    if (!response.ok) throw new Error('ローカル結果保存失敗。walletと画面のhashを保持してください。');
    output.textContent = JSON.stringify(result, null, 2);
  };
  action('#send', async () => { if (!controller || !gas) throw new Error('接続・見積を先に実行してください。'); await publish(await controller.send(gas)); });
  action('#receipt', async () => { if (!controller) throw new Error('先に接続してください。'); await publish(await controller.receipt()); });
}
