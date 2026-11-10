// bridge/capture_wayland.py without a Wayland session: the strip decoder on synthetic frames
// (offsets, scaling, blur, raw buffers with stride padding, a whole-monitor frame) and the
// portal flow driven by its --fake-portal scenarios (no portal, cancelled, failed, restore
// token rejected and retried, session closed mid-stream). The D-Bus/PipeWire/GStreamer parts
// need a live session and are not covered here (see docs/INSTALL-LINUX.md).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'bridge', 'capture_wayland.py');
const CODEC = path.join(__dirname, '..', 'addon', 'WoWAI', 'Codec.lua');
const TMP = path.join(__dirname, 'tmp', 'wayland');
const CELL = 4, CELLS = 200, MAXROWS = 48;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const hasPython = !spawnSync('python3', ['--version']).error;
const opts = hasPython ? {} : { skip: 'python3 is required' };

function encodeWithLua(id, payload) {
  const bytes = Buffer.from(payload, 'utf8');
  const lit = '"' + [...bytes].map(b => '\\' + b).join('') + '"';
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const code = fs.readFileSync(CODEC, 'utf8') +
    `\nlocal cells = WoWAI_Codec.Encode(${id}, ${lit})\n` +
    `local t = {}\nfor i = 1, #cells do t[i] = string.format("%d", cells[i]) end\nRESULT = table.concat(t, ",")\n`;
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1)).split(',').map(Number);
}

// A canvas of cw x ch RGB pixels with the strip's top-left cell at (ox, oy), like the addon draws it.
function canvas(cells, { cw = CELLS * CELL + 40, ch = MAXROWS * CELL + 40, ox = 0, oy = 0, decoys = false } = {}) {
  const rgb = Buffer.alloc(cw * ch * 3, 0x30);
  const fill = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const o = (y * cw + x) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  };
  if (decoys) { fill(40, 60, 30, 30, [255, 255, 0]); fill(500, 400, 12, 8, [255, 255, 0]); }
  cells.forEach((v, i) => {
    const c = i % CELLS, r = Math.floor(i / CELLS);
    fill(ox + c * CELL, oy + r * CELL, CELL, CELL, [(v >> 2 & 1) * 255, (v >> 1 & 1) * 255, (v & 1) * 255]);
  });
  return { w: cw, h: ch, rgb };
}

function scale(img, f) {
  if (f === 1) return img;
  const w = Math.round(img.w * f), h = Math.round(img.h * f);
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.w - 1, Math.floor(x / f)), sy = Math.min(img.h - 1, Math.floor(y / f));
    img.rgb.copy(rgb, (y * w + x) * 3, (sy * img.w + sx) * 3, (sy * img.w + sx) * 3 + 3);
  }
  return { w, h, rgb };
}

function blur(img, r) {
  if (!r) return img;
  const out = Buffer.alloc(img.rgb.length), tmp = Buffer.alloc(img.rgb.length);
  const pass = (src, dst, horiz) => {
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) for (let k = 0; k < 3; k++) {
      let s = 0, n = 0;
      for (let d = -r; d <= r; d++) {
        const xx = horiz ? x + d : x, yy = horiz ? y : y + d;
        if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue;
        s += src[(yy * img.w + xx) * 3 + k]; n++;
      }
      dst[(y * img.w + x) * 3 + k] = Math.round(s / n);
    }
  };
  pass(img.rgb, tmp, true); pass(tmp, out, false);
  return { w: img.w, h: img.h, rgb: out };
}

function paintCell(img, f, cell, color, ox = 0, oy = 0) {
  const c = cell % CELLS, r = Math.floor(cell / CELLS), p = CELL * f;
  for (let y = Math.floor(oy * f + r * p); y < Math.ceil(oy * f + (r + 1) * p); y++)
    for (let x = Math.floor(ox * f + c * p); x < Math.ceil(ox * f + (c + 1) * p); x++) {
      const o = (y * img.w + x) * 3; img.rgb[o] = color[0]; img.rgb[o + 1] = color[1]; img.rgb[o + 2] = color[2];
    }
}

function png(img) {
  const raw = Buffer.alloc((img.w * 3 + 1) * img.h);
  for (let y = 0; y < img.h; y++) img.rgb.copy(raw, y * (img.w * 3 + 1) + 1, y * img.w * 3, (y + 1) * img.w * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Memory-order layouts as GStreamer names them; x/padding bytes are filled with junk on purpose.
const LAYOUT = { BGRx: [4, 2, 1, 0], RGBx: [4, 0, 1, 2], BGRA: [4, 2, 1, 0], BGR: [3, 2, 1, 0], RGB: [3, 0, 1, 2] };
function raw(img, fmt, pad) {
  const [bpp, ri, gi, bi] = LAYOUT[fmt];
  const stride = img.w * bpp + pad;
  const out = Buffer.alloc(stride * img.h, 0x7f);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const o = y * stride + x * bpp, s = (y * img.w + x) * 3;
    out[o + ri] = img.rgb[s]; out[o + gi] = img.rgb[s + 1]; out[o + bi] = img.rgb[s + 2];
  }
  return { data: out, stride };
}

let n = 0;
function file(name, buf) { const p = path.join(TMP, `${++n}_${name}`); fs.writeFileSync(p, buf); return p; }

function run(argv, env = {}) {
  const r = spawnSync('python3', [SCRIPT, ...argv], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  const lines = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { code: r.status, lines, stderr: r.stderr, last: lines[lines.length - 1] };
}

const SAMPLE = { id: 321, payload: 'sess1\x1Fchat1\x1F7\x1FC:\\proj\x1F\x1Fname\x1Fhéllo wörld ✓ — "quotes" ' + 'lorem ipsum '.repeat(30) };
const cells = encodeWithLua(SAMPLE.id, SAMPLE.payload);
const OTHER = { id: 322, payload: 'second message' };
const cellsOther = encodeWithLua(OTHER.id, OTHER.payload);
const ok = (res, t = SAMPLE) => { assert.deepStrictEqual(res.last, { id: t.id, text: t.payload }); assert.strictEqual(res.code, 0); };

test('decodes a strip at the window origin', opts, () => {
  ok(run(['--test-image', file('plain.png', png(canvas(cells)))]));
});

test('finds a strip a few pixels off the window origin', opts, () => {
  for (const [ox, oy] of [[3, 5], [8, 8], [0, 7]]) {
    ok(run(['--test-image', file(`off_${ox}_${oy}.png`, png(canvas(cells, { ox, oy })))]));
  }
});

test('reads raw buffers: formats, stride padding, junk in x/padding bytes', opts, () => {
  const img = canvas(cells);
  for (const [fmt, pad] of [['BGRx', 0], ['BGRx', 64], ['RGBx', 16], ['BGRA', 0], ['BGR', 8], ['RGB', 0]]) {
    const { data, stride } = raw(img, fmt, pad);
    const res = run(['--test-raw', file(`raw_${fmt}.bin`, data), '--width', String(img.w), '--height', String(img.h), '--stride', String(stride), '--format', fmt]);
    assert.deepStrictEqual(res.last, { id: SAMPLE.id, text: SAMPLE.payload }, `${fmt} pad ${pad}`);
  }
});

test('wrong stride, size or format gives a clear error', opts, () => {
  const img = canvas(cells), { data, stride } = raw(img, 'BGRx', 0);
  const f = file('bad.bin', data);
  const dims = ['--width', String(img.w), '--height', String(img.h)];
  let res = run(['--test-raw', f, ...dims, '--stride', String(stride - 4), '--format', 'BGRx']);
  assert.strictEqual(res.code, 1); assert.match(res.last.error, /stride .* smaller than width/);
  res = run(['--test-raw', f, ...dims, '--stride', String(stride + 8), '--format', 'BGRx']);
  assert.strictEqual(res.code, 1); assert.match(res.last.error, /buffer holds .* needs/);
  res = run(['--test-raw', f, ...dims, '--stride', String(stride), '--format', 'NV12']);
  assert.strictEqual(res.code, 1); assert.match(res.last.error, /unsupported pixel format 'NV12'/);
  // the right layout read as the wrong one is not a decode, and says so
  res = run(['--test-raw', f, ...dims, '--stride', String(stride), '--format', 'RGBx']);
  assert.ok(res.last.error && !res.last.id, JSON.stringify(res.last));
});

test('no strip in the picture', opts, () => {
  const res = run(['--test-image', file('empty.png', png(canvas([])))]);
  assert.deepStrictEqual(res.last, { error: 'no valid strip in image' });
});

test('scaled pictures (nearest neighbour) still decode', opts, () => {
  for (const f of [1.25, 1.5, 2, 4 / 3, 1.75, 3]) {
    const img = scale(canvas(cells, { ox: 2, oy: 3 }), f);
    ok(run(['--test-image', file(`scale_${f.toFixed(2)}.png`, png(img))]));
  }
});

test('scaled and mildly blurred pictures decode', opts, () => {
  for (const [f, r] of [[1.5, 1], [2, 1], [1.25, 1]]) {
    ok(run(['--test-image', file(`blur_${f}_${r}.png`, png(blur(scale(canvas(cells), f), r)))]));
  }
});

test('a scaled strip that does not validate names the scaling', opts, () => {
  const img = scale(canvas(cells), 1.5);
  paintCell(img, 1.5, 30, [255, 0, 0]); // wrong colour in one cell: magic fine, checksum not
  paintCell(img, 1.5, 31, [0, 255, 0]);
  paintCell(img, 1.5, 32, [0, 0, 255]);
  paintCell(img, 1.5, 33, [255, 255, 255]);
  const res = run(['--test-image', file('corrupt.png', png(img))]);
  assert.strictEqual(res.code, 0);
  assert.ok(!res.last.id);
  assert.match(res.last.error, /strip seen but rejected: checksum/);
  assert.match(res.last.error, /does not validate, likely scaling or blur; detected cell pitch ~6\.\d\d px instead of 4 px/);
  assert.match(res.last.error, /integer scale/);
});

test('an unscaled corrupt strip blames the colours, not the scale', opts, () => {
  const img = canvas(cells);
  for (let i = 40; i < 44; i++) paintCell(img, 1, i, [255 - (i % 2) * 255, 255, 0], 0, 0);
  const res = run(['--test-image', file('corrupt1.png', png(img))]);
  assert.match(res.last.error, /strip seen but rejected: checksum/);
  assert.match(res.last.error, /cell pitch matches \(4 px\)/);
});

test('probe-portal reports the portal, its source types and the scenario token state', opts, () => {
  const sc = file('sc.json', JSON.stringify({ version: 5, source_types: 3, cursor_modes: 7 }));
  const res = run(['--probe-portal', '--fake-portal', sc, '--token-file', path.join(TMP, 'none')]);
  assert.strictEqual(res.code, 0);
  assert.deepStrictEqual(res.last.portal, { version: 5, sourceTypes: ['monitor', 'window'], cursorModes: ['hidden', 'embedded', 'metadata'] });
  assert.deepStrictEqual(res.last.missing, []);
  assert.strictEqual(res.last.tokenStored, false);
});

// ----- the portal flow, with a scenario instead of D-Bus -----

function scenario(extra = {}, frames = [png(canvas(cells))]) {
  const list = frames.map((buf, i) => ({ png: file(`frame${i}.png`, buf) }));
  return file('scenario.json', JSON.stringify({ version: 5, source_types: 3, cursor_modes: 7, frames: list, after: 'closed', streams: [{ node: 42, size: [1920, 1080], source_type: 2 }], ...extra }));
}
const flow = (sc, extra = [], tokenFile = path.join(TMP, `token_${++n}`)) =>
  ({ tokenFile, ...run(['--fake-portal', sc, '--exit-delay', '0', '--interval-ms', '10', '--token-file', tokenFile, ...extra]) });

test('flow: decodes frames, announces the cast, then exits 6 when the session closes', opts, () => {
  const res = flow(scenario());
  assert.strictEqual(res.code, 6);
  const msgs = res.lines.filter(l => l.id !== undefined);
  assert.deepStrictEqual(msgs, [{ id: SAMPLE.id, text: SAMPLE.payload }]);
  assert.ok(res.lines.some(l => /attached to Wayland window cast \(1920x1080, PipeWire node 42\)/.test(l.info)));
  assert.match(res.last.info, /portal closed the screencast session.*exiting so the bridge restarts the capture/);
});

test('flow: a repeated message is emitted once, a new one again', opts, () => {
  const a = png(canvas(cells)), b = png(canvas(cellsOther));
  const res = flow(scenario({}, [a, a, b, b]));
  assert.deepStrictEqual(res.lines.filter(l => l.id !== undefined).map(l => l.id), [SAMPLE.id, OTHER.id]);
});

test('flow: stream end (EOS) is reported and exits 6', opts, () => {
  const res = flow(scenario({ after: 'eos' }));
  assert.strictEqual(res.code, 6);
  assert.match(res.last.info, /PipeWire stream ended/);
});

test('flow: no portal on the bus -> one error naming the packages, exit 3', opts, () => {
  for (const portal of ['unavailable', 'no-screencast']) {
    const res = flow(scenario({ portal }));
    assert.strictEqual(res.code, 3);
    assert.strictEqual(res.lines.length, 1);
    assert.match(res.last.error, /xdg-desktop-portal ScreenCast is not available/);
    assert.match(res.last.error, /pacman -S xdg-desktop-portal xdg-desktop-portal-gnome/);
    assert.match(res.last.error, /apt install xdg-desktop-portal xdg-desktop-portal-gnome/);
    assert.match(res.last.error, /niri-session/);
  }
});

test('flow: picker cancelled (response 1) -> exit 4 with --on-cancel exit, no retry', opts, () => {
  const res = flow(scenario({ start_response: 1 }), ['--on-cancel', 'exit']);
  assert.strictEqual(res.code, 4);
  assert.strictEqual(res.lines.length, 1);
  assert.match(res.last.error, /cancelled in the portal dialog.*pick the Wow window/);
});

test('flow: a cancelled picker is reported once and the helper then idles instead of exiting', opts, () => {
  const sc = scenario({ start_response: 1 });
  const r = spawnSync('python3', [SCRIPT, '--fake-portal', sc, '--exit-delay', '0', '--token-file', path.join(TMP, 'idle-token')],
    { encoding: 'utf8', timeout: 1500 });
  assert.strictEqual(r.error && r.error.code, 'ETIMEDOUT'); // still running when the test killed it
  const lines = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0].error, /cancelled in the portal dialog.*restart the bridge/);
});

test('flow: portal failure (response 2) -> exit 5', opts, () => {
  const res = flow(scenario({ start_response: 2 }));
  assert.strictEqual(res.code, 5);
  assert.match(res.last.error, /screencast portal failure: Start returned response 2/);
});

test('flow: a rejected restore token is dropped and the picker asked once more', opts, () => {
  const tokenFile = path.join(TMP, 'stale-token');
  fs.writeFileSync(tokenFile, 'stale\n');
  const res = flow(scenario({ restore_token_in: 'good', new_restore_token: 'fresh' }), [], tokenFile);
  assert.ok(res.lines.some(l => /restore token was not accepted/.test(l.info)), JSON.stringify(res.lines));
  assert.deepStrictEqual(res.lines.filter(l => l.id !== undefined).map(l => l.id), [SAMPLE.id]);
  assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), 'fresh\n');
  assert.strictEqual(res.code, 6);
});

test('flow: an accepted restore token is replaced by the new single-use one, mode 0600', opts, () => {
  const tokenFile = path.join(TMP, 'sub', 'good-token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, 'good\n');
  const res = flow(scenario({ restore_token_in: 'good', new_restore_token: 'next' }), [], tokenFile);
  assert.ok(!res.lines.some(l => /not accepted/.test(l.info || '')));
  assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), 'next\n');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(tokenFile).mode & 0o777, 0o600);
});

test('flow: the first run stores the token in a fresh private directory', opts, () => {
  const dir = path.join(TMP, 'newdir');
  const tokenFile = path.join(dir, 'tok');
  flow(scenario({ new_restore_token: 'first' }), [], tokenFile);
  assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), 'first\n');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
});

test('flow: --no-restore never reads or writes a token', opts, () => {
  const tokenFile = path.join(TMP, 'norestore-token');
  fs.writeFileSync(tokenFile, 'keep\n');
  const res = flow(scenario({ restore_token_in: 'other', new_restore_token: 'x' }), ['--no-restore'], tokenFile);
  assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), 'keep\n');
  assert.ok(!res.lines.some(l => /not accepted/.test(l.info || '')));
});

test('flow: a portal without window sharing falls back to the monitor and finds the strip in it', opts, () => {
  const mon = scale(canvas(cells, { cw: 1280, ch: 720, ox: 301, oy: 202, decoys: true }), 1);
  const res = flow(scenario({ source_types: 1, streams: [{ node: 7, size: [1280, 720], source_type: 1 }] }, [png(mon)]));
  assert.ok(res.lines.some(l => /portal offers no window sharing.*falling back to a whole monitor/.test(l.warn || '')), JSON.stringify(res.lines));
  assert.deepStrictEqual(res.lines.filter(l => l.id !== undefined), [{ id: SAMPLE.id, text: SAMPLE.payload }]);
  assert.ok(res.lines.some(l => /Wayland monitor cast/.test(l.info || '')));
});

test('flow: --source-type window on a monitor-only portal is a clear failure', opts, () => {
  const res = flow(scenario({ source_types: 1 }), ['--source-type', 'window']);
  assert.strictEqual(res.code, 5);
  assert.match(res.last.error, /cannot share a single window/);
});

test('flow: --probe saves a PNG and reports the geometry', opts, () => {
  const out = path.join(TMP, 'probe.png');
  const res = flow(scenario({}, [png(scale(canvas(cells, { ox: 2, oy: 1 }), 1.5))]), ['--probe', out, '--probe-crop', '400x200']);
  assert.strictEqual(res.code, 0, JSON.stringify(res.lines));
  assert.ok(fs.readFileSync(out).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.deepStrictEqual(res.last.strip, { id: SAMPLE.id, text: SAMPLE.payload });
  assert.strictEqual(res.last.pitch, 6);
  assert.strictEqual(res.last.source, 'window');
  assert.deepStrictEqual(res.last.streamSize, [1920, 1080]);
});

test('the default exit delay stays under the bridge\'s 30 s healthy mark', opts, () => {
  const r = spawnSync('python3', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /--exit-delay EXIT_DELAY/);
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /"--exit-delay", type=float, default=5\.0/);
});

test('missing dependencies: one error with the exact packages, exit 3', opts, () => {
  const res = run(['--exit-delay', '0'], { WOWAI_WAYLAND_TEST_MISSING: 'gi' });
  assert.strictEqual(res.code, 3);
  assert.strictEqual(res.lines.length, 1);
  assert.match(res.last.error, /PyGObject \(python module 'gi'\)/);
  assert.match(res.last.error, /pacman -S python-gobject/);
  assert.match(res.last.error, /apt install python3-gi/);
});

test('probe-portal lists what is missing without touching the portal', opts, () => {
  const res = run(['--probe-portal'], { WOWAI_WAYLAND_TEST_MISSING: 'gi' });
  assert.strictEqual(res.code, 3);
  assert.deepStrictEqual(res.last.missing, ["PyGObject (python module 'gi')"]);
  assert.match(res.last.hint, /python-gobject/);
});

test('a strip pushed past --slack by a title bar or window frame is found by its corner', opts, () => {
  for (const [ox, oy] of [[0, 30], [6, 37], [24, 24]]) {
    ok(run(['--test-image', file(`frame_${ox}_${oy}.png`, png(canvas(cells, { cw: CELLS * CELL + 80, ch: MAXROWS * CELL + 80, ox, oy })))]));
  }
});

test('flow: a portal that reports no source_type (before version 3) is taken at the type that was asked for', opts, () => {
  const mon = canvas(cells, { cw: 1280, ch: 720, ox: 301, oy: 202 });
  const res = flow(scenario({ version: 2, source_types: 1, streams: [{ node: 7, size: [1280, 720] }] }, [png(mon)]));
  assert.ok(res.lines.some(l => /attached to Wayland monitor cast/.test(l.info || '')), JSON.stringify(res.lines));
  assert.deepStrictEqual(res.lines.filter(l => l.id !== undefined).map(l => l.id), [SAMPLE.id]);
  const win = flow(scenario({ version: 2, streams: [{ node: 7, size: [1920, 1080] }] }));
  assert.ok(win.lines.some(l => /attached to Wayland window cast/.test(l.info || '')), JSON.stringify(win.lines));
});

test('flow: a failure the restore token does not explain keeps the token and asks nothing again', opts, () => {
  for (const [extra, argv] of [[{ open_remote_fails: true }, []], [{ source_types: 1 }, ['--source-type', 'window']]]) {
    const tokenFile = path.join(TMP, `kept_${++n}`);
    fs.writeFileSync(tokenFile, 'good\n');
    const res = flow(scenario({ restore_token_in: 'good', ...extra }), argv, tokenFile);
    assert.strictEqual(res.code, 5, JSON.stringify(res.lines));
    assert.ok(!res.lines.some(l => /not accepted/.test(l.info || '')));
    assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), 'good\n');
  }
});

test('flow: --probe with a cancelled picker exits 4 instead of idling in the shell', opts, () => {
  const res = flow(scenario({ start_response: 1 }), ['--probe', path.join(TMP, 'never.png')]);
  assert.strictEqual(res.code, 4);
  assert.match(res.last.error, /cancelled in the portal dialog/);
});

test('the token file: a relative XDG_STATE_HOME is ignored, a stale tmp file does not keep its mode', opts, () => {
  const home = path.join(TMP, 'home');
  const sc = file('sc.json', JSON.stringify({ version: 5, source_types: 3, cursor_modes: 7 }));
  const res = run(['--probe-portal', '--fake-portal', sc], { HOME: home, XDG_STATE_HOME: 'relative/state' });
  assert.strictEqual(res.last.tokenFile, path.join(home, '.local', 'state', 'wow-ai', 'wayland-restore-token'));
  if (process.platform === 'win32') return;
  const tokenFile = path.join(TMP, 'tmpmode', 'tok');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile + '.tmp', 'old', { mode: 0o644 });
  fs.chmodSync(tokenFile + '.tmp', 0o644);
  flow(scenario({ new_restore_token: 'fresh' }), [], tokenFile);
  assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), 'fresh\n');
  assert.strictEqual(fs.statSync(tokenFile).mode & 0o777, 0o600);
});

// GstSource's buffer read, against a stand-in for a Gst.Buffer from plain PyGObject: map() would
// need gst-python's overrides, and GstVideoMeta.stride may not be readable at all.
test('frames come out of a Gst.Buffer with extract_dup, only the rows needed, stride from the size', opts, () => {
  const driver = `
import importlib.util, json, sys
sys.argv = ["capture_wayland.py"]
spec = importlib.util.spec_from_file_location("cw", ${JSON.stringify(SCRIPT)})
cw = importlib.util.module_from_spec(spec); spec.loader.exec_module(cw)
class Buf:
    def __init__(s, data): s.data, s.calls = data, []
    def get_size(s): return len(s.data)
    def extract_dup(s, off, n): s.calls.append([off, n]); return s.data[off:off + n]
    def map(s, *a): raise AssertionError("map() needs gst-python")
class Meta:
    @property
    def stride(s): raise NotImplementedError("fixed-size array field")
class GstVideo:
    @staticmethod
    def buffer_get_video_meta(b): return Meta()
w, h, stride = 10, 6, 48  # BGRx, 8 bytes of row padding
data = bytearray(stride * h)
for y in range(h):
    for x in range(w):
        o = y * stride + x * 4; data[o:o + 4] = bytes([x, y, 200, 0])
buf = Buf(bytes(data))
st = cw.meta_stride(GstVideo, buf)
f, guessed = cw.frame_from_buffer(buf, "BGRx", w, h, (4, 3), st)
full, _ = cw.frame_from_buffer(Buf(bytes(data)), "BGRx", w, h, None, 0)
print(json.dumps({"metaStride": st, "guessed": guessed, "calls": buf.calls, "size": [f.width, f.height, f.full_w, f.full_h],
  "px": f.px(3, 2), "fullPx": full.px(9, 5), "fullStride": full.stride}))
`;
  const r = spawnSync('python3', ['-c', driver], { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(out.metaStride, 0);
  assert.strictEqual(out.guessed, false);
  assert.deepStrictEqual(out.calls, [[0, 48 * 3]]);
  assert.deepStrictEqual(out.size, [4, 3, 10, 6]);
  assert.deepStrictEqual(out.px, [200, 2, 3]);
  assert.deepStrictEqual(out.fullPx, [200, 5, 9]);
  assert.strictEqual(out.fullStride, 48);
});
