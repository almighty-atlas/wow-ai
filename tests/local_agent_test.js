'use strict';
// The Local LLM agent: bridge/openai_agent.js against a mock OpenAI-compatible
// server on 127.0.0.1. Most tests spawn the real script, feed it the JSON the
// bridge would and read its stdout back through the agents.js parser, so the
// whole path is covered. Nothing leaves the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const A = require('../bridge/agents');
const O = require('../bridge/openai_agent');

const SCRIPT = path.join(__dirname, '..', 'bridge', 'openai_agent.js');
const SECRET = 'sk-test-SECRET-0123456789';
const dirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-local-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A server whose handler(req, body, res) decides the answer; `seen` records every request.
async function mockServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      const entry = { method: req.method, url: req.url, headers: req.headers, body, raw };
      seen.push(entry);
      handler(entry, res, seen.length);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  return { base, seen, server, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); } };
}

function reply(res, content, extra = {}) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }] }));
}
const echo = (n) => (req, res) => reply(res, `answer ${n || req.body.messages.length}`);

// Spawns the script like the bridge does and parses its stdout with the agents.js parser.
function runAgent(input, { env, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code, signal) => {
      const parser = A.AGENTS.local.parser();
      const acc = { session: '', progress: [], notes: [], done: null };
      for (const line of stdout.split('\n').filter(Boolean)) {
        const r = parser.feed(JSON.parse(line));
        if (r.session) acc.session = r.session;
        acc.progress.push(...r.progress);
        acc.notes.push(...r.notes);
        if (r.done) acc.done = r.done;
      }
      resolve({ ...acc, code, signal, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
    if (onSpawn) onSpawn(child);
  });
}

// Same turn without the spawn, for the cases that only need the events.
async function runInProc(input) {
  const events = [];
  await O.run(input, ev => events.push(ev));
  return { events, stdout: events.map(e => JSON.stringify(e)).join('\n'), done: events.find(e => e.type === 'result') };
}

const base = (srv, dir, extra = {}) => ({ prompt: 'hi', system: 'SYSTEM', baseUrl: srv.base, model: 'm1', sessionsDir: dir, ...extra });

test('a new conversation: session id emitted, reply returned, history file written', async () => {
  const srv = await mockServer(echo());
  const dir = tmpDir();
  try {
    const r = await runAgent(base(srv, dir, { prompt: 'hello there' }));
    assert.equal(r.code, 0);
    assert.deepEqual(r.done, { text: 'answer 2', error: false });
    assert.ok(O.isSessionId(r.session));
    assert.equal(srv.seen[0].method, 'POST');
    assert.equal(srv.seen[0].url, '/v1/chat/completions');
    assert.equal(srv.seen[0].body.model, 'm1');
    assert.equal(srv.seen[0].body.stream, false);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, r.session + '.json'), 'utf8'));
    assert.deepEqual(stored.messages, [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'answer 2' }]);
    assert.deepEqual(fs.readdirSync(dir), [r.session + '.json']); // no tmp file left behind
    assert.ok(r.progress.some(p => /m1/.test(p)));
  } finally { await srv.close(); }
});

test('a resumed conversation carries earlier turns, and sessions stay apart', async () => {
  const srv = await mockServer(echo());
  const dir = tmpDir();
  try {
    const a1 = await runAgent(base(srv, dir, { prompt: 'A one' }));
    const b1 = await runAgent(base(srv, dir, { prompt: 'B one' }));
    assert.notEqual(a1.session, b1.session);
    const a2 = await runAgent(base(srv, dir, { prompt: 'A two', resume: a1.session }));
    assert.equal(a2.session, a1.session);
    assert.deepEqual(srv.seen[2].body.messages.map(m => [m.role, m.content]), [
      ['system', 'SYSTEM'], ['user', 'A one'], ['assistant', 'answer 2'], ['user', 'A two'],
    ]);
    assert.ok(!srv.seen[2].raw.includes('B one'));
    const b2 = await runAgent(base(srv, dir, { prompt: 'B two', resume: b1.session }));
    assert.ok(!srv.seen[3].raw.includes('A one') && srv.seen[3].raw.includes('B one'));
    assert.equal(b2.done.error, false);
  } finally { await srv.close(); }
});

test('the current system prompt leads every request and is never stored', async () => {
  const srv = await mockServer(echo());
  const dir = tmpDir();
  try {
    const first = await runAgent(base(srv, dir, { system: 'CONTEXT v1' }));
    await runAgent(base(srv, dir, { system: 'CONTEXT v2', resume: first.session }));
    assert.deepEqual(srv.seen[0].body.messages[0], { role: 'system', content: 'CONTEXT v1' });
    assert.deepEqual(srv.seen[1].body.messages[0], { role: 'system', content: 'CONTEXT v2' });
    assert.equal(srv.seen[1].body.messages.filter(m => m.role === 'system').length, 1);
    assert.ok(!fs.readFileSync(path.join(dir, first.session + '.json'), 'utf8').includes('CONTEXT'));
    await runAgent(base(srv, dir, { system: '' }));
    assert.equal(srv.seen[2].body.messages[0].role, 'user');
  } finally { await srv.close(); }
});

test('a missing or corrupt history on resume starts fresh under the same id, with a note', async () => {
  const srv = await mockServer(echo());
  const dir = tmpDir();
  try {
    const id = '11111111-2222-4333-8444-555555555555';
    const r = await runAgent(base(srv, dir, { resume: id }));
    assert.equal(r.session, id);
    assert.ok(r.notes.some(n => /starts fresh/.test(n)));
    assert.equal(srv.seen[0].body.messages.length, 2);
    fs.writeFileSync(path.join(dir, id + '.json'), '{not json');
    const r2 = await runAgent(base(srv, dir, { resume: id }));
    assert.ok(r2.notes.some(n => /starts fresh/.test(n)));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')).messages.length, 2);
  } finally { await srv.close(); }
});

test('a resume id that is not a UUID never touches the filesystem path', async () => {
  const srv = await mockServer(echo());
  const dir = tmpDir();
  try {
    const r = await runAgent(base(srv, dir, { resume: '../../etc/passwd' }));
    assert.ok(O.isSessionId(r.session));
    assert.ok(r.notes.some(n => /new conversation/.test(n)));
    assert.deepEqual(fs.readdirSync(dir), [r.session + '.json']);
    assert.throws(() => O.sessionFile(dir, '../x'), /invalid session id/);
    assert.equal(O.isSessionId('abc'), false);
  } finally { await srv.close(); }
});

test('maxHistoryMessages drops the oldest pairs first', async () => {
  const srv = await mockServer(echo());
  const dir = tmpDir();
  try {
    let id = '';
    for (const p of ['p1', 'p2', 'p3']) id = (await runAgent(base(srv, dir, { prompt: p, resume: id, maxHistoryMessages: 4 }))).session;
    assert.deepEqual(srv.seen[2].body.messages.map(m => m.content), ['SYSTEM', 'p1', 'answer 2', 'p2', 'answer 4', 'p3']);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')).messages;
    assert.deepEqual(stored.map(m => m.content), ['p2', 'answer 4', 'p3', 'answer 6']);
    assert.ok(stored.length <= 4 && stored[0].role === 'user');
  } finally { await srv.close(); }
});

test('a failed first turn leaves no session id behind; a successful one announces it after saving', async () => {
  let fail = true;
  const srv = await mockServer((req, res) => { if (fail) { res.statusCode = 404; res.end('{"error":{"message":"model not found"}}'); } else reply(res, 'ok'); });
  const dir = tmpDir();
  try {
    const bad = await runAgent(base(srv, dir));
    assert.equal(bad.done.error, true);
    assert.equal(bad.session, '');
    fail = false;
    const good = await runAgent(base(srv, dir));
    assert.ok(O.isSessionId(good.session));
    assert.deepEqual(good.notes, []);
    assert.ok(fs.existsSync(path.join(dir, good.session + '.json')));
    const next = await runAgent(base(srv, dir, { resume: good.session }));
    assert.equal(next.session, good.session);
    assert.deepEqual(next.notes, []);
  } finally { await srv.close(); }
});

test('a key pasted into apiKeyEnv is never echoed, only real variable names are', async () => {
  const srv = await mockServer(echo());
  try {
    const r = await runInProc(base(srv, tmpDir(), { apiKeyEnv: SECRET }));
    assert.ok(!r.stdout.includes(SECRET));
    assert.ok(r.events.some(e => e.type === 'note' && /name of an environment variable/.test(e.text)));
    assert.equal(srv.seen[0].headers.authorization, undefined);
    const named = await runInProc(base(srv, tmpDir(), { apiKeyEnv: 'WOWAI_TEST_UNSET' }));
    assert.ok(named.stdout.includes('WOWAI_TEST_UNSET'));
  } finally { await srv.close(); }
});

test('requestTimeoutMs is clamped to what timers accept; short timeouts are shown in ms', async () => {
  assert.equal(O.timeoutFrom(2 ** 31), 2 ** 31 - 1);
  assert.equal(O.timeoutFrom(2 ** 33), 2 ** 31 - 1);
  assert.equal(O.timeoutFrom(1500.9), 1500);
  for (const bad of [0, -5, NaN, 'x', undefined, null, 0.5, Infinity]) assert.equal(O.timeoutFrom(bad), O.DEFAULT_TIMEOUT_MS, String(bad));
  const srv = await mockServer(() => {});
  try {
    const r = await runInProc(base(srv, tmpDir(), { requestTimeoutMs: 150 }));
    assert.match(r.done.text, /did not answer within 150 ms/);
    const big = await runInProc(base(srv, tmpDir(), { requestTimeoutMs: 2 ** 32 + 5, baseUrl: 'http://127.0.0.1:1/v1' }));
    assert.doesNotMatch(big.done.text, /ERR_OUT_OF_RANGE|Overflow/);
  } finally { await srv.close(); }
});

test('a relative sessionsDir is the bridge folder\'s, not the working directory\'s', async () => {
  const srv = await mockServer(echo());
  const rel = path.join('..', 'tests', 'tmp', 'rel-sessions-' + process.pid);
  const abs = path.resolve(__dirname, '..', 'bridge', rel);
  try {
    const r = await runAgent(base(srv, rel), {});
    assert.ok(fs.existsSync(path.join(abs, r.session + '.json')));
  } finally { fs.rmSync(abs, { recursive: true, force: true }); await srv.close(); }
});

test('a stop by the bridge says so', { skip: process.platform === 'win32' }, async () => {
  let got; const arrived = new Promise(r => { got = r; });
  const srv = await mockServer(() => got());
  try {
    const r = await runAgent(base(srv, tmpDir()), { onSpawn: c => arrived.then(() => c.kill('SIGTERM')) });
    assert.match(r.done.text, /Stopped by the bridge/);
  } finally { await srv.close(); }
});

test('stdout carries only ASCII, so a long multibyte reply survives chunked decoding', async () => {
  const text = 'héllo — 世界 😀 '.repeat(20000); // ~400 KB, one line
  const srv = await mockServer((req, res) => reply(res, text));
  try {
    const r = await runAgent(base(srv, tmpDir()));
    assert.ok(/^[\x00-\x7f]*$/.test(r.stdout));
    assert.equal(r.done.text, text);
    assert.equal(O.asciiJson({ t: '\u2028é😀' }), '{"t":"\\u2028\\u00e9\\ud83d\\ude00"}');
  } finally { await srv.close(); }
});

test('setup.js can describe the local agent, and an unparsable baseUrl shows an example', () => {
  const r = A.resolveCommand('local', {});
  assert.ok(A.AGENTS.local.install && !r.found);
  assert.throws(() => O.chatCompletionsUrl('nonsense'), /http:\/\/<host>:11434\/v1/);
});

test('trimHistory keeps whole pairs and starts on a user turn', () => {
  const h = [1, 2, 3].flatMap(i => [{ role: 'user', content: 'u' + i }, { role: 'assistant', content: 'a' + i }]);
  assert.deepEqual(O.trimHistory(h, 4).map(m => m.content), ['u2', 'a2', 'u3', 'a3']);
  assert.deepEqual(O.trimHistory(h, 5).map(m => m.content), ['u2', 'a2', 'u3', 'a3']);
  assert.deepEqual(O.trimHistory(h, 0), []);
  assert.equal(O.trimHistory(h, 100).length, 6);
});

test('the API key: Bearer header from apiKey or apiKeyEnv, absent without, never in output', async () => {
  const srv = await mockServer(echo());
  const dir = tmpDir();
  try {
    const none = await runAgent(base(srv, dir));
    assert.equal(srv.seen[0].headers.authorization, undefined);
    const direct = await runAgent(base(srv, dir, { apiKey: SECRET }));
    assert.equal(srv.seen[1].headers.authorization, `Bearer ${SECRET}`);
    const viaEnv = await runAgent(base(srv, dir, { apiKeyEnv: 'WOWAI_TEST_KEY' }), { env: { WOWAI_TEST_KEY: SECRET + '-env' } });
    assert.equal(srv.seen[2].headers.authorization, `Bearer ${SECRET}-env`);
    const envWins = await runAgent(base(srv, dir, { apiKey: 'sk-from-config-1234', apiKeyEnv: 'WOWAI_TEST_KEY' }), { env: { WOWAI_TEST_KEY: SECRET + '-env' } });
    assert.equal(srv.seen[3].headers.authorization, `Bearer ${SECRET}-env`);
    const unsetEnv = await runAgent(base(srv, dir, { apiKeyEnv: 'WOWAI_TEST_UNSET' }));
    assert.equal(srv.seen[4].headers.authorization, undefined);
    assert.ok(unsetEnv.notes.some(n => /WOWAI_TEST_UNSET/.test(n)));
    for (const r of [none, direct, viaEnv, envWins]) assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  } finally { await srv.close(); }
});

test('extraBody tunes the request but cannot replace model, messages or stream; headers are sent', async () => {
  const srv = await mockServer(echo());
  const dir = tmpDir();
  try {
    await runAgent(base(srv, dir, { extraBody: { temperature: 0.2, model: 'evil', messages: [], stream: true }, headers: { 'X-Test': 'yes-please' } }));
    const b = srv.seen[0].body;
    assert.equal(b.temperature, 0.2);
    assert.equal(b.model, 'm1');
    assert.equal(b.stream, false);
    assert.equal(b.messages.length, 2);
    assert.equal(srv.seen[0].headers['x-test'], 'yes-please');
  } finally { await srv.close(); }
});

test('errors: unknown model (404), server error, auth failure, bad JSON, no choices, empty reply', async () => {
  const dir = tmpDir();
  const cases = [
    [(req, res) => { res.statusCode = 404; res.end(JSON.stringify({ error: { message: "model 'nope' not found" } })); }, /HTTP 404.*model 'nope' not found[\s\S]*ollama list[\s\S]*ollama pull/],
    [(req, res) => { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'The model `x` does not exist' } })); }, /ollama list/],
    [(req, res) => { res.statusCode = 500; res.end('internal kaboom'); }, /HTTP 500: internal kaboom/],
    [(req, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { message: `bad key ${SECRET}` } })); }, /authentication failed[\s\S]*apiKey/],
    [(req, res) => { res.statusCode = 403; res.end('{}'); }, /HTTP 403.*authentication/],
    [(req, res) => { res.end('<html>not json</html>'); }, /not JSON/],
    [(req, res) => { res.end(JSON.stringify({ choices: [] })); }, /choices\[0\]\.message\.content/],
    [(req, res) => { res.end(JSON.stringify({ id: 'x' })); }, /choices\[0\]\.message\.content/],
    [(req, res) => { res.end(JSON.stringify({ error: { message: 'overloaded' } })); }, /overloaded/],
    [(req, res) => reply(res, ''), /empty reply/],
    [(req, res) => reply(res, '<think>musing</think>'), /empty reply/],
    [(req, res) => reply(res, '', { finish_reason: 'length' }), /token budget/],
  ];
  for (const [handler, expected] of cases) {
    const srv = await mockServer(handler);
    try {
      const r = await runInProc(base(srv, dir, { apiKey: SECRET }));
      assert.equal(r.done.error, true, expected.source);
      assert.match(r.done.text, expected);
      assert.ok(!r.stdout.includes(SECRET), 'key leaked: ' + expected.source);
      assert.deepEqual(fs.readdirSync(dir), [], 'a failed turn must not save history');
    } finally { await srv.close(); }
  }
});

test('an unreachable server names host:port, not the key', async () => {
  const probe = http.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const r = await runAgent({ prompt: 'hi', baseUrl: `http://user:pw@127.0.0.1:${port}/v1?key=${SECRET}`, model: 'm', apiKey: SECRET, sessionsDir: tmpDir() });
  assert.equal(r.done.error, true);
  assert.match(r.done.text, new RegExp(`127\\.0\\.0\\.1:${port}.*ECONNREFUSED`));
  assert.ok(!r.stdout.includes(SECRET) && !r.stdout.includes('pw@'));
});

test('a request that gets no answer times out with a clear message', async () => {
  const srv = await mockServer(() => {});
  try {
    const t0 = Date.now();
    const r = await runAgent(base(srv, tmpDir(), { requestTimeoutMs: 300 }));
    assert.equal(r.done.error, true);
    assert.match(r.done.text, /did not answer within 300 ms.*requestTimeoutMs/);
    assert.ok(Date.now() - t0 < 4000);
  } finally { await srv.close(); }
});

test('SIGTERM from the bridge aborts the request, exits promptly and saves nothing', { skip: process.platform === 'win32' }, async () => {
  let gotRequest;
  const arrived = new Promise(r => { gotRequest = r; });
  const srv = await mockServer(() => gotRequest());
  const dir = tmpDir();
  try {
    const t0 = Date.now();
    const r = await runAgent(base(srv, dir), { onSpawn: (child) => arrived.then(() => child.kill('SIGTERM')) });
    assert.equal(r.done.error, true);
    assert.match(r.done.text, /Stopped by the bridge/);
    assert.ok(Date.now() - t0 < 3000);
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  } finally { await srv.close(); }
});

test('finish_reason "length" adds a note; a leading <think> block and reasoning fields are dropped', async () => {
  const srv = await mockServer((req, res, n) => {
    if (n === 1) return reply(res, 'partial', { finish_reason: 'length' });
    res.end(JSON.stringify({ choices: [{ message: { content: '<think>hmm</think>\n\nThe answer.', reasoning: 'SECRET THOUGHT', reasoning_content: 'MORE' }, finish_reason: 'stop' }] }));
  });
  const dir = tmpDir();
  try {
    const cut = await runAgent(base(srv, dir));
    assert.equal(cut.done.text, 'partial');
    assert.ok(cut.notes.some(n => /cut off/.test(n)));
    const think = await runAgent(base(srv, dir));
    assert.equal(think.done.text, 'The answer.');
    assert.ok(!think.stdout.includes('THOUGHT') && !think.stdout.includes('MORE'));
  } finally { await srv.close(); }
});

test('masking: secret headers and long keys in errors; placeholder keys, plain headers and replies untouched', async () => {
  const dir = tmpDir();
  const said = 'Install ollama, then run ollama serve. Accept: application/json';
  const ok = await mockServer((req, res) => reply(res, `${said} ${SECRET}`));
  try {
    const r = await runInProc(base(ok, dir, { apiKey: 'ollama', headers: { Accept: 'application/json' } }));
    assert.equal(r.done.error, false);
    assert.equal(r.done.text, `${said} ${SECRET}`);
  } finally { await ok.close(); }
  const notFound = await mockServer((req, res) => { res.statusCode = 404; res.end(JSON.stringify({ error: { message: `no model; got key ${SECRET} and X-Api-Key ${SECRET}-hdr` } })); });
  try {
    const r = await runInProc(base(notFound, dir, { apiKey: 'ollama', headers: { 'X-Api-Key': SECRET + '-hdr', Accept: 'application/json' } }));
    assert.equal(r.done.error, true);
    assert.match(r.done.text, /ollama list/);
    assert.ok(!r.done.text.includes(SECRET + '-hdr'));
    const r2 = await runInProc(base(notFound, dir, { apiKey: SECRET }));
    assert.ok(!r2.done.text.includes(SECRET));
  } finally { await notFound.close(); }
});

test('the transport: no 300 s header limit of its own, and a body cut short is an error, not a hang', async () => {
  const srv = await mockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    res.write('{"choices":');
    setTimeout(() => res.destroy(), 50);
  });
  try {
    const t0 = Date.now();
    const r = await runAgent(base(srv, tmpDir()));
    assert.equal(r.done.error, true);
    assert.match(r.done.text, /ECONNRESET|closed/);
    assert.ok(Date.now() - t0 < 4000);
  } finally { await srv.close(); }
  // The default transport is plain http, not fetch (whose undici agent stops waiting for headers after 300 s).
  const seen = [];
  const plain = await mockServer((req, res) => { seen.push(req); reply(res, 'hi there'); });
  try {
    const res = await O.post(`${plain.base}/chat/completions`, { headers: { 'Content-Type': 'application/json' }, body: '{"x":"é"}' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /hi there/);
    assert.equal(seen[0].raw, '{"x":"é"}');
    assert.equal(seen[0].headers['content-length'], String(Buffer.byteLength('{"x":"é"}')));
  } finally { await plain.close(); }
});

test('the reply is returned unchanged, so TL;DR and macro blocks survive', async () => {
  const text = 'Do this.\n\n```wowmacro Hi\n/say hi\n```\n\nTL;DR: say hi';
  const srv = await mockServer((req, res) => reply(res, text));
  try {
    assert.equal((await runAgent(base(srv, tmpDir()))).done.text, text);
  } finally { await srv.close(); }
});

test('chatCompletionsUrl normalizes the base URL and strips credentials and query', () => {
  const want = 'http://h:11434/v1/chat/completions';
  for (const u of ['http://h:11434/v1', 'http://h:11434/v1/', 'http://h:11434/v1//', 'http://h:11434/v1/chat/completions', 'http://h:11434/v1/chat/completions/', ' http://h:11434/v1 ', 'http://u:p@h:11434/v1?k=1#x']) {
    assert.equal(O.chatCompletionsUrl(u), want, u);
  }
  assert.equal(O.chatCompletionsUrl('https://api.example.com'), 'https://api.example.com/chat/completions');
  assert.throws(() => O.chatCompletionsUrl('localhost:11434'), /http/);
  assert.throws(() => O.chatCompletionsUrl('ftp://h/v1'), /http:\/\/ or https:\/\//);
  assert.throws(() => O.chatCompletionsUrl(''), /not a valid URL/);
  assert.equal(O.safeUrl('http://u:p@h:1/v1?key=abc#f'), 'http://h:1/v1');
});

test('resolveCommand: the script agent is found when configured, explained when not', () => {
  const ok = A.resolveCommand('local', { baseUrl: 'http://h:11434/v1', model: 'm' });
  assert.deepEqual([ok.file, ok.args, ok.found], [process.execPath, [SCRIPT], true]);
  for (const cfg of [{}, { baseUrl: 'http://h/v1' }, { model: 'm' }]) {
    const r = A.resolveCommand('local', cfg);
    assert.equal(r.found, false);
    assert.match(r.note, /set agents\.local\.baseUrl and agents\.local\.model in config\.json/);
    assert.match(r.message, /Local LLM is not configured/);
  }
  assert.equal(A.resolveCommand('local', { baseUrl: 'nonsense', model: 'm' }).found, false);
  assert.match(A.AGENTS.local.describe({ baseUrl: 'http://u:p@h:11434/v1?k=1', model: 'm' }), /^http:\/\/h:11434\/v1\/chat\/completions {2}\[model m, chat only\]$/);
});

test('input() puts the settings on stdin and nothing secret in argv', () => {
  const cfg = { baseUrl: 'http://h/v1', model: 'm', apiKey: SECRET, maxHistoryMessages: 6 };
  const input = A.AGENTS.local.input({ prompt: 'p', system: 'S', systemShort: 's', resume: 'r', cfg });
  const sent = JSON.parse(input.stdin);
  assert.deepEqual([sent.prompt, sent.system, sent.resume, sent.apiKey, sent.maxHistoryMessages], ['p', 'S', 'r', SECRET, 6]);
  assert.deepEqual(A.AGENTS.local.args({ cfg, resume: 'r', system: 'S' }), []);
  assert.equal(A.normalizeAgent('Local'), 'local');
  assert.equal(A.displayName('local'), 'Local LLM');
});

test('localParser maps the script\'s lines onto the shared accumulator and ignores the rest', () => {
  const p = A.localParser();
  assert.equal(p.feed({ type: 'session', id: 'abc' }).session, 'abc');
  assert.deepEqual(p.feed({ type: 'progress', text: 'asking m' }).progress, ['asking m']);
  assert.deepEqual(p.feed({ type: 'note', text: 'careful' }).notes, ['careful']);
  assert.deepEqual(p.feed({ type: 'result', text: 'hi', error: false }).done, { text: 'hi', error: false });
  assert.equal(p.feed({ type: 'result', text: 'bad', error: true }).done.error, true);
  const other = p.feed({ type: 'future' });
  assert.deepEqual([other.progress, other.denied, other.notes, other.done], [[], [], [], undefined]);
});

test('protocol accepts the local agent id in the strip flag and the outbox', () => {
  const P = require('../bridge/protocol');
  assert.equal(P.parseFlags('n;agent=local').agent, 'local');
  assert.match('["agent"] = "local"', /\["agent"\]\s*=\s*"([0-9a-zA-Z_-]*)"/);
});
