import assert from 'node:assert/strict';
import test from 'node:test';
import { CURRENT_TERMS_VERSION } from '../packages/domain/src/terms.ts';
import { buildInitialImage, configFromEnv, deploy, diagnoseOidc, oidcClaimSummary, operationFromEnv, smoke, sourceFromEnv, verifyArtifactPermissions, verifySource } from './deploy-event.mjs';

const commit = 'a'.repeat(40);
const previousDigest = `sha256:${'b'.repeat(64)}`;
const nextDigest = `sha256:${'c'.repeat(64)}`;
const metadata = {
  GCP_PROJECT_ID: 'test-realaddr-local', GCP_REGION: 'us-central1',
  RESOURCE_PREFIX: 'realaddr-event', FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_',
  WIF_PROVIDER: 'projects/123456789012/locations/global/workloadIdentityPools/realaddr-event-gh/providers/github',
  CLOUD_RUN_WEB_SERVICE: 'realaddr-event-web', CLOUD_RUN_WORKER_SERVICE: 'realaddr-event-worker',
  ARTIFACT_REPOSITORY: 'realaddr-event-images', DEPLOY_SERVICE_ACCOUNT: 'realaddr-event-deploy@test-realaddr-local.iam.gserviceaccount.com',
  TERMS_VERSION: CURRENT_TERMS_VERSION, WORKER_URL: 'https://worker-fixture.run.app', DEPLOYMENT_APPROVED: 'true',
};
const sourceEnv = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit, SELECTED_COMMIT: commit, GITHUB_REPOSITORY: 'fixture-owner/fixture-repository' };
const environment = { ...sourceEnv, SELECTED_TERMS_VERSION: metadata.TERMS_VERSION, DEPLOY_CONFIG: JSON.stringify(metadata) };
const config = configFromEnv(environment);
const image = digest => `${metadata.GCP_REGION}-docker.pkg.dev/${metadata.GCP_PROJECT_ID}/${metadata.ARTIFACT_REPOSITORY}/app@${digest}`;
const serviceName = role => `realaddr-event-${role}`;
const account = role => `realaddr-event-${role}@${metadata.GCP_PROJECT_ID}.iam.gserviceaccount.com`;

function fixture(role, currentImage) {
  const name = serviceName(role);
  const requiredEnv = {
    APP_ENV: 'event', NODE_ENV: 'production', RESOURCE_PREFIX: 'realaddr-event', FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_', FIRESTORE_DATABASE_ID: '(default)',
    GCP_PROJECT_ID: metadata.GCP_PROJECT_ID, GCP_REGION: metadata.GCP_REGION, PRICE_PROFILE: 'testnet', PAYMENT_NETWORK: 'eip155:84532',
    WORKER_URL: metadata.WORKER_URL, TASKS_QUEUE: 'realaddr-event-jobs', TASK_INVOKER_SA: account('tasks'), SCHEDULER_INVOKER_SA: account('sched'), CLOUD_TASKS_DISPATCH_ENABLED: 'false',
    ...(role === 'web' ? { PUBLIC_ORIGIN: 'https://address.chain.tokyo', TERMS_VERSION: metadata.TERMS_VERSION } : {}),
  };
  const env = Object.entries(requiredEnv).map(([key, value]) => ({ name: key, value }));
  if (role === 'web') env.push({ name: 'RATE_LIMIT_HMAC_KEY', valueFrom: { secretKeyRef: { name: 'realaddr-event-rate-limit-hmac', key: '1' } } });
  return {
    apiVersion: 'serving.knative.dev/v1', kind: 'Service',
    metadata: { name, namespace: config.projectNumber, generation: 1, labels: { 'cloud.googleapis.com/location': metadata.GCP_REGION }, annotations: { 'run.googleapis.com/ingress': 'all', 'run.googleapis.com/maxScale': role === 'web' ? '2' : '1' } },
    spec: {
      template: { metadata: { name: `${name}-fixture`, labels: { 'client.knative.dev/nonce': 'before-update', purpose: 'fixture' }, annotations: { 'autoscaling.knative.dev/maxScale': role === 'web' ? '2' : '1', 'run.googleapis.com/cpu-throttling': 'true', 'run.googleapis.com/startup-cpu-boost': 'false' } },
        spec: { serviceAccountName: account(role), containerConcurrency: role === 'web' ? 20 : 1, timeoutSeconds: 60, containers: [{ image: currentImage, command: ['node'], args: [role === 'web' ? 'apps/api/dist/index.js' : 'apps/worker/dist/index.js'], resources: { limits: { cpu: '1', memory: '512Mi' } }, env }] } },
      traffic: [{ latestRevision: true, percent: 100 }],
    },
    status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True' }], latestReadyRevisionName: `${name}-fixture`, latestCreatedRevisionName: `${name}-fixture`, traffic: [{ revisionName: `${name}-fixture`, percent: 100 }], url: role === 'worker' ? metadata.WORKER_URL : 'https://web-fixture.run.app' },
  };
}
function fakeSubprocess(failure, changeBefore, policies = {}) {
  const services = { worker: fixture('worker', image(previousDigest)), web: fixture('web', image(previousDigest)) };
  changeBefore?.(services);
  const calls = [];
  const updates = [];
  let failureUsed = false;
  const run = (program, args) => {
    calls.push({ program, args });
    if (program === 'git') return `${commit}\n`;
    if (program === 'docker' || args[0] === 'auth' && args[1] === 'configure-docker') return '';
    if (args[0] === 'auth') return JSON.stringify([{ account: metadata.DEPLOY_SERVICE_ACCOUNT }]);
    if (args[0] === 'artifacts' && args[1] === 'repositories') return JSON.stringify({ name: `projects/${metadata.GCP_PROJECT_ID}/locations/${metadata.GCP_REGION}/repositories/${metadata.ARTIFACT_REPOSITORY}`, format: 'DOCKER' });
    if (args[0] === 'artifacts') return JSON.stringify({ image_summary: { digest: nextDigest } });
    const role = args[3]?.startsWith('realaddr-event-worker') ? 'worker' : 'web';
    const service = services[role];
    if (args[1] === 'services' && args[2] === 'describe') return JSON.stringify(service);
    if (args[2] === 'get-iam-policy') return JSON.stringify(policies[role] ?? { bindings: [{ role: 'roles/run.invoker', members: role === 'worker' ? [`serviceAccount:${account('tasks')}`, `serviceAccount:${account('sched')}`] : ['allUsers'] }] });
    if (args[1] === 'revisions') return JSON.stringify({ metadata: { name: service.status.latestReadyRevisionName, namespace: config.projectNumber }, status: { imageDigest: service.spec.template.spec.containers[0].image, conditions: [{ type: 'Ready', status: 'True' }] } });
    if (args[2] === 'update') {
      const target = args.find(value => value.startsWith('--image=')).slice('--image='.length);
      updates.push({ role, image: target, args });
      if (failure === 'rollback' && target === image(previousDigest) && role === 'worker') throw new Error('hidden_provider_response');
      service.spec.template.spec.containers[0].image = target;
      service.spec.template.metadata.labels['client.knative.dev/nonce'] = `update-${updates.length}`;
      delete service.spec.template.metadata.name;
      service.metadata.generation += 1;
      service.status.observedGeneration = service.metadata.generation;
      service.status.latestReadyRevisionName = `${serviceName(role)}-fixture-${updates.length}`;
      service.status.latestCreatedRevisionName = service.status.latestReadyRevisionName;
      service.status.traffic[0].revisionName = service.status.latestReadyRevisionName;
      if (!failureUsed && (failure === role || failure === 'rollback' && role === 'web')) { failureUsed = true; throw new Error('hidden_uncertain_provider_response'); }
      return '';
    }
    throw new Error('unexpected_fixture_command');
  };
  return { run, calls, updates, services };
}
const dependencies = fake => ({ run: fake.run, prepareContext: () => 'fixture-build-context', smokeCheck: async () => {} });

test('missing configuration, wrong main SHA, unapproved deployment and mismatched terms fail before subprocesses', () => {
  assert.throws(() => configFromEnv({ ...environment, DEPLOY_CONFIG: '' }), /deploy_configuration_required/);
  assert.throws(() => configFromEnv({ ...environment, SELECTED_COMMIT: 'd'.repeat(40) }), /commit_must_equal_current_main/);
  assert.throws(() => configFromEnv({ ...environment, GITHUB_REF: 'refs/heads/other' }), /deployment_not_authorized/);
  assert.throws(() => configFromEnv({ ...environment, SELECTED_TERMS_VERSION: 'different-version' }), /published_terms_must_match/);
  for (const terms of ['event-demo-1', 'realaddr-event-draft-1', 'unapproved-version']) {
    assert.throws(() => configFromEnv({ ...environment, SELECTED_TERMS_VERSION: terms, DEPLOY_CONFIG: JSON.stringify({ ...metadata, TERMS_VERSION: terms }) }), /published_terms_must_match/);
  }
  assert.throws(() => configFromEnv({ ...environment, DEPLOY_CONFIG: JSON.stringify({ ...metadata, DEPLOYMENT_APPROVED: 'false' }) }), /deployment_not_authorized/);
});
test('CI gate uses exact current main SHA and rejects failed latest completed run', () => {
  const success = { id: 1, head_sha: commit, head_branch: 'main', event: 'push', head_repository: { full_name: sourceEnv.GITHUB_REPOSITORY }, status: 'completed', conclusion: 'success' };
  const run = (program, args) => program === 'git' ? commit : JSON.stringify({ workflow_runs: [success] });
  verifySource(sourceFromEnv(sourceEnv), run);
  assert.throws(() => verifySource(sourceFromEnv(sourceEnv), (program, args) => program === 'git' ? commit : JSON.stringify({ workflow_runs: [success, { ...success, id: 2, conclusion: 'failure' }] })), /current_main_ci_not_successful/);
  assert.throws(() => verifySource(sourceFromEnv(sourceEnv), (program, args) => program === 'git' ? commit : JSON.stringify({ workflow_runs: [] })), /current_main_ci_not_successful/);
  assert.throws(() => verifySource(sourceFromEnv(sourceEnv), (program, args) => program === 'git' ? commit : JSON.stringify({ workflow_runs: [success, { ...success, id: 2, status: 'in_progress', conclusion: null }] })), /current_main_ci_not_successful/);
});
test('missing service and changed runtime settings refuse before build, push or update', async () => {
  for (const scenario of ['missing', 'configuration']) {
    const fake = fakeSubprocess(null, services => {
      if (scenario === 'configuration') services.worker.spec.template.spec.serviceAccountName = account('web');
    });
    const run = (program, args) => {
      if (scenario === 'missing' && program === 'gcloud' && args[1] === 'services' && args[2] === 'describe') throw new Error('hidden_not_found_response');
      return fake.run(program, args);
    };
    await assert.rejects(deploy(config, { ...dependencies(fake), run }));
    assert.equal(fake.calls.some(item => item.program === 'docker'), false);
    assert.equal(fake.updates.length, 0);
  }
});
test('preflight rejects a mismatched rollback pair before image build or update', async () => {
  const fake = fakeSubprocess(null, services => { services.web.spec.template.spec.containers[0].image = image(nextDigest); });
  await assert.rejects(deploy(config, dependencies(fake)), /rollback_pair_digest_mismatch/);
  assert.equal(fake.calls.some(item => item.program === 'docker'), false);
  assert.equal(fake.updates.length, 0);
});
test('success builds event image and updates worker then web with only immutable image', async () => {
  const fake = fakeSubprocess();
  assert.deepEqual(await deploy(config, dependencies(fake)), { status: 'deployed' });
  assert.deepEqual(fake.updates.map(item => [item.role, item.image]), [['worker', image(nextDigest)], ['web', image(nextDigest)]]);
  for (const update of fake.updates) assert.deepEqual(update.args.slice(4), [`--image=${image(nextDigest)}`, `--project=${metadata.GCP_PROJECT_ID}`, `--region=${metadata.GCP_REGION}`, '--format=json', '--quiet']);
  const build = fake.calls.find(item => item.program === 'docker' && item.args[0] === 'build');
  assert.ok(build.args.includes('VITE_APP_ENV=event'));
  assert.ok(build.args.includes(`VITE_TERMS_VERSION=${metadata.TERMS_VERSION}`));
});
test('uncertain worker failure restores attempted worker and verifies unchanged web', async () => {
  const fake = fakeSubprocess('worker');
  await assert.rejects(deploy(config, dependencies(fake)), /deployment_failed_rolled_back/);
  assert.deepEqual(fake.updates.map(item => [item.role, item.image]), [['worker', image(nextDigest)], ['worker', image(previousDigest)]]);
});
test('uncertain web failure restores both services in reverse order', async () => {
  const fake = fakeSubprocess('web');
  await assert.rejects(deploy(config, dependencies(fake)), /deployment_failed_rolled_back/);
  assert.deepEqual(fake.updates.map(item => [item.role, item.image]), [['worker', image(nextDigest)], ['web', image(nextDigest)], ['web', image(previousDigest)], ['worker', image(previousDigest)]]);
});
test('rollback failure remains a failure with no provider metadata disclosure', async () => {
  const fake = fakeSubprocess('rollback');
  await assert.rejects(deploy(config, dependencies(fake)), { message: 'deployment_failed_rollback_unverified' });
});
test('environment or IAM drift stays fail closed despite regenerated nonce and revision names', async () => {
  for (const scenario of ['environment', 'iam', 'user-label']) {
    const fake = fakeSubprocess();
    const run = (program, args) => {
      const result = fake.run(program, args);
      if (program === 'gcloud' && args[2] === 'update') {
        if (scenario === 'environment' && fake.updates.length === 1) fake.services.worker.spec.template.spec.containers[0].env.push({ name: 'UNEXPECTED_FLAG', value: 'changed' });
        if (scenario === 'user-label') fake.services.worker.spec.template.metadata.labels.purpose = 'changed';
      }
      if (scenario === 'iam' && fake.updates.length > 0 && program === 'gcloud' && args[2] === 'get-iam-policy') {
        const policy = JSON.parse(result);
        policy.bindings.push({ role: 'roles/run.viewer', members: [`serviceAccount:${account('web')}`] });
        return JSON.stringify(policy);
      }
      return result;
    };
    await assert.rejects(deploy(config, { ...dependencies(fake), run }), { message: 'deployment_failed_rollback_unverified' });
    assert.ok(fake.updates.some(item => item.image === image(previousDigest)));
  }
});
test('smoke checks public health and unauthenticated worker denial without returning body', async () => {
  const calls = [];
  await smoke(config, async (url, options) => { calls.push({ url, options }); return url.endsWith('/health') ? { status: 200, json: async () => ({ status: 'ok' }) } : { status: 403 }; });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  await assert.rejects(smoke(config, async url => url.endsWith('/health') ? { status: 200, json: async () => ({ status: 'ok' }) } : { status: 200 }), /unauthenticated_worker_not_denied/);
});

test('operation defaults to deploy and invalid operation fails before configuration', () => {
  assert.equal(operationFromEnv({}), 'deploy');
  assert.equal(operationFromEnv({ SELECTED_OPERATION: 'image-only' }), 'image-only');
  assert.throws(() => configFromEnv({ ...environment, SELECTED_OPERATION: 'create-services', DEPLOY_CONFIG: '' }), /invalid_deploy_operation/);
});

function initialFixture({ repository = {}, permissionsDenied = false } = {}) {
  const calls = [];
  const run = (program, args) => {
    calls.push({ program, args });
    if (program === 'git') return commit;
    if (program === 'docker') return '';
    if (args[0] === 'auth' && args[1] === 'configure-docker') return '';
    if (args[0] === 'auth') return JSON.stringify([{ account: metadata.DEPLOY_SERVICE_ACCOUNT }]);
    if (args[0] === 'artifacts' && args[1] === 'repositories') return JSON.stringify({ name: `projects/${metadata.GCP_PROJECT_ID}/locations/${metadata.GCP_REGION}/repositories/${metadata.ARTIFACT_REPOSITORY}`, format: 'DOCKER', mode: 'STANDARD_REPOSITORY', description: 'RealAddr event application images', ...repository });
    if (args[0] === 'artifacts') return JSON.stringify({ image_summary: { digest: nextDigest } });
    throw new Error('unexpected_initial_fixture_command');
  };
  return { calls, dependencies: { run, prepareContext: () => 'fixture-build-context', permissionCheck: async () => { if (permissionsDenied) throw new Error('artifact_permissions_unverified'); } } };
}
test('image-only builds and pushes a digest without creating services or changing IAM', async () => {
  const fake = initialFixture();
  assert.deepEqual(await buildInitialImage(config, fake.dependencies), { status: 'image_created', image: image(nextDigest) });
  assert.deepEqual(fake.calls.filter(call => call.program === 'docker').map(call => call.args[0]), ['build', 'push']);
  assert.equal(fake.calls.some(call => call.args[0] === 'run'), false);
  assert.ok(fake.calls.every(call => !call.args.some(arg => /iam|update|create|delete/.test(arg))));
});
test('image-only rejects mismatched repository metadata or missing permissions before build', async () => {
  for (const options of [{ repository: { format: 'MAVEN' } }, { repository: { mode: 'REMOTE_REPOSITORY' } }, { repository: { description: 'unreviewed fixture owner' } }, { repository: { name: 'projects/fixture/locations/elsewhere/repositories/realaddr-event-images' } }, { permissionsDenied: true }]) {
    const fake = initialFixture(options);
    await assert.rejects(buildInitialImage(config, fake.dependencies), /artifact_repository_mismatch|artifact_permissions_unverified/);
    assert.equal(fake.calls.some(call => call.program === 'docker'), false);
  }
});
test('repository permission probe requires the full permission set and hides provider failures', async () => {
  const run = () => 'fixture-ephemeral-token';
  await verifyArtifactPermissions(config, run, async (_url, options) => ({ status: 200, json: async () => JSON.parse(options.body) }));
  await assert.rejects(verifyArtifactPermissions(config, run, async () => ({ status: 200, json: async () => ({ permissions: [] }) })), /artifact_permissions_unverified/);
  await assert.rejects(verifyArtifactPermissions(config, run, async () => { throw new Error('private-provider-fixture'); }), { message: 'artifact_permissions_unverified' });
});

test('OIDC summary checks immutable subject and exposes only safe structure and booleans', async () => {
  const env = { GITHUB_REPOSITORY: 'fixture-owner/fixture-repo', GITHUB_REPOSITORY_ID: '123', GITHUB_REPOSITORY_OWNER_ID: '456', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.invalid/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-request-token' };
  const claims = { repository: env.GITHUB_REPOSITORY, ref: 'refs/heads/main', ref_type: 'branch', sub: 'repo:fixture-owner@456/fixture-repo@123:environment:event', workflow_ref: `${env.GITHUB_REPOSITORY}/.github/workflows/deploy-event.yml@refs/heads/main`, event_name: 'workflow_dispatch', repository_id: '123', repository_owner_id: '456' };
  const summary = oidcClaimSummary(claims, env);
  assert.ok(Object.values(summary.matches).every(Boolean));
  assert.deepEqual(summary.missingClaims, []);
  assert.equal(summary.legacySubjectMatches, false);
  assert.equal(JSON.stringify(summary).includes('fixture-owner'), false);
  assert.equal(oidcClaimSummary({ ...claims, sub: 'private-arbitrary-subject' }, env).subjectStructure, 'unrecognized_redacted');
  assert.equal(oidcClaimSummary({ ...claims, sub: `repo:${env.GITHUB_REPOSITORY}:environment:event` }, env).legacySubjectMatches, true);
  assert.equal(oidcClaimSummary({}, env).missingClaims.length, 8);
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  assert.deepEqual(await diagnoseOidc(config, env, async (url, options) => {
    assert.equal(url.searchParams.get('audience'), `https://iam.googleapis.com/${config.WIF_PROVIDER}`);
    assert.equal(options.headers.Authorization, 'Bearer private-request-token');
    assert.equal(options.redirect, 'error');
    return { status: 200, json: async () => ({ value: token }) };
  }), summary);
  await assert.rejects(diagnoseOidc(config, env, async () => { throw new Error(token); }), { message: 'oidc_diagnostic_request_failed' });
  await assert.rejects(diagnoseOidc(config, env, async () => ({ status: 403 })), { message: 'oidc_diagnostic_request_failed' });
  assert.throws(() => oidcClaimSummary(claims, { ...env, GITHUB_REPOSITORY_ID: '' }), /oidc_expected_ids_required/);
});

test('web disabled invoker check with no invoker binding is preserved during image deployment', async () => {
  const fake = fakeSubprocess(null, services => { services.web.metadata.annotations['run.googleapis.com/invoker-iam-disabled'] = 'true'; }, { web: { bindings: [] } });
  assert.deepEqual(await deploy(config, dependencies(fake)), { status: 'deployed' });
  assert.equal(fake.services.web.metadata.annotations['run.googleapis.com/invoker-iam-disabled'], 'true');
  assert.equal(fake.updates.length, 2);
});
test('worker disabled IAM check, malformed access flag and ambiguous public web bindings reject before build', async () => {
  for (const [role, value, policies, code] of [
    ['worker', 'true', {}, 'worker_invoker_iam_check_required'],
    ['web', 'unexpected', {}, 'unexpected_service_access_mode'],
    ['web', 'true', {}, 'service_invoker_policy_mismatch'],
    ['web', 'false', { web: { bindings: [] } }, 'service_invoker_policy_mismatch'],
  ]) {
    const fake = fakeSubprocess(null, services => { services[role].metadata.annotations['run.googleapis.com/invoker-iam-disabled'] = value; }, policies);
    await assert.rejects(deploy(config, dependencies(fake)), { message: code });
    assert.equal(fake.calls.some(call => call.program === 'docker'), false);
    assert.equal(fake.updates.length, 0);
  }
});
test('explicit enabled worker IAM check retains only tasks and scheduler invokers', async () => {
  const fake = fakeSubprocess(null, services => { services.worker.metadata.annotations['run.googleapis.com/invoker-iam-disabled'] = 'false'; });
  assert.deepEqual(await deploy(config, dependencies(fake)), { status: 'deployed' });
  const denied = fakeSubprocess(null, null, { worker: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } });
  await assert.rejects(deploy(config, dependencies(denied)), /service_invoker_policy_mismatch/);
});

test('worker accepts its exact deterministic URL advertised by the live service', async () => {
  const fake = fakeSubprocess(null, services => {
    services.worker.status.url = 'https://worker-hash-fixture.run.app';
    services.worker.metadata.annotations['run.googleapis.com/urls'] = JSON.stringify([services.worker.status.url, metadata.WORKER_URL]);
  });
  assert.deepEqual(await deploy(config, dependencies(fake)), { status: 'deployed' });
});
test('worker rejects unknown URLs and malformed advertised URL lists before build', async () => {
  for (const [advertised, code] of [
    [JSON.stringify(['https://other-fixture.run.app']), 'worker_origin_mismatch'],
    ['not-json', 'worker_url_annotation_invalid'],
    [JSON.stringify(metadata.WORKER_URL), 'worker_url_annotation_invalid'],
    [JSON.stringify([metadata.WORKER_URL, 42]), 'worker_url_annotation_invalid'],
    [JSON.stringify([`${metadata.WORKER_URL}/health`]), 'worker_url_annotation_invalid'],
    [JSON.stringify(['https://private-fixture.invalid']), 'worker_url_annotation_invalid'],
  ]) {
    const fake = fakeSubprocess(null, services => {
      services.worker.metadata.annotations['run.googleapis.com/urls'] = advertised;
      if (code === 'worker_origin_mismatch') services.worker.status.url = 'https://worker-hash-fixture.run.app';
    });
    await assert.rejects(deploy(config, dependencies(fake)), { message: code });
    assert.equal(fake.calls.some(call => call.program === 'docker'), false);
  }
});
test('existing service may omit disabled startup CPU boost while enabled or unknown values reject', async () => {
  const fake = fakeSubprocess(null, services => {
    for (const service of Object.values(services)) delete service.spec.template.metadata.annotations['run.googleapis.com/startup-cpu-boost'];
  });
  assert.deepEqual(await deploy(config, dependencies(fake)), { status: 'deployed' });
  for (const role of ['web', 'worker']) for (const value of ['true', 'unexpected', '', null]) {
    const denied = fakeSubprocess(null, services => { services[role].spec.template.metadata.annotations['run.googleapis.com/startup-cpu-boost'] = value; });
    await assert.rejects(deploy(config, dependencies(denied)), /request_based_compute_required/);
    assert.equal(denied.calls.some(call => call.program === 'docker'), false);
  }
});
