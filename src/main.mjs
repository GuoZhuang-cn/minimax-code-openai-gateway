import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createGateway } from './server.mjs';
import { createWorker, ROOT } from './worker.mjs';

const worker = await createWorker();
let apiKey;
try {
  apiKey = (await fs.readFile(path.join(ROOT, '.state', 'gateway.key'), 'utf8')).trim();
} catch {
  console.error('Run setup first: node scripts/manage.mjs setup');
  process.exit(1);
}
const port = Number(process.env.GATEWAY_PORT || '18765');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('GATEWAY_PORT must be 1024..65535.');
await worker.preflight();
const controllers = new Set();
const server = createGateway({
  apiKey,
  readiness: worker.readiness,
  run: async ({ messages, signal }) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    controllers.add(controller);
    if (signal.aborted) abort();
    try { return await worker.run({ messages, signal: controller.signal }); }
    finally { signal.removeEventListener('abort', abort); controllers.delete(controller); }
  },
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port already in use; no existing process was stopped.' : 'Gateway listener failed.');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Gateway listening at http://127.0.0.1:${port}/v1`);
  console.log(JSON.stringify(worker.readiness()));
});
const shutdown = () => {
  for (const controller of controllers) controller.abort();
  server.close();
  server.closeAllConnections();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
