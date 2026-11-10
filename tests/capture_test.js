// Unit tests for bridge/capture.js: which capture program each platform and
// `capture.backend` value selects, the `command` backend, bad configurations, and
// the supervision loop (restarts, backoff) driven by a fake process.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const C = require('../bridge/capture');

// Resolved, so on Windows it carries the drive letter path.resolve() in capture.js adds.
const HERE = path.resolve(path.sep, 'repo', 'bridge');
const CLIENT = path.join(path.sep, 'wow', '_forever_');
const DEFAULTS = { enabled: true, processName: 'Wow', cellPx: 4, cellsPerRow: 200, maxRows: 48, intervalMs: 250 };
const resolve = (cap, platform = 'linux') =>
  C.resolveCapture({ ...DEFAULTS, ...cap }, { platform, here: HERE, clientDir: CLIENT });

// The selection bridge.js made before backends existed, kept as the reference.
function oldCaptureCommand(cap, platform) {
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'capture.ps1'),
      '-Cell', String(cap.cellPx), '-Cells', String(cap.cellsPerRow), '-MaxRows', String(cap.maxRows),
      '-IntervalMs', String(cap.intervalMs), '-ProcessName', cap.processName, '-ClientFolder', path.basename(CLIENT)]];
  }
  if (platform === 'darwin') {
    const args = [path.join(HERE, 'capture_mac.py'),
      '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow), '--max-rows', String(cap.maxRows),
      '--interval-ms', String(cap.intervalMs), '--process-name', cap.processName];
    if (cap.windowName) args.push('--window-name', cap.windowName);
    return [cap.python || 'python3', args];
  }
  const args = [path.join(HERE, 'capture_x11.py'),
    '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow), '--max-rows', String(cap.maxRows),
    '--interval-ms', String(cap.intervalMs), '--process-name', cap.processName];
  if (cap.windowName) args.push('--window-name', cap.windowName);
  if (cap.keepComposited) args.push('--keep-composited');
  return [cap.python || 'python3', args];
}

test('auto (and an absent or empty backend) is exactly what bridge.js used to run', () => {
  const variants = [{}, { python: 'python3.12' }, { windowName: 'World of Warcraft' },
    { keepComposited: true, windowName: 'W', python: '/usr/bin/python3' }, { processName: 'WowClassic', cellPx: 3 }];
  for (const platform of ['win32', 'darwin', 'linux', 'freebsd']) {
    for (const v of variants) {
      for (const backend of [undefined, 'auto', 'AUTO', '', null]) {
        const cap = { ...DEFAULTS, ...v };
        if (backend !== undefined) cap.backend = backend;
        const r = C.resolveCapture(cap, { platform, here: HERE, clientDir: CLIENT });
        const [file, args] = oldCaptureCommand(cap, platform);
        assert.equal(r.ok, true);
        assert.equal(r.file, file);
        assert.deepEqual(r.args, args);
        assert.deepEqual(r.env, {});
        assert.equal(r.auto, true);
      }
    }
  }
  assert.equal(resolve({}, 'win32').id, 'windows');
  assert.equal(resolve({}, 'darwin').id, 'mac');
  assert.equal(resolve({}, 'linux').id, 'x11');
  assert.equal(resolve({}, 'freebsd').label, 'x11 auto');
});

test('an explicit backend selects it', () => {
  const x = resolve({ backend: 'x11', keepComposited: true });
  assert.equal(x.id, 'x11');
  assert.equal(x.auto, false);
  assert.equal(x.label, 'x11');
  assert.deepEqual([x.file, x.args], oldCaptureCommand({ ...DEFAULTS, keepComposited: true }, 'linux'));
  assert.equal(resolve({ backend: ' X11 ' }, 'darwin').id, 'x11');
  assert.deepEqual(resolve({ backend: 'windows' }, 'win32').args, oldCaptureCommand(DEFAULTS, 'win32')[1]);
  assert.deepEqual(resolve({ backend: 'mac' }, 'darwin').args, oldCaptureCommand(DEFAULTS, 'darwin')[1]);
});

test('windows and mac refuse other platforms; x11 and command run anywhere', () => {
  const w = resolve({ backend: 'windows' }, 'linux');
  assert.equal(w.ok, false);
  assert.match(w.error, /capture\.backend.*windows.*only runs on win32.*linux/);
  assert.equal(resolve({ backend: 'mac' }, 'linux').ok, false);
  assert.equal(resolve({ backend: 'x11' }, 'win32').ok, true);
  assert.equal(resolve({ backend: 'command', command: 'tool' }, 'win32').ok, true);
});

test('the command backend: verbatim argv, settings in the environment, no shell', () => {
  const r = resolve({ backend: 'command', command: 'my-capture', args: ['--flag', 'a b', '$HOME', ''], windowName: 'Game' });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'command');
  assert.equal(r.file, 'my-capture');
  assert.deepEqual(r.args, ['--flag', 'a b', '$HOME', '']);
  assert.deepEqual(r.env, {
    WOW_AI_CAPTURE_CELL_PX: '4',
    WOW_AI_CAPTURE_CELLS_PER_ROW: '200',
    WOW_AI_CAPTURE_MAX_ROWS: '48',
    WOW_AI_CAPTURE_INTERVAL_MS: '250',
    WOW_AI_CAPTURE_PROCESS_NAME: 'Wow',
    WOW_AI_CAPTURE_WINDOW_NAME: 'Game',
    WOW_AI_CAPTURE_CLIENT_FOLDER: '_forever_',
  });
  assert.deepEqual(resolve({ backend: 'command', command: 'x' }).args, []);
});

test('a relative command path is taken from the repo, bare names and absolute paths are left alone', () => {
  const root = path.dirname(HERE);
  assert.equal(resolve({ backend: 'command', command: 'tools/cap.sh' }).file, path.join(root, 'tools', 'cap.sh'));
  assert.equal(resolve({ backend: 'command', command: './cap' }).file, path.join(root, 'cap'));
  assert.equal(resolve({ backend: 'command', command: 'python3' }).file, 'python3');
  const abs = path.join(path.sep, 'opt', 'cap');
  assert.equal(resolve({ backend: 'command', command: abs }).file, abs);
  assert.deepEqual(resolve({ backend: 'command', command: 'tools/cap.sh', args: ['rel/x'] }).args, ['rel/x']);
});

test('bad configurations name the key and list the valid backends', () => {
  const bad = [
    [{ backend: 'wayland' }, /unknown "capture\.backend" "wayland".*auto, windows, mac, x11, command/],
    [{ backend: 7 }, /"capture\.backend" must be a string.*auto, windows, mac, x11, command/],
    [{ backend: 'toString' }, /unknown "capture\.backend"/],
    [{ backend: 'command' }, /"capture\.command"/],
    [{ backend: 'command', command: '  ' }, /"capture\.command"/],
    [{ backend: 'command', command: 5 }, /"capture\.command"/],
    [{ backend: 'command', command: 'x', args: 'a b' }, /"capture\.args" must be an array of strings/],
    [{ backend: 'command', command: 'x', args: ['a', 1] }, /"capture\.args" must be an array of strings/],
  ];
  for (const [cap, re] of bad) {
    const r = resolve(cap);
    assert.equal(r.ok, false, JSON.stringify(cap));
    assert.match(r.error, re);
  }
});

// A fake child_process.spawn: every call makes a process we can drive by hand.
function fakeSpawn() {
  const calls = [];
  const fn = (file, args, opts) => {
    const ps = new EventEmitter();
    ps.stdout = new PassThrough();
    ps.stderr = new PassThrough();
    ps.pid = 100 + calls.length;
    ps.killed = false;
    ps.kill = () => { ps.killed = true; };
    calls.push({ file, args, opts, ps });
    return ps;
  };
  fn.calls = calls;
  return fn;
}

function harness(config = { backend: 'x11' }, extra = {}) {
  const spawnFn = fakeSpawn();
  const logs = [];
  const records = [];
  const timers = [];
  let clock = 1000;
  const sup = C.superviseCapture({
    resolve: () => resolve(config),
    spawn: spawnFn,
    log: (...p) => logs.push(p.join(' ')),
    onRecord: ev => records.push(ev),
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: t => { t.live = false; },
    now: () => clock,
    baseEnv: { KEEP: 'me' },
    ...extra,
  });
  return {
    sup, spawnFn, logs, records, timers,
    advance: ms => { clock += ms; },
    fire: () => { const t = timers.filter(x => x.live).pop(); t.live = false; t.fn(); return t.ms; },
    live: () => timers.filter(x => x.live),
  };
}
const tick = () => new Promise(r => setImmediate(r));

test('supervision: records go to onRecord, info/warn/error are logged, junk is ignored', async () => {
  const h = harness();
  const { ps } = h.spawnFn.calls[0];
  ps.stdout.write('{"info":"attached"}\n{"warn":"slow"}\n{"error":"boom"}\nnot json\nnull\n42\n{"id":7,"text":"a\\u001fb"}\n{"id":"x"}\n{"other":1}\n');
  ps.stderr.write('oops\n');
  await tick();
  assert.deepEqual(h.records, [{ id: 7, text: 'a\x1fb' }]);
  assert.deepEqual(h.logs, ['capture: attached', 'capture: slow', 'capture error: boom', 'capture stderr: oops']);
  const call = h.spawnFn.calls[0];
  assert.equal(call.file, 'python3');
  assert.equal(call.opts.env, undefined); // built-in backends spawn without an env override
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.shell, undefined);
});

test('supervision: the command backend env is merged onto the base env', () => {
  const h = harness({ backend: 'command', command: 'tool', args: ['x'] });
  const { opts, file, args } = h.spawnFn.calls[0];
  assert.equal(file, 'tool');
  assert.deepEqual(args, ['x']);
  assert.equal(opts.env.KEEP, 'me');
  assert.equal(opts.env.WOW_AI_CAPTURE_CELL_PX, '4');
});

test('supervision: restarts after close, backs off while it dies young, resets after a long run', () => {
  const h = harness();
  const waits = [];
  for (let i = 0; i < 6; i++) {
    h.spawnFn.calls[i].ps.emit('close', 1);
    waits.push(h.fire());
    assert.equal(h.spawnFn.calls.length, i + 2);
  }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000]);
  h.advance(31000);
  h.spawnFn.calls[6].ps.emit('close', 0);
  assert.equal(h.fire(), 5000);
  assert.match(h.logs.at(-1), /capture exited \(0\); restarting in 5 s/);
});

test('supervision: a failed spawn logs one clear message and restarts once', () => {
  const h = harness({ backend: 'command', command: 'nope', args: [] });
  const ps = h.spawnFn.calls[0].ps;
  ps.pid = undefined;
  const err = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' });
  ps.emit('error', err);
  ps.emit('close', -2);
  assert.equal(h.live().length, 1);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /capture \(command\) could not start "nope": spawn nope ENOENT.*"capture\.command".*restarting in 5 s/);
  h.fire();
  assert.equal(h.spawnFn.calls.length, 2);
});

test('supervision: a spawn that throws is reported and retried, not fatal', () => {
  const h = harness({ backend: 'command', command: '/x/script', args: [] }, {
    spawn: () => { throw Object.assign(new Error('spawn ENOEXEC'), { code: 'ENOEXEC' }); },
  });
  assert.equal(h.live().length, 1);
  assert.match(h.logs[0], /capture \(command\) could not start "\/x\/script": spawn ENOEXEC.*shebang.*restarting in 5 s/);
  assert.equal(h.fire(), 5000); // the timer-driven restart throws too and must not escape
  assert.equal(h.live().length, 1);
  assert.match(h.logs[1], /restarting in 10 s/);
});

test('supervision: a throw on a timer-driven restart is contained', () => {
  let n = 0;
  const calls = fakeSpawn();
  const h = harness({ backend: 'x11' }, { spawn: (...a) => { if (n++) throw new Error('boom'); return calls(...a); } });
  calls.calls[0].ps.emit('close', 1);
  h.fire();
  assert.equal(h.live().length, 1);
  assert.match(h.logs.at(-1), /could not start "python3": boom/);
});

test('supervision: close then a late error does not double-schedule either', () => {
  const h = harness();
  const ps = h.spawnFn.calls[0].ps;
  ps.emit('close', 1);
  ps.pid = undefined;
  ps.emit('error', new Error('late'));
  assert.equal(h.live().length, 1);
});

test('supervision: an error on a running process only logs', () => {
  const h = harness();
  h.spawnFn.calls[0].ps.emit('error', new Error('kill EPERM'));
  assert.equal(h.live().length, 0);
  assert.match(h.logs[0], /process error: kill EPERM/);
});

test('supervision: an invalid configuration logs once and never spawns', () => {
  const h = harness({ backend: 'bogus' });
  assert.equal(h.spawnFn.calls.length, 0);
  assert.equal(h.live().length, 0);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /capture not started: unknown "capture\.backend" "bogus"/);
  h.sup.stop();
});

test('supervision: stop kills the process and cancels a pending restart', () => {
  const h = harness();
  const ps = h.spawnFn.calls[0].ps;
  h.sup.stop();
  assert.equal(ps.killed, true);
  const h2 = harness();
  h2.spawnFn.calls[0].ps.emit('close', 1);
  assert.equal(h2.live().length, 1);
  h2.sup.stop();
  assert.equal(h2.live().length, 0);
});

test('a real command backend: env arrives and its lines are parsed', { timeout: 10000 }, async () => {
  const script = path.join(__dirname, 'fixtures', 'capture_echo.js');
  const records = [];
  const logs = [];
  const sup = C.superviseCapture({
    resolve: () => resolve({ backend: 'command', command: process.execPath, args: [script], windowName: 'Game' }),
    spawn,
    log: (...p) => logs.push(p.join(' ')),
    onRecord: ev => records.push(ev),
    setTimeout: () => ({}), // no restart: the script exits after printing
  });
  await new Promise(r => { const t = setInterval(() => { if (logs.some(l => /exited|could not start/.test(l))) { clearInterval(t); r(); } }, 10); });
  sup.stop();
  assert.deepEqual(records, [{ id: 3, text: 'hello' }]);
  assert.ok(logs.includes('capture: cell=4 cells=200 rows=48 interval=250 process=Wow window=Game client=_forever_'), logs.join('\n'));
});
