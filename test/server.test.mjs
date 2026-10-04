import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createGateway } from '../src/server.mjs';

const API_KEY = 'test-only-key-0123456789abcdefghij';
const DEFAULT_BODY = { model: 'minimax-code', messages: [{ role: 'user', content: '你好' }] };
const OPTIONS = { timeout: 8000 };

function startRequest(server, options = {}) {
  const port = server.address().port;
  const headers = {
    Host: `127.0.0.1:${port}`,
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === null || value === undefined) delete headers[key];
  }
  const body = options.raw ?? JSON.stringify(options.body ?? DEFAULT_BODY);
  const method = options.method ?? 'POST';
  if (method === 'POST' && !options.chunked && !Object.hasOwn(headers, 'Content-Length')) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  if (options.chunked) headers['Transfer-Encoding'] = 'chunked';
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request({
      hostname: '127.0.0.1', port, method,
      path: options.path ?? '/v1/chat/completions',
      headers, agent: false, setHost: false,
      ...(options.localAddress ? { localAddress: options.localAddress } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        req.setTimeout(0);
        try {
          assert.equal(res.headers['cache-control'], 'no-store');
          assert.equal(res.headers['x-content-type-options'], 'nosniff');
          assert.equal(res.headers['access-control-allow-origin'], undefined);
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode, headers: res.headers, text,
            json: text && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : undefined,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('测试 HTTP 请求超时')));
    if (options.headersOnly) {
      req.flushHeaders();
    } else if (options.chunked) {
      const buffer = Buffer.from(body);
      for (let index = 0; index < buffer.length; index += 17) req.write(buffer.subarray(index, index + 17));
      req.end();
    } else {
      req.end(method === 'POST' ? body : undefined);
    }
  });
  return { req, response };
}

async function fixture(t, options = {}) {
  const run = t.mock.fn(options.run ?? (async () => ({ text: '模拟回答' })));
  const server = createGateway({ apiKey: API_KEY, readiness: () => ({ ready: true }), ...options, run });
  assert.ok(server instanceof http.Server);
  assert.equal(server.listening, false);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  return { server, run, call: (requestOptions) => startRequest(server, requestOptions).response };
}

function expectError(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.json.error.code, code);
}

test('非流式成功：传递文本消息与 AbortSignal，不伪造 usage', OPTIONS, async (t) => {
  const { call, run, server } = await fixture(t);
  const messages = [
    { role: 'system', content: '系统消息' },
    { role: 'developer', content: '开发者消息' },
    { role: 'user', content: '问题一' },
    { role: 'assistant', content: '历史回答' },
    { role: 'user', content: '问题二' },
  ];
  const response = await call({ body: { ...DEFAULT_BODY, messages, n: 1, stream: false } });
  assert.equal(response.status, 200);
  assert.equal(response.json.object, 'chat.completion');
  assert.match(response.json.id, /^chatcmpl-/);
  assert.ok(Number.isInteger(response.json.created));
  assert.equal(response.json.model, 'minimax-code');
  assert.deepEqual(response.json.choices, [{ index: 0, message: { role: 'assistant', content: '模拟回答' }, finish_reason: 'stop' }]);
  assert.equal(Object.hasOwn(response.json, 'usage'), false);
  assert.equal(run.mock.callCount(), 1);
  assert.deepEqual(run.mock.calls[0].arguments[0].messages, messages);
  assert.ok(run.mock.calls[0].arguments[0].signal instanceof AbortSignal);
  assert.equal(run.mock.calls[0].arguments[0].signal.aborted, false);
  assert.equal(server.headersTimeout, 10000);
  assert.equal(server.requestTimeout, 30000);
});

test('仅返回 run 提供的真实 usage', OPTIONS, async (t) => {
  const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
  const { call } = await fixture(t, { run: async () => ({ text: '', usage }) });
  const response = await call();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.usage, usage);
  assert.equal(response.json.choices[0].message.content, '');
});

test('模型列表要求鉴权，默认仅公开 minimax-code 虚拟别名', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  const response = await call({ path: '/v1/models', method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(response.json.object, 'list');
  assert.deepEqual(response.json.data.map(({ id }) => id), ['minimax-code']);
  expectError(await call({ path: '/v1/models', method: 'GET', headers: { Authorization: null } }), 401, 'invalid_api_key');
  assert.equal(run.mock.callCount(), 0);
});

test('配置拒绝短密钥、带空白密钥和无效限制', () => {
  const base = { apiKey: API_KEY, run: async () => ({ text: '' }), readiness: () => ({ ready: true }) };
  for (const apiKey of ['', 'x'.repeat(31), `${API_KEY}\n`, ' '.repeat(32), undefined]) {
    assert.throws(() => createGateway({ ...base, apiKey }), /apiKey/);
  }
  for (const [key, value] of [['maxConcurrent', 0], ['maxBodyBytes', -1], ['timeoutMs', 0], ['timeoutMs', 2147483648]]) {
    assert.throws(() => createGateway({ ...base, [key]: value }), new RegExp(key));
  }
  assert.throws(() => createGateway({ ...base, run: undefined }), /functions/);
});

test('鉴权拒绝缺失、格式错误、错误密钥及重复 Authorization', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  for (const authorization of [null, 'Bearer short', `Basic ${API_KEY}`, `bearer ${API_KEY}`, `Bearer ${'x'.repeat(32)}`, `Bearer ${API_KEY}x`, [`Bearer ${API_KEY}`, `Bearer ${API_KEY}`]]) {
    const response = await call({ headers: { Authorization: authorization } });
    expectError(response, 401, 'invalid_api_key');
    assert.equal(response.headers['www-authenticate'], 'Bearer');
    assert.equal(response.text.includes(API_KEY), false);
  }
  assert.equal(run.mock.callCount(), 0);
});

test('model 必须精确匹配别名', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  for (const model of ['MiniMax-code', 'minimax-code ', 'other', null, 1]) {
    expectError(await call({ body: { ...DEFAULT_BODY, model } }), 400, 'invalid_model');
  }
  expectError(await call({ body: { messages: DEFAULT_BODY.messages } }), 400, 'invalid_model');
  assert.equal(run.mock.callCount(), 0);
});

test('自定义别名在模型列表、请求校验与响应中保持一致', OPTIONS, async (t) => {
  const { call } = await fixture(t, { model: 'local-test-alias' });
  const models = await call({ path: '/v1/models', method: 'GET' });
  assert.equal(models.json.data[0].id, 'local-test-alias');
  expectError(await call(), 400, 'invalid_model');
  const response = await call({ body: { ...DEFAULT_BODY, model: 'local-test-alias' } });
  assert.equal(response.status, 200);
  assert.equal(response.json.model, 'local-test-alias');
});

test('所有端点拒绝 Origin，包括空值、null 和同源 Origin', OPTIONS, async (t) => {
  const { call, server, run } = await fixture(t);
  for (const path of ['/healthz', '/v1/models', '/v1/chat/completions', '/missing']) {
    for (const Origin of ['', 'null', `http://localhost:${server.address().port}`]) {
      expectError(await call({ path, method: path === '/v1/chat/completions' ? 'POST' : 'GET', headers: { Origin } }), 403, 'origin_not_allowed');
    }
  }
  assert.equal(run.mock.callCount(), 0);
});

test('Host 只允许回环地址与实际监听端口，拒绝重复 Host', OPTIONS, async (t) => {
  const { call, server, run } = await fixture(t);
  const port = server.address().port;
  for (const Host of [null, '', 'external.invalid', '127.0.0.1', 'localhost', `localhost:${port + 1}`, `127.0.0.1.evil:${port}`, `[::1]:${port}`]) {
    for (const path of ['/healthz', '/v1/models', '/v1/chat/completions']) {
      expectError(await call({ path, method: path === '/v1/chat/completions' ? 'POST' : 'GET', headers: { Host } }), 403, 'invalid_host');
    }
  }
  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  socket.setEncoding('utf8');
  socket.setTimeout(5000, () => socket.destroy(new Error('重复 Host 测试超时')));
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  await once(socket, 'connect');
  const ended = once(socket, 'end');
  socket.end(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  await ended;
  const response = chunks.join('');
  assert.match(response, /^HTTP\/1.1 403 /);
  assert.match(response, /"code":"invalid_host"/);
  assert.match(response, /Cache-Control: no-store/i);
  assert.match(response, /X-Content-Type-Options: nosniff/i);
  assert.equal(run.mock.callCount(), 0);
  assert.equal((await call({ headers: { Host: `localhost:${port}` } })).status, 200);
});

test('非回环来源即使提供合法 Host 和密钥也被拒绝', OPTIONS, async (t) => {
  const address = Object.values(networkInterfaces()).flat().find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
  if (!address) {
    t.skip('本机无可用于绑定客户端来源的非回环 IPv4 地址');
    return;
  }
  const { call, run } = await fixture(t);
  const response = await call({ localAddress: address });
  expectError(response, 403, 'non_loopback_peer');
  assert.equal(run.mock.callCount(), 0);
});

test('未知路径返回 404，已知路径错误方法返回 405 与 Allow', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  for (const path of ['/missing', '/v1/completions', '/v1/chat/completions/', '/constructor']) {
    expectError(await call({ path }), 404, 'not_found');
  }
  for (const [path, method, allow] of [['/healthz', 'POST', 'GET'], ['/v1/models', 'DELETE', 'GET'], ['/v1/chat/completions', 'GET', 'POST'], ['/v1/chat/completions', 'OPTIONS', 'POST']]) {
    const response = await call({ path, method });
    expectError(response, 405, 'method_not_allowed');
    assert.equal(response.headers.allow, allow);
  }
  assert.equal(run.mock.callCount(), 0);
});

test('所有未知请求字段均明确报错，不忽略常见 OpenAI 参数', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  for (const field of ['temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'tools', 'tool_choice', 'response_format', 'stream_options', 'stop', 'seed', 'user', 'metadata', 'arbitrary_unknown']) {
    const response = await call({ body: { ...DEFAULT_BODY, [field]: null } });
    expectError(response, 400, 'unsupported_field');
    assert.equal(response.json.error.param, field);
    assert.ok(response.json.error.message.includes(field));
  }
  assert.equal(run.mock.callCount(), 0);
});

test('stream 仅接受布尔，n 仅接受数字 1', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  for (const stream of [null, 0, 1, 'true', {}, []]) expectError(await call({ body: { ...DEFAULT_BODY, stream } }), 400, 'invalid_stream');
  for (const n of [null, 0, 2, '1', true]) expectError(await call({ body: { ...DEFAULT_BODY, n } }), 400, 'invalid_n');
  assert.equal(run.mock.callCount(), 0);
});

test('拒绝非文本、工具消息、消息附加字段以及非 user 结尾', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  for (const content of [null, 1, { text: '内容' }, [{ type: 'text', text: '内容' }], [{ type: 'image_url', image_url: { url: '不使用外部资源' } }]]) {
    expectError(await call({ body: { ...DEFAULT_BODY, messages: [{ role: 'user', content }] } }), 400, 'non_text_content');
  }
  for (const role of ['tool', 'function', 'unknown', null]) {
    expectError(await call({ body: { ...DEFAULT_BODY, messages: [{ role, content: '内容' }] } }), 400, 'invalid_role');
  }
  for (const field of ['name', 'tool_calls', 'tool_call_id']) {
    expectError(await call({ body: { ...DEFAULT_BODY, messages: [{ role: 'user', content: '内容', [field]: '不允许' }] } }), 400, 'unsupported_message_field');
  }
  for (const role of ['system', 'developer', 'assistant']) {
    expectError(await call({ body: { ...DEFAULT_BODY, messages: [{ role, content: '内容' }] } }), 400, 'invalid_last_role');
  }
  expectError(await call({ body: { ...DEFAULT_BODY, messages: [null] } }), 400, 'invalid_message');
  assert.equal(run.mock.callCount(), 0);
});

test('消息数量必须为 1 至 64，64 条可成功', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  for (const messages of [[], null, {}, Array.from({ length: 65 }, () => ({ role: 'user', content: '内容' }))]) {
    expectError(await call({ body: { ...DEFAULT_BODY, messages } }), 400, 'invalid_messages');
  }
  assert.equal(run.mock.callCount(), 0);
  assert.equal((await call({ body: { ...DEFAULT_BODY, messages: Array.from({ length: 64 }, () => ({ role: 'user', content: '内容' })) } })).status, 200);
});

test('要求 JSON Content-Type，拒绝非法 JSON、UTF-8 和压缩正文', OPTIONS, async (t) => {
  const { call, run } = await fixture(t);
  for (const type of [null, 'text/plain', 'application/jsonp']) {
    expectError(await call({ headers: { 'Content-Type': type } }), 415, 'unsupported_media_type');
  }
  for (const raw of ['', '{', Buffer.from([0xff])]) expectError(await call({ raw }), 400, 'invalid_json');
  for (const raw of ['null', '[]', '42', '"内容"']) expectError(await call({ raw }), 400, 'invalid_request');
  expectError(await call({ headers: { 'Content-Encoding': 'gzip' } }), 415, 'unsupported_content_encoding');
  assert.equal(run.mock.callCount(), 0);
  assert.equal((await call({ headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
});

test('Content-Length 超限在发送正文和 100 Continue 前拒绝', OPTIONS, async (t) => {
  const { server, run } = await fixture(t, { maxBodyBytes: 256 });
  for (const expect of [undefined, '100-continue']) {
    const { req, response } = startRequest(server, { headersOnly: true, headers: { 'Content-Length': '257', Expect: expect } });
    let continued = false;
    req.on('continue', () => { continued = true; });
    const result = await response;
    expectError(result, 413, 'body_too_large');
    assert.equal(result.headers.connection, 'close');
    assert.equal(continued, false);
    req.destroy();
  }
  assert.equal(run.mock.callCount(), 0);
});

test('chunked 正文同样按字节限制，边界大小精确且支持 UTF-8', OPTIONS, async (t) => {
  const raw = JSON.stringify({ ...DEFAULT_BODY, messages: [{ role: 'user', content: '汉字'.repeat(30) }] });
  const maxBodyBytes = Buffer.byteLength(raw);
  const { call, run } = await fixture(t, { maxBodyBytes });
  expectError(await call({ raw: `${raw} `, chunked: true }), 413, 'body_too_large');
  assert.equal(run.mock.callCount(), 0);
  assert.equal((await call({ raw, chunked: true })).status, 200);
  assert.equal((await call({ raw })).status, 200);
});

test('healthz 无需鉴权，公开 readiness 和 BUFFERED SSE 说明', OPTIONS, async (t) => {
  let ready = false;
  const { call, run } = await fixture(t, { readiness: () => ({ ready, detail: '仅测试状态' }) });
  const unhealthy = await call({ path: '/healthz', method: 'GET', headers: { Authorization: null } });
  assert.equal(unhealthy.status, 503);
  assert.deepEqual(unhealthy.json.readiness, { ready: false, detail: '仅测试状态' });
  assert.equal(unhealthy.json.ready, false);
  assert.equal(unhealthy.json.streaming.mode, 'buffered');
  assert.match(unhealthy.json.streaming.description, /BUFFERED SSE/);
  assert.match(unhealthy.json.streaming.description, /not real-time token streaming/);
  expectError(await call(), 503, 'not_ready');
  assert.equal(run.mock.callCount(), 0);
  ready = true;
  assert.equal((await call({ path: '/healthz', method: 'GET', headers: { Authorization: null } })).status, 200);
  assert.equal((await call()).status, 200);
});

test('readiness 异常和非法状态返回通用 503，不泄漏详情', OPTIONS, async (t) => {
  const secret = '不应出现在 HTTP 响应的探针详情';
  for (const readiness of [() => { throw new Error(secret); }, () => ({ ready: 'yes' }), () => null]) {
    const { call, run } = await fixture(t, { readiness });
    for (const options of [{}, { path: '/healthz', method: 'GET' }]) {
      const response = await call(options);
      expectError(response, 503, 'readiness_failed');
      assert.equal(response.text.includes(secret), false);
    }
    assert.equal(run.mock.callCount(), 0);
  }
});

test('单并发超限返回 429 与 Retry-After，真实完成后可接收新请求', OPTIONS, async (t) => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let calls = 0;
  const { call, run } = await fixture(t, { run: async () => {
    if (++calls === 1) { started.resolve(); return gate.promise; }
    return { text: '后续回答' };
  } });
  const first = call();
  await started.promise;
  const busy = await call();
  expectError(busy, 429, 'too_many_requests');
  assert.equal(busy.headers['retry-after'], '1');
  assert.equal(run.mock.callCount(), 1);
  assert.equal((await call({ path: '/healthz', method: 'GET' })).status, 200);
  gate.resolve({ text: '首个回答' });
  assert.equal((await first).status, 200);
  assert.equal((await call()).status, 200);
});

test('maxConcurrent 配置限制实际同时运行数量', OPTIONS, async (t) => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let running = 0;
  const { call, run } = await fixture(t, { maxConcurrent: 2, run: async () => {
    if (++running === 2) started.resolve();
    return gate.promise;
  } });
  const first = call();
  const second = call();
  await started.promise;
  expectError(await call(), 429, 'too_many_requests');
  assert.equal(run.mock.callCount(), 2);
  gate.resolve({ text: '完成' });
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test('超时返回 504 并 abort，但忽略取消的 run 未结束时始终占槽', OPTIONS, async (t) => {
  const gate = Promise.withResolvers();
  let calls = 0;
  let signal;
  const { call, run } = await fixture(t, { timeoutMs: 40, run: async (input) => {
    if (++calls === 1) { signal = input.signal; return gate.promise; }
    return { text: '恢复' };
  } });
  expectError(await call(), 504, 'run_timeout');
  assert.equal(signal.aborted, true);
  for (let index = 0; index < 4; index += 1) expectError(await call(), 429, 'too_many_requests');
  assert.equal(run.mock.callCount(), 1);
  gate.reject(new Error('迟到的错误也不得泄漏或成为未处理拒绝'));
  await nextTurn();
  assert.equal((await call()).status, 200);
});

test('stream 超时返回 JSON 504，不发送成功 SSE 或 [DONE]', OPTIONS, async (t) => {
  const gate = Promise.withResolvers();
  let signal;
  const { call } = await fixture(t, { timeoutMs: 30, run: (input) => {
    signal = input.signal;
    return gate.promise;
  } });
  const response = await call({ body: { ...DEFAULT_BODY, stream: true } });
  expectError(response, 504, 'run_timeout');
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.text.includes('[DONE]'), false);
  assert.equal(signal.aborted, true);
  gate.resolve({ text: '超时后迟到的回答' });
  await nextTurn();
});

test('run 在 abort 时立即拒绝，超时仍稳定返回 504 而非 502', OPTIONS, async (t) => {
  const { call } = await fixture(t, { timeoutMs: 30, run: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
  }) });
  expectError(await call(), 504, 'run_timeout');
});

test('完整发送请求后断开连接也取消 run，run 真正结束前不释放槽位', OPTIONS, async (t) => {
  const started = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let calls = 0;
  let signal;
  const { server, call, run } = await fixture(t, { run: async (input) => {
    if (++calls === 1) {
      signal = input.signal;
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      started.resolve();
      return gate.promise;
    }
    return { text: '恢复' };
  } });
  const first = startRequest(server);
  const disconnected = first.response.catch((error) => error);
  await started.promise;
  first.req.destroy();
  await cancelled.promise;
  assert.equal(signal.aborted, true);
  for (let index = 0; index < 3; index += 1) expectError(await call(), 429, 'too_many_requests');
  assert.equal(run.mock.callCount(), 1);
  gate.resolve({ text: '取消后迟到的回答' });
  await nextTurn();
  assert.equal((await call()).status, 200);
  assert.ok(await disconnected instanceof Error);
});

test('正文上传中断不会启动 run，之后的正常请求不受影响', OPTIONS, async (t) => {
  const { server, call, run } = await fixture(t);
  const accepted = once(server, 'request');
  const pending = startRequest(server, { headersOnly: true, headers: { 'Content-Length': '1000' } });
  const disconnected = pending.response.catch((error) => error);
  await accepted;
  pending.req.write('{');
  pending.req.destroy();
  await disconnected;
  assert.equal(run.mock.callCount(), 0);
  assert.equal((await call()).status, 200);
});

test('BUFFERED SSE 等待 run 成功，输出 role/content/finish/[DONE] 并保持 Unicode', OPTIONS, async (t) => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { server } = await fixture(t, { run: async () => { started.resolve(); return gate.promise; } });
  const pending = startRequest(server, { body: { ...DEFAULT_BODY, stream: true } });
  let responseStarted = false;
  pending.req.once('response', () => { responseStarted = true; });
  await started.promise;
  await nextTurn();
  assert.equal(responseStarted, false);
  const text = `${'文'.repeat(1023)}\u{20000}\n${'更多文本'.repeat(600)}`;
  gate.resolve({ text });
  const response = await pending.response;
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream/);
  assert.equal(response.headers['x-streaming-mode'], 'buffered');
  const events = response.text.trim().split('\n\n').map((line) => {
    assert.ok(line.startsWith('data: '));
    return line.slice(6);
  });
  assert.equal(events.pop(), '[DONE]');
  const chunks = events.map((event) => JSON.parse(event));
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
  assert.deepEqual(chunks.at(-1).choices[0], { index: 0, delta: {}, finish_reason: 'stop' });
  assert.ok(chunks.length > 3);
  assert.equal(chunks.slice(1, -1).map((chunk) => chunk.choices[0].delta.content).join(''), text);
  for (const chunk of chunks) {
    assert.equal(chunk.id, chunks[0].id);
    assert.equal(chunk.created, chunks[0].created);
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.model, 'minimax-code');
    assert.equal(Object.hasOwn(chunk, 'usage'), false);
    assert.doesNotMatch(chunk.choices[0].delta.content ?? '', /[\uD800-\uDFFF]/u);
  }
  for (const chunk of chunks.slice(0, -1)) assert.equal(chunk.choices[0].finish_reason, null);
});

test('空文本 SSE 仍包含 role、finish 和 [DONE]', OPTIONS, async (t) => {
  const { call } = await fixture(t, { run: async () => ({ text: '' }) });
  const response = await call({ body: { ...DEFAULT_BODY, stream: true } });
  assert.equal(response.status, 200);
  assert.equal(response.text.trim().split('\n\n').length, 3);
  assert.match(response.text, /"finish_reason":"stop"/);
  assert.ok(response.text.endsWith('data: [DONE]\n\n'));
});

test('同步与异步 run 错误均隐藏详情，stream 失败时不提前发送 SSE', OPTIONS, async (t) => {
  const secret = '敏感正文与内部路径以及密钥不应泄漏';
  for (const run of [() => { throw new Error(`${secret}:${API_KEY}`); }, async () => { throw new Error(`${secret}:${API_KEY}`); }]) {
    const { call } = await fixture(t, { run });
    for (const stream of [false, true]) {
      const response = await call({ body: { ...DEFAULT_BODY, stream } });
      expectError(response, 502, 'run_failed');
      assert.match(response.headers['content-type'], /^application\/json/);
      assert.equal(response.text.includes(secret), false);
      assert.equal(response.text.includes(API_KEY), false);
      assert.equal(response.text.includes('[DONE]'), false);
    }
  }
});

test('非法 run 结果不伪装成功，也不伪造 token 计数', OPTIONS, async (t) => {
  for (const result of [undefined, null, {}, { text: 4 }, { text: '内容', usage: {} }, { text: '内容', usage: { prompt_tokens: -1, completion_tokens: 0, total_tokens: 0 } }]) {
    const { call } = await fixture(t, { run: async () => result });
    expectError(await call(), 502, 'invalid_run_result');
  }
});

test('HTTP 解析错误也带 no-store 和 nosniff，不反射请求内容', OPTIONS, async (t) => {
  const { server, run } = await fixture(t);
  const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
  t.after(() => socket.destroy());
  socket.setEncoding('utf8');
  socket.setTimeout(5000, () => socket.destroy(new Error('测试原始 HTTP 超时')));
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  await once(socket, 'connect');
  const ended = once(socket, 'end');
  socket.end('INVALID\u0000METHOD / HTTP/1.1\r\nHost: secret.invalid\r\n\r\n');
  await ended;
  const response = chunks.join('');
  assert.match(response, /^HTTP\/1.1 400 /);
  assert.match(response, /Cache-Control: no-store/i);
  assert.match(response, /X-Content-Type-Options: nosniff/i);
  assert.equal(response.includes('secret.invalid'), false);
  assert.equal(run.mock.callCount(), 0);
});
