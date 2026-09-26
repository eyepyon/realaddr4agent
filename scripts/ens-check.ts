import { readFile } from 'node:fs/promises';
import { EnsV2Reader, createHttpRpc, type BindingExpectation, type NamespaceConfig } from '../packages/ens/src/index.js';

async function main(): Promise<void> {
  const configFile = process.env.ENS_CONFIG_FILE;
  const rpcUrl = process.env.ENS_RPC_URL;
  const expiry = process.env.ENS_REQUIRED_EXPIRY;
  if (!configFile || !rpcUrl || !expiry || !/^[0-9]+$/.test(expiry)) {
    console.log(JSON.stringify({ status: 'blocked', reason: 'ens_configuration_missing', environment: 'testnet', chainId: 11155111 }));
    process.exitCode = 2;
    return;
  }
  const config = JSON.parse(await readFile(configFile, 'utf8')) as NamespaceConfig;
  const reader = new EnsV2Reader(config, createHttpRpc(rpcUrl));
  const bindingFile = process.env.ENS_BINDING_FILE;
  let result;
  if (bindingFile) {
    const stored = JSON.parse(await readFile(bindingFile, 'utf8')) as Omit<BindingExpectation, 'leaseVersion' | 'expiresAt'> & { leaseVersion: string; expiresAt: string };
    if (!/^[0-9]+$/.test(stored.leaseVersion) || !/^[0-9]+$/.test(stored.expiresAt)) throw new Error('invalid_binding_configuration');
    result = await reader.verifyBinding({ ...stored, leaseVersion: BigInt(stored.leaseVersion), expiresAt: BigInt(stored.expiresAt) });
  } else result = await reader.readNamespaceReadiness(BigInt(expiry));
  console.log(JSON.stringify(result, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
  if (result.status !== 'verified') process.exitCode = 2;
}
main().catch(() => {
  console.log(JSON.stringify({ status: 'blocked', reason: 'ens_check_unavailable', environment: 'testnet', chainId: 11155111 }));
  process.exitCode = 2;
});
