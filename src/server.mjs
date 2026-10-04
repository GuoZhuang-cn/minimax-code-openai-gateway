import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { isIP } from 'node:net';

const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const REQUEST_FIELDS = new Set(['model', 'messages', 'stream', 'n']);
const MESSAGE_FIELDS = new Set(['role', 'content']);
const ROLES = new Set(['system', 'developer', 'user', 'assistant']);

class RequestError extends Error {
  constructor(status, code, message, param = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loopback(address) {
  if (address === '::1') return true;
  const ipv4 = address?.startsWith('::ffff:') ? address.slice(7) : address;
  return typeof ipv4 === 'string' && isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function json(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function failure(req, res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const known = error instanceof RequestError;
  const status = known ? error.status : 500;
  const headers = {};
  if (!req.complete) headers.Connection = 'close';
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
  if (status === 429) headers['Retry-After'] = '1';
  json(res, status, {
    error: {
      message: known ? error.message : 'Internal gateway error.',
      type: status === 401 ? 'authentication_error' : status < 500 ? 'invalid_request_error' : 'server_error',
      param: known ? error.param : null,
      code: known ? error.code : 'internal_error',
    },
  }, headers);
}

function validateBoundary(req) {
  if (!loopback(req.socket.remoteAddress)) {
    throw new RequestError(403, 'non_loopback_peer', 'Only loopback clients are allowed.');
  }
  const port = req.socket.localPort;
  const hosts = req.headersDistinct.host ?? [];
  if (hosts.length !== 1 || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(hosts[0])) {
    throw new RequestError(403, 'invalid_host', 'Host must match the local loopback address and listening port.');
  }
  if (Object.hasOwn(req.headers, 'origin')) {
    throw new RequestError(403, 'origin_not_allowed', 'Origin requests and cross-origin access are not supported.');
  }
}

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const clean = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onAbort);
    };
    const onAbort = () => {
      clean();
      reject(new RequestError(400, 'request_aborted', 'Request was aborted.'));
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        clean();
        req.pause();
        reject(new RequestError(413, 'body_too_large', 'Request body exceeds the configured byte limit.'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      clean();
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
        resolve(JSON.parse(text));
      } catch {
        reject(new RequestError(400, 'invalid_json', 'Request body must be valid UTF-8 JSON.'));
      }
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAbort);
    req.once('error', onAbort);
    if (req.aborted || req.destroyed) onAbort();
  });
}

function validateBody(body, model) {
  if (!record(body)) throw new RequestError(400, 'invalid_request', 'Request body must be a JSON object.');
  for (const field of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(field)) {
      throw new RequestError(400, 'unsupported_field', `Unsupported request field: ${field}. Only model, messages, stream and n are supported.`, field);
    }
  }
  if (body.model !== model) throw new RequestError(400, 'invalid_model', 'model must exactly match the configured virtual alias.', 'model');
  if (Object.hasOwn(body, 'stream') && typeof body.stream !== 'boolean') {
    throw new RequestError(400, 'invalid_stream', 'stream must be a boolean.', 'stream');
  }
  if (Object.hasOwn(body, 'n') && body.n !== 1) {
    throw new RequestError(400, 'invalid_n', 'Only n = 1 is supported.', 'n');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 64) {
    throw new RequestError(400, 'invalid_messages', 'messages must contain between 1 and 64 text messages.', 'messages');
  }
  for (const [index, message] of body.messages.entries()) {
    if (!record(message)) throw new RequestError(400, 'invalid_message', 'Each message must be an object.', `messages[${index}]`);
    for (const field of Object.keys(message)) {
      if (!MESSAGE_FIELDS.has(field)) {
        throw new RequestError(400, 'unsupported_message_field', `Unsupported message field: ${field}. Only role and content are supported.`, `messages[${index}].${field}`);
      }
    }
    if (!ROLES.has(message.role)) {
      throw new RequestError(400, 'invalid_role', 'Only system, developer, user and assistant roles are supported.', `messages[${index}].role`);
    }
    if (typeof message.content !== 'string') {
      throw new RequestError(400, 'non_text_content', 'Message content must be a plain text string.', `messages[${index}].content`);
    }
  }
  if (body.messages.at(-1).role !== 'user') {
    throw new RequestError(400, 'invalid_last_role', 'The last message must have the user role.', 'messages');
  }
  return body;
}

function validateResult(result) {
  if (!record(result) || typeof result.text !== 'string') {
    throw new RequestError(502, 'invalid_run_result', 'Upstream returned an invalid result.');
  }
  if (result.usage === undefined) return undefined;
  const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  if (!record(result.usage) || fields.some((field) => !Number.isSafeInteger(result.usage[field]) || result.usage[field] < 0)) {
    throw new RequestError(502, 'invalid_run_result', 'Upstream returned an invalid result.');
  }
  return Object.fromEntries(fields.map((field) => [field, result.usage[field]]));
}

async function sse(res, completion, text, signal) {
  res.writeHead(200, {
    ...COMMON_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Streaming-Mode': 'buffered',
  });
  const write = async (data) => {
    if (signal.aborted || res.destroyed) return false;
    if (!res.write(`data: ${data}\n\n`)) await once(res, 'drain', { signal });
    return true;
  };
  const chunk = (delta, finishReason = null) => JSON.stringify({
    ...completion,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  if (!await write(chunk({ role: 'assistant', content: '' }))) return;
  let part = '';
  for (const character of text) {
    part += character;
    if (part.length >= 1024) {
      if (!await write(chunk({ content: part }))) return;
      part = '';
    }
  }
  if (part && !await write(chunk({ content: part }))) return;
  if (!await write(chunk({}, 'stop'))) return;
  if (!await write('[DONE]')) return;
  res.end();
}

export function createGateway({
  apiKey,
  model = 'minimax-code',
  run,
  readiness,
  maxBodyBytes = 131072,
  maxConcurrent = 1,
  timeoutMs = 120000,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 32 || /[^\x21-\x7e]/.test(apiKey)) {
    throw new TypeError('apiKey must contain at least 32 non-whitespace ASCII characters.');
  }
  if (typeof model !== 'string' || model.length === 0) throw new TypeError('model must be a nonempty virtual alias.');
  if (typeof run !== 'function' || typeof readiness !== 'function') throw new TypeError('run and readiness must be functions.');
  for (const [name, value] of Object.entries({ maxBodyBytes, maxConcurrent, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1 || (name === 'timeoutMs' && value > 2147483647)) {
      throw new TypeError(`${name} must be a positive supported integer.`);
    }
  }
  const expectedHash = digest(apiKey);
  let active = 0;

  function state() {
    try {
      const value = readiness();
      if (record(value) && typeof value.ready === 'boolean') return value;
    } catch {
      // 就绪探针的内部异常不得进入 HTTP 响应。
    }
    throw new RequestError(503, 'readiness_failed', 'Gateway readiness is unavailable.');
  }

  async function execute(messages, controller) {
    active += 1;
    let timedOut = false;
    let onAbort;
    const cancelled = new Promise((resolve) => {
      onAbort = () => resolve({ kind: 'cancelled' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();
    // 槽位只随实际 run 结束释放，不能随超时或断连的 race 提前释放。
    const task = Promise.resolve()
      .then(() => run({ messages, signal: controller.signal }))
      .then((value) => ({ kind: 'success', value }), () => ({ kind: 'error' }))
      .finally(() => { active -= 1; });
    try {
      const outcome = await Promise.race([task, cancelled]);
      if (timedOut) throw new RequestError(504, 'run_timeout', 'Upstream execution timed out.');
      if (controller.signal.aborted) return undefined;
      if (outcome.kind !== 'success') throw new RequestError(502, 'run_failed', 'Upstream execution failed.');
      return outcome.value;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async function handle(req, res) {
    const controller = new AbortController();
    const onDisconnect = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) onDisconnect();
    };
    req.once('aborted', onDisconnect);
    req.on('error', onDisconnect);
    res.once('close', onClose);
    try {
      validateBoundary(req);
      const path = req.url?.split('?')[0];
      const routes = new Map([['/healthz', 'GET'], ['/v1/models', 'GET'], ['/v1/chat/completions', 'POST']]);
      const method = routes.get(path);
      if (!method) throw new RequestError(404, 'not_found', 'Unknown endpoint.');
      if (req.method !== method) {
        res.setHeader('Allow', method);
        throw new RequestError(405, 'method_not_allowed', 'Method not allowed for this endpoint.');
      }
      if (path !== '/healthz') {
        const authorization = req.headersDistinct.authorization ?? [];
        const match = authorization.length === 1 ? /^Bearer ([\x21-\x7e]{32,})$/.exec(authorization[0]) : null;
        const matches = timingSafeEqual(expectedHash, digest(match?.[1] ?? ''));
        if (!match || !matches) throw new RequestError(401, 'invalid_api_key', 'A valid Bearer API key is required.');
      }
      if (path === '/healthz') {
        const readinessState = state();
        json(res, readinessState.ready ? 200 : 503, {
          ready: readinessState.ready,
          readiness: readinessState,
          model,
          streaming: {
            mode: 'buffered',
            description: 'BUFFERED SSE: waits for run to succeed before sending chunks; not real-time token streaming.',
          },
        });
        return;
      }
      if (path === '/v1/models') {
        json(res, 200, { object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'local-gateway' }] });
        return;
      }
      const contentLength = req.headers['content-length'];
      if (contentLength !== undefined && Number(contentLength) > maxBodyBytes) {
        throw new RequestError(413, 'body_too_large', 'Request body exceeds the configured byte limit.');
      }
      const contentTypes = req.headersDistinct['content-type'] ?? [];
      if (contentTypes.length !== 1 || contentTypes[0].split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
      }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
        throw new RequestError(415, 'unsupported_content_encoding', 'Encoded request bodies are not supported.');
      }
      if (req.headers.expect) {
        if (req.headers.expect.toLowerCase() !== '100-continue') throw new RequestError(417, 'unsupported_expectation', 'Unsupported expectation.');
        res.writeContinue();
      }
      const body = validateBody(await readBody(req, maxBodyBytes), model);
      if (controller.signal.aborted || res.destroyed) return;
      if (!state().ready) throw new RequestError(503, 'not_ready', 'Gateway is not ready.');
      if (active >= maxConcurrent) throw new RequestError(429, 'too_many_requests', 'Gateway concurrency limit reached.');
      const result = await execute(body.messages, controller);
      if (controller.signal.aborted || res.destroyed) return;
      const usage = validateResult(result);
      const completion = { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model };
      if (body.stream === true) {
        await sse(res, completion, result.text, controller.signal);
      } else {
        json(res, 200, {
          ...completion,
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
          ...(usage === undefined ? {} : { usage }),
        });
      }
    } catch (error) {
      failure(req, res, error);
    } finally {
      req.off('aborted', onDisconnect);
      res.off('close', onClose);
      // 保留 error 监听，吞掉响应关闭后可能到达的请求流错误。
    }
  }

  const server = http.createServer({
    requestTimeout: 30000,
    headersTimeout: 10000,
    keepAliveTimeout: 5000,
    connectionsCheckingInterval: 1000,
    maxHeaderSize: 16384,
    // 由统一校验拒绝缺失 Host，保证错误响应也包含安全头。
    requireHostHeader: false,
  }, handle);
  server.maxHeadersCount = 0;
  server.on('checkContinue', handle);
  server.on('checkExpectation', handle);
  server.on('clientError', (error, socket) => {
    if (socket.destroyed) return;
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    const phrase = http.STATUS_CODES[status];
    const body = JSON.stringify({ error: { code: 'invalid_http_request', type: 'invalid_request_error', message: 'Invalid HTTP request.', param: null } });
    socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  return server;
}
