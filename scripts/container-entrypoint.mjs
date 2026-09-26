const role = process.argv[2];
if (!['web', 'worker'].includes(role) || process.argv.length !== 3) {
  throw new Error('container_role_must_be_web_or_worker');
}
await import(role === 'web' ? '../apps/api/dist/index.js' : '../apps/worker/dist/index.js');
