import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CLI_VERSION = '0.6.2';
export const SANDBOX = '/usr/bin/sandbox-exec';
export const ROOT = path.resolve(import.meta.dirname, '..');

export async function privateDirectory(dir) {
  try { await fs.mkdir(dir, { mode: 0o700 }); } catch (error) {
    // Some managed runtimes wrap mkdir on an existing path with a non-standard
    // error code; treat a genuine EEXIST by code or message as "already there".
    const alreadyExists = error.code === 'EEXIST' || /^EEXIST\b/.test(String(error.message || ''));
    if (!alreadyExists) throw error;
  }
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077)) {
    throw new Error('unsafe_private_directory');
  }
  if (await fs.realpath(dir) !== dir) throw new Error('unsafe_directory_path');
}

export async function paths(root = ROOT) {
  root = await fs.realpath(root);
  const state = path.join(root, '.state');
  const worker = path.join(state, 'worker');
  for (const dir of [state, worker, ...['home', 'data', 'tmp', 'workspace'].map(x => path.join(worker, x))]) {
    await privateDirectory(dir);
  }
  const prefix = path.join(root, '.runtime', 'minimax-code');
  const cliRoot = path.join(prefix, 'releases', CLI_VERSION, 'lib', 'node_modules', '@minimax-ai', 'code');
  return { root, state, worker, cliRoot, cli: path.join(cliRoot, 'cli.js'), node: await fs.realpath(process.execPath) };
}

const quote = value => JSON.stringify(value);
export function sandboxProfile(p) {
  const runtime = path.dirname(path.dirname(p.node));
  const trustedDirectories = [runtime, p.cliRoot, p.worker];
  for (const directory of trustedDirectories) {
    if (!path.isAbsolute(directory) || directory.includes('"') || directory.includes('\n')) throw new Error('unsafe_sandbox_path');
  }
  return `(version 1)
(deny default)
(allow process-exec (literal ${quote(p.node)}))
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix*)
(allow network-outbound)
(allow file-read-metadata)
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple") (subpath "/private/etc") (subpath ${quote(runtime)}) (subpath ${quote(p.cliRoot)}) (subpath ${quote(p.worker)}))
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (subpath ${quote(p.worker)}) (literal "/dev/null"))
`;
}

export function workerEnv(p) {
  // Deliberately do NOT inherit tokens, proxy settings, NODE_OPTIONS or the user's HOME.
  return {
    HOME: path.join(p.worker, 'home'),
    TMPDIR: path.join(p.worker, 'tmp'),
    XDG_CONFIG_HOME: path.join(p.worker, 'home', '.config'),
    XDG_CACHE_HOME: path.join(p.worker, 'home', '.cache'),
    PATH: `${path.dirname(p.node)}:/usr/bin:/bin`,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'dumb', NO_COLOR: '1',
    MINIMAX_DATA_DIR: path.join(p.worker, 'data'), MAVIS_DATA_DIR: path.join(p.worker, 'data'),
    MCODE_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '1',
  };
}

export function execCapture(command, args, { cwd, env, input = '', signal, timeoutMs = 120000, maxBytes = 4194304 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('worker_cancelled'));
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0;
    let output = '';
    let diagnostic = '';
    let killed = false;
    let settled = false;
    let forceTimer;
    const terminate = () => {
      if (killed) return;
      killed = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
      forceTimer.unref();
    };
    const timer = setTimeout(terminate, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', terminate, { once: true });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      signal?.removeEventListener('abort', terminate);
      error ? reject(error) : resolve(result);
    };
    child.on('error', () => finish(new Error('worker_spawn_failed')));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) { terminate(); return; }
      output += data;
    });
    child.stderr.on('data', data => {
      // Bound stderr in memory; never expose upstream diagnostics to HTTP or logs.
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) { terminate(); return; }
      diagnostic += data;
    });
    child.stdin.on('error', () => {});
    child.on('close', (code, exitSignal) => {
      if (killed || signal?.aborted) return finish(new Error('worker_terminated'));
      finish(null, { code, signal: exitSignal, stdout: output, stderr: diagnostic });
    });
    child.stdin.end(input);
  });
}

export function parseResult(stdout, exitCode) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error('invalid_cli_output');
  let result;
  try { result = JSON.parse(lines[0]); } catch { throw new Error('invalid_cli_output'); }
  if (exitCode !== 0 || result.schemaVersion !== 1 || result.type !== 'exec.result' || result.status !== 'succeeded' || typeof result.output !== 'string') {
    throw new Error('cli_execution_failed');
  }
  const response = { text: result.output };
  const u = result.usage;
  if (!result.usageIncomplete && result.usageSource !== 'unavailable' && u && [u.inputTokens, u.outputTokens, u.totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
    response.usage = { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens };
  }
  return response;
}

export function serializeMessages(messages) {
  // This is a transcript within one agent prompt, not native OpenAI role semantics.
  return 'Answer the final user message using the following JSON conversation as context. Return only the answer as text. Do not call tools, read files, browse, or run commands.\n' + JSON.stringify(messages);
}

export async function createWorker(root = ROOT) {
  const p = await paths(root);
  const profile = sandboxProfile(p);
  const env = workerEnv(p);
  const cwd = path.join(p.worker, 'workspace');
  const state = { ready: false, cli: 'not_checked', sandbox: 'not_checked', model: 'not_verified' };
  // GATEWAY_ALLOW_UNSANDBOXED=1 is a deliberate, explicit downgrade for runtimes where
  // macOS refuses to apply a restrictive Seatbelt profile (for example when the gateway
  // itself runs inside another sandbox: sandbox_apply then fails with EPERM). Without
  // this opt-in the gateway stays disabled whenever isolation cannot be proven.
  const allowUnsandboxed = process.env.GATEWAY_ALLOW_UNSANDBOXED === '1';
  let invoke = null;
  const usable = () => state.sandbox === 'verified' || state.sandbox === 'unsandboxed_opt_in';
  const unsandboxedInvoke = (args, opts = {}) => execCapture(p.node, [p.cli, ...args], { cwd, env, ...opts });
  const sandboxedInvoke = (args, opts = {}) => execCapture(SANDBOX, ['-p', profile, p.node, p.cli, ...args], { cwd, env, ...opts });
  async function sandboxEnforceable() {
    // A profile that only denies network egress must apply cleanly on a normal Mac.
    // If the kernel refuses the profile itself (nested sandbox, new OS policy), no
    // isolation can be guaranteed here and we must say so instead of claiming verified.
    const probe = await execCapture(SANDBOX, ['-p', '(version 1)(deny network-outbound)', '/usr/bin/true'], { timeoutMs: 15000 });
    return probe.code === 0 && probe.stderr.trim() === '';
  }
  async function preflight() {
    state.ready = false; state.cli = 'not_checked'; state.sandbox = 'not_checked'; state.model = 'not_verified';
    invoke = null;
    if (process.platform !== 'darwin') { state.sandbox = 'unsupported_platform'; return { ...state }; }
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(p.cliRoot, 'package.json'), 'utf8'));
      if (manifest.name !== '@minimax-ai/code' || manifest.version !== CLI_VERSION) throw new Error();
      state.cli = `installed_${CLI_VERSION}`;
    } catch { state.cli = 'missing_or_version_mismatch'; return { ...state }; }
    let sandboxed;
    try { sandboxed = await sandboxEnforceable(); } catch { sandboxed = false; }
    if (!sandboxed) {
      // The OS refused to apply a restrictive sandbox at all: this is never "verified".
      if (!allowUnsandboxed) { state.sandbox = 'unavailable'; return { ...state }; }
      invoke = unsandboxedInvoke;
      state.sandbox = 'unsandboxed_opt_in';
    } else {
      const sentinel = path.join(p.state, 'sandbox-canary');
      try {
        await fs.writeFile(sentinel, 'synthetic-isolation-canary', { mode: 0o600 });
        const probe = `const f=require('node:fs');const cp=require('node:child_process');
const outside=${JSON.stringify(sentinel)};const inside=${JSON.stringify(path.join(cwd, 'probe'))};
for(const operation of [()=>f.readFileSync(outside),()=>f.writeFileSync(outside,'bad')]){let denied=false;try{operation()}catch(e){denied=['EPERM','EACCES'].includes(e.code)}if(!denied)process.exit(9)}
f.writeFileSync(inside,'ok');if(f.readFileSync(inside,'utf8')!=='ok')process.exit(10);
const s=cp.spawnSync('/bin/sh',['-c','exit 0']);if(!s.error||s.error.code!=='EPERM')process.exit(11);console.log('isolation-ok');`;
        const probeResult = await execCapture(SANDBOX, ['-p', profile, p.node, '-e', probe], { cwd, env, timeoutMs: 15000 });
        if (probeResult.code !== 0 || probeResult.stdout.trim() !== 'isolation-ok') throw new Error();
        invoke = sandboxedInvoke;
      } catch { invoke = null; state.sandbox = 'verification_failed'; return { ...state }; }
    }
    try {
      const version = await invoke(['--version'], { timeoutMs: 20000 });
      if (version.code !== 0 || version.stdout.trim() !== CLI_VERSION) throw new Error();
      const help = await invoke(['exec', '--help'], { timeoutMs: 20000 });
      if (help.code !== 0 || !['--input', '--output-format', '--permission', '--max-steps', '--cwd'].every(flag => help.stdout.includes(flag))) throw new Error();
      state.cli = `verified_${CLI_VERSION}`;
    } catch { invoke = null; state.sandbox = 'verification_failed'; return { ...state }; }
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(p.state, 'verified.json'), 'utf8'));
      if (receipt.version === CLI_VERSION && receipt.node === p.node && receipt.schema === 1 && receipt.sandbox === state.sandbox) {
        state.model = 'previously_verified'; state.ready = true;
      }
    } catch { /* Explicit authenticated smoke test has not completed. */ }
    return { ...state };
  }
  async function run({ messages, signal, verify = false }) {
    if (!usable() || (!verify && !state.ready)) throw new Error('worker_not_ready');
    const args = ['exec', '--input', '-', '--input-format', 'text', '--output-format', 'json', '--cwd', cwd, '--permission', 'smart', '--max-steps', '1', '--timeout', '110s'];
    const result = await invoke(args, { input: serializeMessages(messages), signal, timeoutMs: 115000 });
    return parseResult(result.stdout, result.code);
  }
  async function verify() {
    if (!usable()) throw new Error('worker_not_ready');
    const response = await run({ messages: [{ role: 'user', content: 'Reply with exactly OK and nothing else.' }], verify: true });
    if (response.text.trim() !== 'OK') throw new Error('smoke_answer_mismatch');
    await fs.writeFile(path.join(p.state, 'verified.json'), JSON.stringify({ schema: 1, version: CLI_VERSION, node: p.node, sandbox: state.sandbox }), { mode: 0o600 });
    state.model = 'verified'; state.ready = true;
    return { ...state };
  }
  return { p, env, preflight, run, verify, readiness: () => ({ ...state }) };
}
