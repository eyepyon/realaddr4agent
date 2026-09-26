import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = resolve(root, 'contracts');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const canonicalAbi = abi => abi.map(entry => JSON.stringify(canonical(entry))).sort();
const safePath = key => {
  assert(typeof key === 'string' && !isAbsolute(key) && !/^[A-Za-z]:|\\|(^|\/)\.\.(\/|$)/.test(key), 'Unsafe compiler source path');
  assert(key === 'src/LeaseRegistry.sol' || key.startsWith('node_modules/@openzeppelin/contracts/') || key.startsWith('@openzeppelin/contracts/'), 'Unexpected compiler source');
  const path = resolve(contracts, key.startsWith('@openzeppelin/') ? `node_modules/${key}` : key);
  assert(!relative(contracts, path).startsWith('..'), 'Source escapes contracts directory');
  return path;
};

try {
  const require = createRequire(resolve(contracts, 'package.json'));
  const { keccak_256 } = require('@noble/hashes/sha3');
  const artifact = JSON.parse(await readFile(resolve(contracts, 'out/LeaseRegistry.sol/LeaseRegistry.json'), 'utf8'));
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  assert(metadata && /^0\.8\.30\+/.test(metadata.compiler?.version ?? ''), 'Compiler must be 0.8.30');
  assert(metadata.settings?.optimizer?.enabled === true && metadata.settings.optimizer.runs === 200 && metadata.settings.evmVersion === 'cancun', 'Unexpected compiler settings');
  const target = metadata.settings.compilationTarget;
  assert(target && Object.keys(target).length === 1 && target['src/LeaseRegistry.sol'] === 'LeaseRegistry', 'Unexpected compilation target');
  assert(Array.isArray(artifact.abi), 'ABI missing');
  assert(Array.isArray(metadata.output?.abi) && JSON.stringify(canonicalAbi(metadata.output.abi)) === JSON.stringify(canonicalAbi(artifact.abi)), 'Artifact ABI differs from compiler metadata');
  const functions = new Map(artifact.abi.filter(entry => entry.type === 'function').map(entry => [`${entry.name}(${entry.inputs.map(input => input.type).join(',')})`, entry]));
  assert(functions.get('getLease(bytes32)')?.stateMutability === 'view' && functions.has('recordLease(bytes32,bytes32,uint16,bytes32,uint64,uint64)') && functions.has('revokeLease(bytes32,uint64)'), 'Expected lease functions missing');
  const constructor = artifact.abi.find(entry => entry.type === 'constructor');
  assert(constructor?.inputs?.length === 2 && constructor.inputs[0].name === 'admin' && constructor.inputs[1].name === 'writer' && constructor.inputs.every(input => input.type === 'address'), 'Unexpected constructor');
  const bytes = field => {
    const entry = artifact[field];
    const object = entry?.object;
    assert(typeof object === 'string' && /^(?:0x)?[0-9a-fA-F]+$/.test(object) && object.replace(/^0x/, '').length % 2 === 0, 'Empty or unresolved bytecode');
    assert(!entry.linkReferences || Object.keys(entry.linkReferences).length === 0, 'Unresolved library links');
    return Buffer.from(object.replace(/^0x/, ''), 'hex');
  };
  const creation = bytes('bytecode');
  const runtime = bytes('deployedBytecode');
  const sources = [];
  assert(metadata.sources && Object.keys(metadata.sources).length > 1, 'Compiler source set missing');
  for (const key of Object.keys(metadata.sources).sort()) {
    const contents = await readFile(safePath(key));
    assert(`0x${Buffer.from(keccak_256(contents)).toString('hex')}` === metadata.sources[key].keccak256, 'Source differs from compiler metadata; rebuild required');
    sources.push({ source: key, sha256: sha256(contents), compilerKeccak256: metadata.sources[key].keccak256 });
  }
  const packageInfo = JSON.parse(await readFile(resolve(contracts, 'node_modules/@openzeppelin/contracts/package.json'), 'utf8'));
  assert(packageInfo.version === '5.4.0', 'OpenZeppelin must be 5.4.0');
  // Export only the fields required to preserve the reviewed interface and bytecode.
  const exported = { abi: artifact.abi, bytecode: { object: `0x${creation.toString('hex')}`, linkReferences: {} }, deployedBytecode: { object: `0x${runtime.toString('hex')}`, linkReferences: {} } };
  const abiText = json(artifact.abi);
  const manifest = { contract: 'LeaseRegistry', status: 'local_artifact_only', chainId: 11155111, compiler: metadata.compiler.version, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', openZeppelin: '5.4.0', constructor: constructor.inputs.map(({ name, type }) => ({ name, type })), hashes: { algorithm: 'SHA-256', creationBytecode: sha256(creation), runtimeBytecode: sha256(runtime), abiFile: sha256(abiText) }, sources };
  const destination = resolve(contracts, 'dist');
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, 'LeaseRegistry.json'), json(exported), 'utf8');
  await writeFile(resolve(destination, 'LeaseRegistry.abi.json'), abiText, 'utf8');
  await writeFile(resolve(destination, 'deployment-manifest.json'), json(manifest), 'utf8');
  process.stdout.write('LeaseRegistry local artifacts exported; no deployment performed.\n');
} catch (error) {
  // Filesystem errors can contain local paths; report only controlled validation messages.
  const messages = ['Unsafe compiler source path', 'Unexpected compiler source', 'Source escapes contracts directory', 'Compiler must be 0.8.30', 'Unexpected compiler settings', 'Unexpected compilation target', 'ABI missing', 'Artifact ABI differs from compiler metadata', 'Expected lease functions missing', 'Source differs from compiler metadata; rebuild required', 'Unexpected constructor', 'Empty or unresolved bytecode', 'Unresolved library links', 'Compiler source set missing', 'OpenZeppelin must be 5.4.0'];
  process.stderr.write(`${messages.includes(error.message) ? error.message : 'Artifact export failed; build the pinned contract first.'}\n`);
  process.exitCode = 1;
}
