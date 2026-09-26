import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { InterceptaClient } from '../packages/intercepta/src/index.js';

// Diagnostic only: this command never prepares a payment or requests a signature.
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length === 1 && args[0] === '--help') {
    console.log('intercepta:scan --address <EOA-address> [--json]');
    return;
  }
  const filtered = args.filter(value => value !== '--json');
  if (filtered.length !== 2 || filtered[0] !== '--address' || !/^0x[0-9a-fA-F]{40}$/.test(filtered[1]!)) {
    console.log(JSON.stringify({ error: 'invalid_scan_arguments', message: 'Use --address <EOA-address> [--json]' }));
    process.exitCode = 1;
    return;
  }
  if (existsSync('.env')) loadEnvFile('.env');
  const client = new InterceptaClient({ apiKey: process.env.INTERCEPTA_API_KEY ?? '' });
  const assessment = await client.assessAddress(filtered[1]!);
  console.log(JSON.stringify({ operation: 'address_screening_only', environment: 'testnet', ...assessment, requestsAttempted: client.requestsAttempted }));
  process.exitCode = assessment.decision === 'allow' ? 0 : assessment.decision === 'deny' ? 2 : 3;
}

main().catch(() => {
  console.log(JSON.stringify({ error: 'screening_unavailable', decision: 'hold' }));
  process.exitCode = 3;
});
