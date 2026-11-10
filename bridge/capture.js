'use strict';
// Which screen-capture program the bridge runs, and how it is kept running. Pure
// apart from what the caller injects (spawn, timers, log), so tests/capture_test.js
// drives all of it with a fake process. The backend contract that external
// programs follow is written down in docs/CAPTURE.md.
//
// Adding a backend is one entry in BACKENDS plus its section in docs/CAPTURE.md:
//   id         what "capture.backend" in config.json says
//   platforms  process.platform values it can run on, or null for anywhere
//   build      (cap, ctx) -> { file, args, env?, hint } or { error }
//              ctx = { here: bridge folder, clientDir: game client folder, platform }
//              hint says how to fix a spawn failure (shown with the OS error)
// "auto" is not an entry; autoBackend() picks one by platform.

const path = require('path');
const readline = require('readline');

// What the `command` backend gets to know, as environment variables.
const ENV_NAMES = {
  cellPx: 'WOW_AI_CAPTURE_CELL_PX',
  cellsPerRow: 'WOW_AI_CAPTURE_CELLS_PER_ROW',
  maxRows: 'WOW_AI_CAPTURE_MAX_ROWS',
  intervalMs: 'WOW_AI_CAPTURE_INTERVAL_MS',
  processName: 'WOW_AI_CAPTURE_PROCESS_NAME',
  windowName: 'WOW_AI_CAPTURE_WINDOW_NAME',
  clientFolder: 'WOW_AI_CAPTURE_CLIENT_FOLDER',
};

function pythonArgs(script, cap) {
  const args = [script,
    '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow), '--max-rows', String(cap.maxRows),
    '--interval-ms', String(cap.intervalMs), '--process-name', cap.processName];
  if (cap.windowName) args.push('--window-name', cap.windowName);
  return args;
}

const PYTHON_HINT = 'set capture.python in config.json to your Python 3 interpreter';

const BACKENDS = {
  windows: {
    id: 'windows',
    platforms: ['win32'],
    build: (cap, ctx) => ({
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.here, 'capture.ps1'),
        '-Cell', String(cap.cellPx), '-Cells', String(cap.cellsPerRow), '-MaxRows', String(cap.maxRows),
        '-IntervalMs', String(cap.intervalMs), '-ProcessName', cap.processName, '-ClientFolder', path.basename(ctx.clientDir)],
      hint: 'powershell.exe must be on PATH',
    }),
  },
  mac: {
    id: 'mac',
    platforms: ['darwin'],
    build: (cap, ctx) => ({
      file: cap.python || 'python3',
      args: pythonArgs(path.join(ctx.here, 'capture_mac.py'), cap),
      hint: PYTHON_HINT,
    }),
  },
  x11: {
    id: 'x11',
    platforms: null,
    build: (cap, ctx) => {
      const args = pythonArgs(path.join(ctx.here, 'capture_x11.py'), cap);
      if (cap.keepComposited) args.push('--keep-composited');
      return { file: cap.python || 'python3', args, hint: PYTHON_HINT };
    },
  },
  command: {
    id: 'command',
    platforms: null,
    build: (cap, ctx) => {
      if (typeof cap.command !== 'string' || !cap.command.trim()) {
        return { error: '"capture.command" must name the program to run when "capture.backend" is "command"' };
      }
      const args = cap.args === undefined || cap.args === null ? [] : cap.args;
      if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
        return { error: '"capture.args" must be an array of strings' };
      }
      const env = {
        [ENV_NAMES.cellPx]: String(cap.cellPx),
        [ENV_NAMES.cellsPerRow]: String(cap.cellsPerRow),
        [ENV_NAMES.maxRows]: String(cap.maxRows),
        [ENV_NAMES.intervalMs]: String(cap.intervalMs),
        [ENV_NAMES.processName]: String(cap.processName),
        [ENV_NAMES.windowName]: String(cap.windowName || ''),
        [ENV_NAMES.clientFolder]: ctx.clientDir ? path.basename(ctx.clientDir) : '',
      };
      // A relative path would depend on the folder the bridge was started from
      // (`cd project && wow-ai`), so it is taken from the repo; bare names stay a PATH lookup.
      let file = cap.command.trim();
      const hasSep = (ctx.platform === 'win32' ? /[\\/]/ : /\//).test(file);
      if (hasSep && !path.isAbsolute(file)) file = path.resolve(path.dirname(ctx.here), file);
      return { file, args: [...args], env, hint: 'check "capture.command" in config.json (an absolute path, or a name on PATH; a script needs a shebang line and execute permission, on Windows point it at the interpreter, not a .cmd/.bat)' };
    },
  },
};

const backendIds = () => Object.keys(BACKENDS);

function autoBackend(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'mac';
  return 'x11';
}

// -> { ok: true, id, auto, file, args, env, hint, label } | { ok: false, error }
// env holds only what the backend adds; the caller merges it onto process.env.
function resolveCapture(cap, { platform = process.platform, here = __dirname, clientDir = '' } = {}) {
  cap = cap || {};
  const valid = `auto, ${backendIds().join(', ')}`;
  let name = cap.backend === undefined || cap.backend === null || cap.backend === '' ? 'auto' : cap.backend;
  if (typeof name !== 'string') return { ok: false, error: `"capture.backend" must be a string (one of: ${valid})` };
  name = name.trim().toLowerCase();
  const auto = name === 'auto';
  const id = auto ? autoBackend(platform) : name;
  const backend = Object.prototype.hasOwnProperty.call(BACKENDS, id) ? BACKENDS[id] : null;
  if (!backend) return { ok: false, error: `unknown "capture.backend" "${cap.backend}" (one of: ${valid})` };
  if (backend.platforms && !backend.platforms.includes(platform)) {
    return { ok: false, error: `"capture.backend": "${id}" only runs on ${backend.platforms.join('/')}, this is ${platform} (use "auto", or one of: ${valid})` };
  }
  const built = backend.build(cap, { here, clientDir, platform });
  if (built.error) return { ok: false, error: built.error };
  return {
    ok: true, id, auto, file: built.file, args: built.args, env: built.env || {}, hint: built.hint || '',
    label: auto ? `${id} auto` : id,
  };
}

// Runs the backend and keeps it running; returns { stop }.
//   resolve()      -> resolveCapture result (called once; a bad config is logged once, nothing runs)
//   spawn          child_process.spawn
//   onRecord(ev)   called for every {id: number, text} object the program prints
//   log(...parts)  the bridge's logger
// Restarts after the process exits: 5 s, then doubling to 60 s while it keeps dying
// young; a run of 30 s or more starts the count again.
function superviseCapture({
  resolve, spawn, onRecord, log,
  setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout, now = Date.now,
  baseEnv = process.env, restartMs = 5000, maxRestartMs = 60000, healthyMs = 30000,
}) {
  const r = resolve();
  if (!r.ok) {
    log(`capture not started: ${r.error}. Fix config.json, then restart the bridge (/wow-ai mode reload works without capture)`);
    return { stop() {} };
  }
  let stopped = false;
  let child = null;
  let timer = null;
  let delay = restartMs;

  function start() {
    timer = null;
    const startedAt = now();
    let over = false; // 'error' and 'close' both fire for a failed spawn; restart once
    let ps = null;

    const ended = (what) => {
      if (over || stopped) return;
      over = true;
      if (child === ps) child = null;
      if (now() - startedAt >= healthyMs) delay = restartMs;
      log(`${what}; restarting in ${Math.round(delay / 1000)} s`);
      timer = later(start, delay);
      delay = Math.min(delay * 2, maxRestartMs);
    };
    const failed = err => ended(`capture (${r.label}) could not start "${r.file}": ${err.message}. ${r.hint}`);

    // Only some failures (ENOENT, EACCES) arrive as an 'error' event; others
    // (ENOEXEC, ENOTDIR, a NUL in the path, EINVAL for .cmd on Windows) throw here.
    // Env is only passed when the backend adds some, so the built-in ones spawn as before.
    const opts = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    if (Object.keys(r.env).length) opts.env = { ...baseEnv, ...r.env };
    try { ps = spawn(r.file, r.args, opts); } catch (err) { failed(err); return; }
    child = ps;

    const rl = readline.createInterface({ input: ps.stdout });
    rl.on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      if (ev.info) { log('capture:', ev.info); return; }
      if (ev.warn) { log('capture:', ev.warn); return; }
      if (ev.error) { log('capture error:', ev.error); return; }
      if (typeof ev.id === 'number') onRecord(ev);
    });
    ps.stderr.on('data', (d) => log('capture stderr:', String(d).trim().slice(0, 300)));
    ps.on('error', (err) => {
      // After a successful spawn an 'error' is something like a failed kill; the exit still comes via 'close'.
      if (ps.pid !== undefined) { log(`capture (${r.label}) process error: ${err.message}`); return; }
      failed(err);
    });
    ps.on('close', (code) => ended(`capture exited (${code})`));
  }

  start();
  return {
    stop() {
      stopped = true;
      if (timer) { cancel(timer); timer = null; }
      if (child) { try { child.kill(); } catch {} child = null; }
    },
  };
}

module.exports = { BACKENDS, ENV_NAMES, backendIds, autoBackend, resolveCapture, superviseCapture };
