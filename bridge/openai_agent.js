'use strict';
// The "Local LLM" agent: one chat turn against any OpenAI-compatible server
// (Ollama, LM Studio, llama.cpp, vLLM, ...). The bridge's agent interface is
// process based, so this is a small script the bridge spawns like any CLI:
//
//   stdin   one JSON object: { prompt, system, resume, baseUrl, model, apiKey, ... }
//   stdout  JSON lines: {"type":"session","id"} {"type":"progress","text"}
//           {"type":"note","text"} {"type":"result","text","error"}
//
// The settings (including the API key) arrive on stdin and never on the command
// line, where any process list could read them. Chat only: no tools, no files,
// non-streaming. The server has no memory of its own, so the conversation is
// kept here, one file per session, and sent again with every request.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_HISTORY = 40;
const SESSIONS_DIR = path.join(__dirname, 'local-sessions');
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // timers beyond this fire at once
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Shorter keys are placeholders ("ollama", "lm-studio") that also occur in
// ordinary text, so masking them would garble messages and protect nothing.
const MIN_SECRET = 12;
const SECRET_HEADER = /auth|key|token|secret|cookie/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A failure with a message fit to show the user as it is.
class AgentError extends Error {}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

// The chat completions URL for a configured base URL: with or without a
// trailing slash, and tolerating one that already ends in /chat/completions.
// Userinfo and query are dropped (credentials belong in apiKey, and neither
// belongs in a log). Throws AgentError when it is not an http(s) URL.
function chatCompletionsUrl(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl || '').trim()); } catch { throw new AgentError(`agents.local.baseUrl is not a valid URL (expected something like http://<host>:11434/v1): ${safeUrl(baseUrl)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AgentError('agents.local.baseUrl must start with http:// or https://');
  u.username = ''; u.password = ''; u.search = ''; u.hash = '';
  const p = u.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  u.pathname = p + '/chat/completions';
  return u.toString();
}

// A URL as it may be shown or logged: no userinfo, no query, no fragment.
function safeUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparsable URL)';
  }
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function isSessionId(id) { return typeof id === 'string' && UUID.test(id); }

// The id is validated before it becomes part of a path: no separators, no dots.
function sessionFile(dir, id) {
  if (!isSessionId(id)) throw new AgentError('invalid session id');
  return path.join(dir, id.toLowerCase() + '.json');
}

// The stored turns of a session, or null when there is no usable file.
function loadHistory(dir, id) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(sessionFile(dir, id), 'utf8')); } catch { return null; }
  const msgs = doc && Array.isArray(doc.messages) ? doc.messages : null;
  if (!msgs) return null;
  const ok = msgs.every(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  return ok ? msgs.map(m => ({ role: m.role, content: m.content })) : null;
}

// Write-then-rename, so a crash or a kill never leaves half a file.
function saveHistory(dir, id, messages) {
  const file = sessionFile(dir, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, id: id.toLowerCase(), updated: new Date().toISOString(), messages }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// At most `max` messages, dropping the oldest user/assistant pairs first and
// never starting on an assistant turn.
function trimHistory(messages, max) {
  const limit = Math.max(0, Math.floor(Number.isFinite(max) ? max : DEFAULT_MAX_HISTORY));
  let out = messages.slice();
  while (out.length > limit) out = out.slice(2);
  while (out.length && out[0].role !== 'user') out = out.slice(1);
  return out;
}

// The system prompt is sent fresh every time and never stored, so the game
// context a request carries is always the current one.
function buildMessages(system, history, prompt) {
  const msgs = [];
  if (system && String(system).trim()) msgs.push({ role: 'system', content: String(system) });
  return msgs.concat(history, [{ role: 'user', content: String(prompt) }]);
}

// extraBody may tune the request (temperature, max_tokens, ...) but never
// replaces what the bridge sends, and this agent is non-streaming.
function buildBody(model, messages, extraBody) {
  const extra = extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : {};
  return { ...extra, model, messages, stream: false };
}

// ---------------------------------------------------------------------------
// Responses and errors
// ---------------------------------------------------------------------------

// Reasoning models sometimes put their thinking inline; only the answer counts.
function stripThink(text) {
  const s = String(text);
  if (!/^\s*<think>/i.test(s)) return s;
  const end = s.search(/<\/think>/i);
  return end < 0 ? '' : s.slice(end + '</think>'.length).replace(/^\s+/, '');
}

function truncate(s, n) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '...' : t;
}

// The message a server put in an error body ({error:{message}}, {error:"..."},
// {message}), or the start of the body when it is something else.
function serverMessage(text) {
  try {
    const j = JSON.parse(text);
    const m = j && ((j.error && (j.error.message || (typeof j.error === 'string' && j.error))) || j.message);
    if (typeof m === 'string' && m.trim()) return truncate(m, 300);
  } catch {}
  return truncate(text, 300);
}

function httpError(status, text, host) {
  const msg = serverMessage(text);
  if (status === 401 || status === 403) {
    return new AgentError(`${host} refused the request (HTTP ${status}): authentication failed. Check agents.local.apiKey or apiKeyEnv.${msg ? ' Server said: ' + msg : ''}`);
  }
  if (status === 404 || (status >= 400 && status < 500 && /model/i.test(msg) && /not found|does not exist|unknown|not exist|no such/i.test(msg))) {
    return new AgentError(`${host} answered HTTP ${status}${msg ? ': ' + msg : ''}\nCheck agents.local.model and baseUrl. On Ollama, \`ollama list\` shows the models the server has and \`ollama pull <model>\` fetches one.`);
  }
  return new AgentError(`${host} answered HTTP ${status}${msg ? ': ' + msg : ''}`);
}

// The reply out of a parsed completion. reasoning / reasoning_content fields
// are deliberately not read.
function extractReply(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : undefined;
  if (typeof content !== 'string') {
    throw new AgentError('The server\'s reply has no choices[0].message.content: it may not be an OpenAI-compatible /chat/completions endpoint.');
  }
  return { text: stripThink(content), finish: choice.finish_reason || '' };
}

const NETWORK_HINT = {
  ECONNREFUSED: 'connection refused. Is the server running, and is the port right?',
  ENOTFOUND: 'the host name could not be resolved.',
  EAI_AGAIN: 'the host name could not be resolved.',
  EHOSTUNREACH: 'the host is unreachable.',
  ENETUNREACH: 'the network is unreachable.',
  ETIMEDOUT: 'the connection timed out.',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out.',
  ECONNRESET: 'the connection was closed by the server.',
  UND_ERR_SOCKET: 'the connection was closed by the server.',
};

function networkError(err, host) {
  const cause = err && err.cause ? err.cause : err;
  const code = (cause && cause.code) || (err && err.code) || '';
  if (NETWORK_HINT[code]) return new AgentError(`Cannot reach the server at ${host} (${code}): ${NETWORK_HINT[code]} Check agents.local.baseUrl.`);
  const detail = (cause && cause.message) || (err && err.message) || String(err);
  return new AgentError(`The request to ${host} failed: ${truncate(detail, 200)}`);
}

const STOPPED = 'Stopped by the bridge before the server answered (timeoutMs in config.json, or the bridge was shut down).';

// A usable timer length: positive, finite, whole milliseconds, within what timers allow.
function timeoutFrom(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

// JSON with every non-ASCII character escaped. The bridge decodes stdout chunk by
// chunk, which would break a multibyte character split across two chunks of a
// long single-line reply; ASCII survives any split.
function asciiJson(ev) {
  return JSON.stringify(ev).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// A fetch-shaped POST over plain http/https. Node's fetch gives up when the
// response headers take longer than 300 s (undici's headersTimeout), and a
// non-streaming server sends none until the whole reply is generated, which a
// large model on a CPU can exceed; here requestTimeoutMs is the only limit.
function post(url, { method = 'POST', headers = {}, body = '', signal } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, signal }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text: async () => text });
      });
      res.on('error', reject);
      // A connection dropped mid-body ends nothing; without this the turn would hang.
      res.on('close', () => { if (!res.complete) reject(Object.assign(new Error('the connection closed before the reply was complete'), { code: 'ECONNRESET' })); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

// Runs one turn and reports through emit(obj). `fetchImpl` and `signal` exist
// for tests and for the SIGTERM handler; a cancelled turn saves nothing.
async function run(input, emit, { fetchImpl = post, signal } = {}) {
  const secrets = [];
  // A key can only come back in an error or note (a server echoing what it
  // refused); the model's reply is passed on as it is.
  const say = (ev) => {
    if (ev.type !== 'result' || ev.error) for (const k of ['text', 'id']) {
      if (typeof ev[k] === 'string') for (const s of secrets) ev[k] = ev[k].split(s).join('***');
    }
    emit(ev);
  };
  const fail = (text) => say({ type: 'result', text, error: true });
  try {
    const cfg = input || {};
    const url = chatCompletionsUrl(cfg.baseUrl);
    const model = String(cfg.model || '').trim();
    if (!model) throw new AgentError('agents.local.model is not set in config.json.');
    const host = new URL(url).host;

    let apiKey = '';
    const envName = String(cfg.apiKeyEnv || '').trim();
    const envOk = ENV_NAME.test(envName);
    // A key pasted where a variable name belongs must never be echoed back.
    if (envName && !envOk) secrets.push(envName);
    if (envOk && process.env[envName]) apiKey = process.env[envName];
    else if (typeof cfg.apiKey === 'string') apiKey = cfg.apiKey.trim();
    if (!apiKey && envName) {
      say({ type: 'note', text: envOk
        ? `agents.local.apiKeyEnv names ${envName}, which is not set in the bridge's environment; sent without an API key.`
        : 'agents.local.apiKeyEnv must be the name of an environment variable, not the key itself; sent without an API key.' });
    }
    const headers = {};
    if (cfg.headers && typeof cfg.headers === 'object') {
      for (const [k, v] of Object.entries(cfg.headers)) if (typeof v === 'string') { headers[k] = v; if (SECRET_HEADER.test(k) && v.length >= MIN_SECRET) secrets.push(v); }
    }
    if (apiKey.length >= MIN_SECRET) secrets.push(apiKey);

    // Relative paths are the bridge folder's: the child runs in the chat's project folder.
    const dir = typeof cfg.sessionsDir === 'string' && cfg.sessionsDir ? path.resolve(__dirname, cfg.sessionsDir) : SESSIONS_DIR;
    const max = cfg.maxHistoryMessages === undefined ? DEFAULT_MAX_HISTORY : Number(cfg.maxHistoryMessages);
    let id = '';
    let history = [];
    let fresh = false;
    if (cfg.resume && isSessionId(cfg.resume)) {
      id = String(cfg.resume).toLowerCase();
      const stored = loadHistory(dir, id);
      if (stored) history = trimHistory(stored, max);
      else say({ type: 'note', text: 'The earlier conversation could not be found or read on the bridge PC, so this one starts fresh (the model does not remember it).' });
    } else {
      id = crypto.randomUUID();
      fresh = true;
      if (cfg.resume) say({ type: 'note', text: 'The saved session id is not one of this agent\'s, so a new conversation was started.' });
    }
    // A new id is announced only once its history is saved, so a failed first
    // turn leaves the bridge with nothing to "resume".
    if (!fresh) say({ type: 'session', id });

    const messages = buildMessages(cfg.system, history, cfg.prompt);
    const timeoutMs = timeoutFrom(cfg.requestTimeoutMs);
    const timeout = AbortSignal.timeout(timeoutMs);
    const any = AbortSignal.any(signal ? [timeout, signal] : [timeout]);
    say({ type: 'progress', text: `asking ${model} at ${host}...` });

    let status, text;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(buildBody(model, messages, cfg.extraBody)),
        signal: any,
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      if (signal && signal.aborted) return fail(STOPPED);
      if (timeout.aborted || (err && err.name === 'TimeoutError')) {
        throw new AgentError(`${host} did not answer within ${timeoutMs < 1000 ? timeoutMs + ' ms' : Math.round(timeoutMs / 1000) + ' s'} (agents.local.requestTimeoutMs). A large model may still be loading; try again, or raise the timeout.`);
      }
      throw networkError(err, host);
    }
    if (signal && signal.aborted) return fail(STOPPED);
    if (status < 200 || status >= 300) throw httpError(status, text, host);

    let json;
    try { json = JSON.parse(text); } catch { throw new AgentError(`${host} answered with something that is not JSON: ${truncate(text, 200)}`); }
    if (json && json.error && !json.choices) throw new AgentError(`${host} reported an error: ${serverMessage(text)}`);
    const reply = extractReply(json);
    if (!reply.text.trim()) {
      throw new AgentError(reply.finish === 'length'
        ? 'The model used its whole token budget before answering (finish_reason "length"). Raise max_tokens in agents.local.extraBody or the server\'s context length.'
        : 'The model returned an empty reply.');
    }

    try {
      saveHistory(dir, id, trimHistory(history.concat([{ role: 'user', content: String(cfg.prompt) }, { role: 'assistant', content: reply.text }]), max));
      if (fresh) say({ type: 'session', id });
    } catch (e) {
      say({ type: 'note', text: `The conversation could not be saved (${truncate(e.message, 120)}), so the next message will not remember this one.` });
    }
    if (reply.finish === 'length') say({ type: 'note', text: 'The reply was cut off (finish_reason "length"): the model hit its token or context limit.' });
    say({ type: 'result', text: reply.text, error: false });
  } catch (err) {
    fail(err instanceof AgentError ? err.message : `Local LLM failed: ${truncate(err && err.message, 300)}`);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const ctl = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => ctl.abort());
  let failed = false;
  const emit = (ev) => {
    if (ev.type === 'result' && ev.error) failed = true;
    process.stdout.write(asciiJson(ev) + '\n');
  };
  let input;
  try { input = JSON.parse(await readStdin()); } catch {
    emit({ type: 'result', text: 'Local LLM: the bridge did not pass a readable request.', error: true });
    process.exitCode = 1;
    return;
  }
  await run(input, emit, { signal: ctl.signal });
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) main();

module.exports = {
  AgentError, chatCompletionsUrl, safeUrl, isSessionId, sessionFile, loadHistory, saveHistory, trimHistory,
  timeoutFrom, asciiJson, post, buildMessages, buildBody, stripThink, serverMessage, httpError, extractReply, networkError, run,
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_HISTORY, SESSIONS_DIR,
};
