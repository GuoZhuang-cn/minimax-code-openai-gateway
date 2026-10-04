import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLI_VERSION, createWorker, ROOT } from '../src/worker.mjs';

const keyPath = path.join(ROOT, '.state', 'gateway.key');
const digest = value => createHash('sha256').update(value).digest();
async function assertKeyFile() {
  const st = await fs.lstat(keyPath);
  if (!st.isFile() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077)) throw new Error('unsafe_gateway_key_file');
}
async function readKey() { await assertKeyFile(); return (await fs.readFile(keyPath, 'utf8')).trim(); }
async function writePrivate(file, text) { await fs.writeFile(file, `${text}\n`, { mode: 0o600, flag: 'wx' }); }
async function generateKey() {
  try { await readKey(); return false; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = `mcodegw_${randomBytes(32).toString('base64url')}`;
    await writePrivate(keyPath, key);
    return true;
  }
}
async function assertKey() {
  const key = await readKey();
  if (key.length < 32 || /[^\x21-\x7e]/.test(key)) throw new Error('invalid_gateway_key');
  if (!timingSafeEqual(digest(key), digest(key))) throw new Error('key_integrity_check_failed');
}
const usableSandbox = value => value === 'verified' || value === 'unsandboxed_opt_in';
async function setup() {
  const worker = await createWorker();
  const created = await generateKey();
  await assertKey();
  const result = await worker.preflight();
  console.log(JSON.stringify({ action: 'setup', cliVersion: CLI_VERSION, key: created ? 'created_in_.state/gateway.key' : 'already_present', readiness: result }));
  process.exitCode = usableSandbox(result.sandbox) ? 0 : 2;
}
async function doctor() {
  await assertKey();
  const worker = await createWorker();
  const result = await worker.preflight();
  console.log(JSON.stringify({ action: 'doctor', cliVersion: CLI_VERSION, readiness: result }));
  process.exitCode = usableSandbox(result.sandbox) ? 0 : 2;
}
async function login() {
  await assertKey();
  const worker = await createWorker();
  const result = await worker.preflight();
  if (!usableSandbox(result.sandbox)) throw new Error('sandbox_preflight_failed');
  // Authentication is intentionally manual and isolated from the gateway worker.
  const launcher = path.join(ROOT, '.runtime', 'minimax-code', 'bin', 'mcode');
  if (result.sandbox === 'unsandboxed_opt_in') {
    console.log('WARNING: running without OS sandbox (GATEWAY_ALLOW_UNSANDBOXED=1). The CLI keeps its normal local file/tool access; isolation relies on the separate HOME, data dir and empty workspace only.');
  }
  console.log('Run this in your own terminal, complete the official browser sign-in, then run: npm run verify');
  console.log(`HOME=${JSON.stringify(worker.env.HOME)} MINIMAX_DATA_DIR=${JSON.stringify(worker.env.MINIMAX_DATA_DIR)} MAVIS_DATA_DIR=${JSON.stringify(worker.env.MAVIS_DATA_DIR)} MCODE_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 ${JSON.stringify(launcher)} login`);
  console.log('This tool never accepts, reads, or prints MiniMax credentials.');
}
async function verify() {
  await assertKey();
  const worker = await createWorker();
  const result = await worker.preflight();
  if (!usableSandbox(result.sandbox)) throw new Error('sandbox_preflight_failed');
  const verified = await worker.verify();
  console.log(JSON.stringify({ action: 'verify', readiness: verified }));
}
async function showKey() {
  await assertKey();
  console.log(await readKey());
}
const command = process.argv[2];
try {
  if (command === 'setup') await setup();
  else if (command === 'doctor') await doctor();
  else if (command === 'login') await login();
  else if (command === 'verify') await verify();
  else if (command === 'key') await showKey();
  else throw new Error('usage: node scripts/manage.mjs <setup|doctor|login|verify|key>');
} catch (error) {
  console.error(error.message === 'sandbox_preflight_failed' ? 'Sandbox verification failed; gateway remains disabled.' : 'Gateway management command failed.');
  process.exitCode = 1;
}
