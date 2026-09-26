import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const environment = process.env.VITE_APP_ENV;
const terms = process.env.VITE_TERMS_VERSION;
if (!['local', 'event'].includes(environment) || !terms || terms.length > 64) {
  throw new Error('container_build_requires_explicit_environment_and_terms_version');
}
const root = process.cwd();
function run(script, args, cwd = root) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd, stdio: 'inherit', env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const workspace of ['packages/domain', 'packages/db', 'apps/api', 'apps/worker', 'apps/web']) {
  run('node_modules/typescript/bin/tsc', ['--project', `${workspace}/tsconfig.json`]);
}
run('node_modules/esbuild/bin/esbuild', ['apps/api/src/index.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22', '--external:fastify', '--external:@google-cloud/firestore', '--external:viem', '--outfile=apps/api/dist/index.js']);
run('node_modules/esbuild/bin/esbuild', ['apps/worker/src/index.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22', '--external:fastify', '--external:google-auth-library', '--external:@google-cloud/firestore', '--outfile=apps/worker/dist/index.js']);
run('apps/web/scripts/build.mjs', [], resolve(root, 'apps/web'));
