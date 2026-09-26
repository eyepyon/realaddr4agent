import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CURRENT_TERMS_VERSION } from '../packages/domain/src/terms.ts';

const origin = 'https://address.chain.tokyo';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const buildPaths = ['Dockerfile', '.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'apps/api/package.json', 'apps/api/tsconfig.json', 'apps/api/src', 'apps/worker/package.json', 'apps/worker/tsconfig.json', 'apps/worker/src', 'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/vite.config.ts', 'apps/web/index.html', 'apps/web/src', 'apps/web/scripts/build.mjs', 'packages/agent-cli/package.json', 'packages/db/package.json', 'packages/db/tsconfig.json', 'packages/db/src', 'packages/domain/package.json', 'packages/domain/tsconfig.json', 'packages/domain/src', 'docs/openapi.json', 'docs/terms.md', 'scripts/container-build.mjs', 'scripts/container-entrypoint.mjs'];

function demand(condition, code) {
  if (!condition) throw new Error(code);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function equal(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function parse(text) {
  try { return JSON.parse(text); } catch { throw new Error('invalid_command_metadata'); }
}
export function subprocess(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 12 * 60 * 1000, ...options });
  demand(!result.error && result.status === 0, 'subprocess_failed');
  return result.stdout ?? '';
}
export function sourceFromEnv(env = process.env) {
  operationFromEnv(env);
  demand(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main', 'deployment_not_authorized');
  demand(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && env.SELECTED_COMMIT === env.GITHUB_SHA, 'commit_must_equal_current_main');
  demand(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? ''), 'invalid_repository_context');
  return { commit: env.GITHUB_SHA, repository: env.GITHUB_REPOSITORY };
}
export function operationFromEnv(env = process.env) {
  const operation = env.SELECTED_OPERATION ?? 'deploy';
  demand(['deploy', 'image-only'].includes(operation), 'invalid_deploy_operation');
  return operation;
}
export function configFromEnv(env = process.env) {
  const source = sourceFromEnv(env);
  let config;
  try { config = JSON.parse(env.DEPLOY_CONFIG ?? ''); } catch { throw new Error('deploy_configuration_required'); }
  demand(config && typeof config === 'object' && !Array.isArray(config), 'invalid_deploy_configuration');
  const keys = ['GCP_PROJECT_ID', 'GCP_REGION', 'RESOURCE_PREFIX', 'FIRESTORE_COLLECTION_PREFIX', 'WIF_PROVIDER', 'CLOUD_RUN_WEB_SERVICE', 'CLOUD_RUN_WORKER_SERVICE', 'ARTIFACT_REPOSITORY', 'DEPLOY_SERVICE_ACCOUNT', 'TERMS_VERSION', 'WORKER_URL', 'DEPLOYMENT_APPROVED'];
  demand(Object.keys(config).length === keys.length && Object.keys(config).every(key => keys.includes(key)), 'unknown_deploy_configuration');
  for (const key of keys) demand(typeof config[key] === 'string' && config[key] !== '', 'missing_deploy_configuration');
  demand(config.DEPLOYMENT_APPROVED === 'true', 'deployment_not_authorized');
  demand(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.GCP_PROJECT_ID) && !config.GCP_PROJECT_ID.startsWith('demo-'), 'invalid_event_project');
  demand(/^[a-z]+-[a-z]+[0-9]+$/.test(config.GCP_REGION), 'invalid_event_region');
  demand(config.RESOURCE_PREFIX === 'realaddr-event' && config.FIRESTORE_COLLECTION_PREFIX === 'realaddr_event_', 'invalid_resource_prefix');
  demand(config.CLOUD_RUN_WEB_SERVICE === 'realaddr-event-web' && config.CLOUD_RUN_WORKER_SERVICE === 'realaddr-event-worker' && config.ARTIFACT_REPOSITORY === 'realaddr-event-images', 'invalid_dedicated_resources');
  demand(new RegExp(`^[a-z][a-z0-9-]{4,28}[a-z0-9]@${config.GCP_PROJECT_ID}\\.iam\\.gserviceaccount\\.com$`).test(config.DEPLOY_SERVICE_ACCOUNT), 'invalid_deploy_account');
  const wif = /^projects\/([1-9][0-9]*)\/locations\/global\/workloadIdentityPools\/realaddr-event-gh\/providers\/github$/.exec(config.WIF_PROVIDER);
  demand(wif, 'invalid_dedicated_wif');
  demand(config.TERMS_VERSION === CURRENT_TERMS_VERSION && env.SELECTED_TERMS_VERSION === CURRENT_TERMS_VERSION, 'published_terms_must_match');
  demand(/^https:\/\/[a-z0-9.-]+\.run\.app$/.test(config.WORKER_URL), 'invalid_worker_origin');
  return { ...config, projectNumber: wif[1], ...source };
}
export function verifySource(config, run = subprocess) {
  demand(run('git', ['rev-parse', 'HEAD']).trim() === config.commit, 'checkout_commit_mismatch');
  const data = parse(run('gh', ['api', `repos/${config.repository}/actions/workflows/ci.yml/runs?head_sha=${config.commit}&per_page=100`]));
  const runs = (data.workflow_runs ?? []).filter(item => item.head_sha === config.commit && item.head_branch === 'main' && item.event === 'push' && item.head_repository?.full_name === config.repository).sort((a, b) => b.id - a.id);
  demand(runs.length > 0 && runs[0].status === 'completed' && runs[0].conclusion === 'success', 'current_main_ci_not_successful');
}
function digestImage(image, config) {
  const expected = `${config.GCP_REGION}-docker.pkg.dev/${config.GCP_PROJECT_ID}/${config.ARTIFACT_REPOSITORY}/app@`;
  demand(typeof image === 'string' && image.startsWith(expected) && digestPattern.test(image.slice(expected.length)), 'image_must_be_dedicated_immutable_digest');
  return image;
}
function policyCanonical(policy) {
  return (policy.bindings ?? []).map(binding => ({ role: binding.role, members: [...(binding.members ?? [])].sort(), ...(binding.condition ? { condition: binding.condition } : {}) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function templateStable(service) {
  const spec = structuredClone(service.spec);
  delete spec.template.metadata?.name;
  spec.template.metadata.labels = { ...(spec.template.metadata?.labels ?? {}) };
  delete spec.template.metadata.labels['client.knative.dev/nonce'];
  for (const annotations of [spec.template.metadata?.annotations]) {
    if (annotations) for (const key of ['run.googleapis.com/client-name', 'run.googleapis.com/client-version', 'client.knative.dev/user-image']) delete annotations[key];
  }
  delete spec.template.spec.containers[0].image;
  const annotations = structuredClone(service.metadata.annotations ?? {});
  for (const key of ['run.googleapis.com/client-name', 'run.googleapis.com/client-version', 'run.googleapis.com/operation-id', 'run.googleapis.com/ingress-status', 'serving.knative.dev/creator', 'serving.knative.dev/lastModifier', 'run.googleapis.com/urls']) delete annotations[key];
  return { spec, annotations, labels: service.metadata.labels };
}
function validateService(service, policy, revision, role, config) {
  const name = role === 'web' ? config.CLOUD_RUN_WEB_SERVICE : config.CLOUD_RUN_WORKER_SERVICE;
  demand(service.apiVersion === 'serving.knative.dev/v1' && service.kind === 'Service' && service.metadata?.name === name && service.metadata.namespace === config.projectNumber && service.metadata.labels?.['cloud.googleapis.com/location'] === config.GCP_REGION, 'service_target_mismatch');
  const annotations = service.metadata.annotations ?? {};
  const template = service.spec?.template;
  const settings = template?.spec;
  const revisionAnnotations = template?.metadata?.annotations ?? {};
  demand(settings?.serviceAccountName === `realaddr-event-${role}@${config.GCP_PROJECT_ID}.iam.gserviceaccount.com`, 'runtime_identity_mismatch');
  const maximum = role === 'web' ? 2 : 1;
  demand(Number(annotations['run.googleapis.com/minScale'] ?? 0) === 0 && Number(annotations['run.googleapis.com/maxScale']) === maximum && Number(revisionAnnotations['autoscaling.knative.dev/minScale'] ?? 0) === 0 && Number(revisionAnnotations['autoscaling.knative.dev/maxScale']) === maximum, 'scale_limits_mismatch');
  demand(!annotations['run.googleapis.com/manualInstanceCount'] && !annotations['run.googleapis.com/invoker-iam-disabled'] && annotations['run.googleapis.com/ingress'] === 'all', 'unexpected_service_access_mode');
  demand(settings.containerConcurrency === (role === 'web' ? 20 : 1) && settings.timeoutSeconds === 60 && settings.containers?.length === 1, 'runtime_limits_mismatch');
  const container = settings.containers[0];
  demand(container.resources?.limits?.cpu === '1' && container.resources?.limits?.memory === '512Mi' && revisionAnnotations['run.googleapis.com/cpu-throttling'] !== 'false' && revisionAnnotations['run.googleapis.com/startup-cpu-boost'] === 'false', 'request_based_compute_required');
  demand(equal(container.command, ['node']) && equal(container.args, [role === 'web' ? 'apps/api/dist/index.js' : 'apps/worker/dist/index.js']), 'runtime_entrypoint_mismatch');
  const entries = container.env ?? [];
  const env = Object.fromEntries(entries.map(item => [item.name, item]));
  demand(entries.length === Object.keys(env).length, 'duplicate_runtime_environment');
  const required = { APP_ENV: 'event', NODE_ENV: 'production', RESOURCE_PREFIX: 'realaddr-event', FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_', FIRESTORE_DATABASE_ID: '(default)', GCP_PROJECT_ID: config.GCP_PROJECT_ID, GCP_REGION: config.GCP_REGION, PRICE_PROFILE: 'testnet', PAYMENT_NETWORK: 'eip155:84532', WORKER_URL: config.WORKER_URL, TASKS_QUEUE: 'realaddr-event-jobs', TASK_INVOKER_SA: `realaddr-event-tasks@${config.GCP_PROJECT_ID}.iam.gserviceaccount.com`, SCHEDULER_INVOKER_SA: `realaddr-event-sched@${config.GCP_PROJECT_ID}.iam.gserviceaccount.com` };
  for (const [key, value] of Object.entries(required)) demand(env[key]?.value === value && !env[key].valueFrom, 'runtime_environment_mismatch');
  demand(['true', 'false'].includes(env.CLOUD_TASKS_DISPATCH_ENABLED?.value), 'dispatch_configuration_unknown');
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS', 'GOOGLE_CLOUD_KEYFILE_JSON', 'GCLOUD_KEYFILE_JSON']) demand(!env[key], 'event_credential_fallback_disallowed');
  if (role === 'web') {
    demand(env.PUBLIC_ORIGIN?.value === origin && env.TERMS_VERSION?.value === config.TERMS_VERSION && env.RATE_LIMIT_HMAC_KEY?.valueFrom?.secretKeyRef && !env.RATE_LIMIT_HMAC_KEY.value, 'web_runtime_configuration_mismatch');
  }
  for (const entry of entries) if (entry.valueFrom) demand(entry.valueFrom.secretKeyRef && /^realaddr-event-[a-z0-9-]+$/.test(entry.valueFrom.secretKeyRef.name ?? '') && /^[1-9][0-9]*$/.test(entry.valueFrom.secretKeyRef.key ?? ''), 'secret_reference_must_be_dedicated_numeric_version');
  const invokers = (policy.bindings ?? []).filter(item => item.role === 'roles/run.invoker');
  const expectedInvokers = role === 'worker' ? [`serviceAccount:realaddr-event-tasks@${config.GCP_PROJECT_ID}.iam.gserviceaccount.com`, `serviceAccount:realaddr-event-sched@${config.GCP_PROJECT_ID}.iam.gserviceaccount.com`].sort() : ['allUsers'];
  demand(invokers.length === 1 && !invokers[0].condition && equal([...invokers[0].members].sort(), expectedInvokers), 'service_invoker_policy_mismatch');
  if (role === 'worker') demand(!(policy.bindings ?? []).some(item => item.members?.some(member => ['allUsers', 'allAuthenticatedUsers'].includes(member))), 'worker_must_remain_private');
  demand(service.status?.conditions?.some(item => item.type === 'Ready' && item.status === 'True') && Number(service.status.observedGeneration) === Number(service.metadata.generation), 'service_not_ready');
  const readyName = service.status.latestReadyRevisionName;
  demand(readyName && readyName === service.status.latestCreatedRevisionName && readyName === revision.metadata?.name && revision.metadata?.namespace === config.projectNumber && revision.status?.conditions?.some(item => item.type === 'Ready' && item.status === 'True'), 'ready_revision_mismatch');
  demand(service.spec.traffic?.length === 1 && service.spec.traffic[0].latestRevision === true && service.spec.traffic[0].percent === 100 && service.status.traffic?.length === 1 && service.status.traffic[0].revisionName === readyName && service.status.traffic[0].percent === 100, 'ready_revision_must_serve_all_traffic');
  const image = digestImage(container.image, config);
  demand(revision.status.imageDigest === image, 'ready_revision_digest_mismatch');
  demand(role !== 'worker' || service.status.url === config.WORKER_URL, 'worker_origin_mismatch');
  return { image, invariant: templateStable(service), policy: policyCanonical(policy) };
}
function readServices(config, run) {
  const flags = [`--project=${config.GCP_PROJECT_ID}`, `--region=${config.GCP_REGION}`, '--format=json', '--quiet'];
  const snapshots = {};
  for (const role of ['worker', 'web']) {
    const name = role === 'worker' ? config.CLOUD_RUN_WORKER_SERVICE : config.CLOUD_RUN_WEB_SERVICE;
    const service = parse(run('gcloud', ['run', 'services', 'describe', name, ...flags]));
    const policy = parse(run('gcloud', ['run', 'services', 'get-iam-policy', name, ...flags]));
    demand(service.status?.latestReadyRevisionName, 'existing_ready_service_required');
    const revision = parse(run('gcloud', ['run', 'revisions', 'describe', service.status.latestReadyRevisionName, ...flags]));
    snapshots[role] = validateService(service, policy, revision, role, config);
  }
  return snapshots;
}
function assertPreserved(before, after, image) {
  for (const role of ['worker', 'web']) demand(after[role].image === image && equal(before[role].invariant, after[role].invariant) && equal(before[role].policy, after[role].policy), 'deployment_state_not_preserved');
}
export async function smoke(config, fetcher = fetch) {
  const health = await fetcher(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  demand(health.status === 200 && (await health.json()).status === 'ok', 'public_health_failed');
  const denied = await fetcher(`${config.WORKER_URL}/tasks/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(30000) });
  demand([401, 403].includes(denied.status), 'unauthenticated_worker_not_denied');
}
export async function verifyArtifactPermissions(config, run = subprocess, fetcher = fetch) {
  const required = ['artifactregistry.repositories.get', 'artifactregistry.repositories.uploadArtifacts', 'artifactregistry.repositories.downloadArtifacts', 'artifactregistry.dockerimages.get'];
  const token = run('gcloud', ['auth', 'print-access-token', '--quiet']).trim();
  demand(token.length > 0, 'artifact_permissions_unverified');
  try {
    const response = await fetcher(`https://artifactregistry.googleapis.com/v1/projects/${config.GCP_PROJECT_ID}/locations/${config.GCP_REGION}/repositories/${config.ARTIFACT_REPOSITORY}:testIamPermissions`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: required }), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    demand(response.status === 200, 'artifact_permissions_unverified');
    const result = await response.json();
    demand(Array.isArray(result.permissions) && required.every(permission => result.permissions.includes(permission)), 'artifact_permissions_unverified');
  } catch { throw new Error('artifact_permissions_unverified'); }
}
export async function buildInitialImage(config, { run = subprocess, prepareContext, permissionCheck = verifyArtifactPermissions } = {}) {
  demand(run('git', ['rev-parse', 'HEAD']).trim() === config.commit, 'checkout_commit_mismatch');
  const active = parse(run('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=json', '--quiet']));
  demand(active.length === 1 && active[0].account === config.DEPLOY_SERVICE_ACCOUNT, 'active_deploy_identity_mismatch');
  const repository = parse(run('gcloud', ['artifacts', 'repositories', 'describe', config.ARTIFACT_REPOSITORY, `--project=${config.GCP_PROJECT_ID}`, `--location=${config.GCP_REGION}`, '--format=json', '--quiet']));
  demand(repository.name === `projects/${config.GCP_PROJECT_ID}/locations/${config.GCP_REGION}/repositories/${config.ARTIFACT_REPOSITORY}` && repository.format === 'DOCKER' && repository.mode === 'STANDARD_REPOSITORY' && repository.description === 'RealAddr event application images', 'artifact_repository_mismatch');
  await permissionCheck(config, run);
  let context;
  try {
    if (prepareContext) context = prepareContext();
    else {
      context = mkdtempSync(join(tmpdir(), 'realaddr-initial-image-'));
      run('git', ['archive', '--format=tar', `--output=${join(context, 'source.tar')}`, config.commit, ...buildPaths]);
      run('tar', ['-xf', join(context, 'source.tar'), '-C', context]);
      rmSync(join(context, 'source.tar'));
    }
    const tag = `${config.GCP_REGION}-docker.pkg.dev/${config.GCP_PROJECT_ID}/${config.ARTIFACT_REPOSITORY}/app:${config.commit}`;
    run('docker', ['build', '--build-arg', 'VITE_APP_ENV=event', '--build-arg', `VITE_TERMS_VERSION=${config.TERMS_VERSION}`, '--tag', tag, context]);
    run('gcloud', ['auth', 'configure-docker', `${config.GCP_REGION}-docker.pkg.dev`, '--quiet']);
    run('docker', ['push', tag]);
    const built = parse(run('gcloud', ['artifacts', 'docker', 'images', 'describe', tag, `--project=${config.GCP_PROJECT_ID}`, '--format=json', '--quiet']));
    const digest = built.image_summary?.digest;
    demand(digestPattern.test(digest ?? ''), 'registry_digest_required');
    const image = digestImage(`${tag.slice(0, tag.lastIndexOf(':'))}@${digest}`, config);
    return { status: 'image_created', image };
  } finally {
    if (context && !prepareContext) rmSync(context, { recursive: true, force: true });
  }
}
export async function deploy(config, { run = subprocess, smokeCheck = smoke, prepareContext } = {}) {
  demand(run('git', ['rev-parse', 'HEAD']).trim() === config.commit, 'checkout_commit_mismatch');
  const active = parse(run('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=json', '--quiet']));
  demand(active.length === 1 && active[0].account === config.DEPLOY_SERVICE_ACCOUNT, 'active_deploy_identity_mismatch');
  const before = readServices(config, run);
  demand(before.worker.image === before.web.image, 'rollback_pair_digest_mismatch');
  const repository = parse(run('gcloud', ['artifacts', 'repositories', 'describe', config.ARTIFACT_REPOSITORY, `--project=${config.GCP_PROJECT_ID}`, `--location=${config.GCP_REGION}`, '--format=json', '--quiet']));
  demand(repository.name === `projects/${config.GCP_PROJECT_ID}/locations/${config.GCP_REGION}/repositories/${config.ARTIFACT_REPOSITORY}` && repository.format === 'DOCKER', 'artifact_repository_mismatch');
  let context;
  try {
    if (prepareContext) context = prepareContext();
    else {
      context = mkdtempSync(join(tmpdir(), 'realaddr-deploy-'));
      run('git', ['archive', '--format=tar', `--output=${join(context, 'source.tar')}`, config.commit, ...buildPaths]);
      run('tar', ['-xf', join(context, 'source.tar'), '-C', context]);
      rmSync(join(context, 'source.tar'));
    }
    const tag = `${config.GCP_REGION}-docker.pkg.dev/${config.GCP_PROJECT_ID}/${config.ARTIFACT_REPOSITORY}/app:${config.commit}`;
    run('docker', ['build', '--build-arg', 'VITE_APP_ENV=event', '--build-arg', `VITE_TERMS_VERSION=${config.TERMS_VERSION}`, '--tag', tag, context]);
    run('gcloud', ['auth', 'configure-docker', `${config.GCP_REGION}-docker.pkg.dev`, '--quiet']);
    run('docker', ['push', tag]);
    const built = parse(run('gcloud', ['artifacts', 'docker', 'images', 'describe', tag, `--project=${config.GCP_PROJECT_ID}`, '--format=json', '--quiet']));
    const digest = built.image_summary?.digest;
    demand(digestPattern.test(digest ?? ''), 'registry_digest_required');
    const image = digestImage(`${tag.slice(0, tag.lastIndexOf(':'))}@${digest}`, config);
    assertPreserved(before, readServices(config, run), before.worker.image);
    const update = (role, target) => run('gcloud', ['run', 'services', 'update', role === 'worker' ? config.CLOUD_RUN_WORKER_SERVICE : config.CLOUD_RUN_WEB_SERVICE, `--image=${target}`, `--project=${config.GCP_PROJECT_ID}`, `--region=${config.GCP_REGION}`, '--format=json', '--quiet']);
    const attempted = [];
    try {
      for (const role of ['worker', 'web']) { attempted.push(role); update(role, image); }
      assertPreserved(before, readServices(config, run), image);
      await smokeCheck(config);
      return { status: 'deployed' };
    } catch {
      let rollbackFailed = false;
      for (const role of attempted.reverse()) {
        try { update(role, before[role].image); } catch { rollbackFailed = true; }
      }
      try {
        assertPreserved(before, readServices(config, run), before.worker.image);
        await smokeCheck(config);
      } catch { rollbackFailed = true; }
      throw new Error(rollbackFailed ? 'deployment_failed_rollback_unverified' : 'deployment_failed_rolled_back');
    }
  } finally {
    if (context && !prepareContext) rmSync(context, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const mode = process.argv[2];
    if (mode === 'gate') verifySource(sourceFromEnv());
    else if (mode === 'inputs') {
      const config = configFromEnv();
      demand(subprocess('git', ['rev-parse', 'HEAD']).trim() === config.commit, 'checkout_commit_mismatch');
      demand(process.env.GITHUB_OUTPUT, 'github_step_output_required');
      for (const key of ['GCP_PROJECT_ID', 'WIF_PROVIDER', 'DEPLOY_SERVICE_ACCOUNT']) {
        console.log(`::add-mask::${config[key]}`);
        appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${config[key]}\n`);
      }
    } else if (mode === 'deploy' || mode === 'execute') {
      const operation = operationFromEnv();
      const config = configFromEnv();
      if (operation === 'image-only') {
        demand(process.env.GITHUB_OUTPUT, 'github_step_output_required');
        const result = await buildInitialImage(config);
        console.log(`::add-mask::${result.image}`);
        appendFileSync(process.env.GITHUB_OUTPUT, `IMAGE_DIGEST=${result.image}\n`);
        console.log(`Image digest: ${result.image.slice(result.image.lastIndexOf('@') + 1)}`);
        console.log('Initial image created; services and IAM unchanged.');
      } else await deploy(config);
    }
    else throw new Error('invalid_deploy_mode');
    console.log('Deployment gate completed.');
  } catch (error) {
    const safe = /^[a-z_]+$/.test(error.message ?? '') ? error.message : 'deployment_check_failed';
    console.error(safe);
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
