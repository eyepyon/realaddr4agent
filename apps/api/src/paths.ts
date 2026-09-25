import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function repoRoot(): string {
  const base = process.env.REALADDR_REPO_ROOT ?? process.cwd();
  for (const candidate of [base, resolve(base, '../..'), resolve(base, '../../..')]) {
    if (existsSync(resolve(candidate, 'docs/openapi.json'))) return candidate;
  }
  throw new Error('repository_assets_unavailable');
}
