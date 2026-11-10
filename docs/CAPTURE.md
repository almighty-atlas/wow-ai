# Capture backends

The addon draws a strip of colored squares in the top-left corner of the game window, and something on the bridge PC has to read those pixels back. That something is a *capture backend*: a program the bridge starts, that prints what it decodes as JSON lines. The bridge ships four and can run any other that follows the contract below. Pixels out of the game are described in [ARCHITECTURE.md](ARCHITECTURE.md) ("Outbound"); this page is about the program that reads them.

## Choosing a backend

`capture.backend` in `bridge/config.json` (see [CONFIGURATION.md](CONFIGURATION.md)):

| Value | Runs | Platforms |
|---|---|---|
| `"auto"` (default, also when the key is missing) | `windows` on Windows, `mac` on macOS, `x11` everywhere else | all |
| `"windows"` | `bridge/capture.ps1` (GDI) | Windows only |
| `"mac"` | `bridge/capture_mac.py` (`screencapture`) | macOS only |
| `"x11"` | `bridge/capture_x11.py` (libX11 through ctypes) | any; needs an X display |
| `"wayland"` | `bridge/capture_wayland.py` (xdg-desktop-portal ScreenCast + PipeWire + GStreamer; see [INSTALL-LINUX.md](INSTALL-LINUX.md#wayland-niri-gnome-kde--via-xdg-desktop-portal)) | Linux and the BSDs; opt-in, `auto` never picks it |
| `"command"` | your program: `capture.command` with `capture.args` | any |

`windows`, `mac` and `wayland` need OS facilities that exist only on their own platforms, so choosing them elsewhere is a configuration error: the bridge logs it, runs without capture (the SavedVariables `/reload` path keeps working) and the banner says `capture  : NOT STARTED - ...`. An unknown name, a `command` backend without `capture.command`, or `capture.args` that is not an array of strings is treated the same way. Fix `config.json` and restart the bridge.

`wayland` takes the same settings as `x11` (`python`, `processName`, `windowName`, the strip geometry and `intervalMs`) and adds no keys of its own: the compositor's dialog, not the config, chooses the window. On a Wayland-only session with `auto`, the bridge logs a hint to set `"backend": "wayland"` and keeps running `x11`. A helper that cannot do anything useful (missing packages, no portal) should exit quickly, below the 30 s that count as a healthy run, so the restart backoff keeps growing; one that was declined by the user should say so once and stay idle instead of being restarted into asking again (`capture_wayland.py` does both).

The `capture :` line of the banner shows what runs, e.g. `on (x11 auto, Wow, 200x48 cells of 4px)`; `auto` is appended when the backend was picked by platform.

## The contract

### Process

- The bridge starts the program when it starts, with stdin closed, stdout and stderr piped. It is never started through a shell: `capture.command` is the executable (a path, or a name found on `PATH`) and `capture.args` is passed verbatim (arguments are not resolved: use absolute paths). A relative `capture.command` that contains a path separator (`tools/cap.sh`) is taken from the repository folder, not from where the bridge was started; a bare name is looked up on `PATH`. A script must be executable and start with a shebang line; on Windows, point `command` at the interpreter (`"python"` with the script in `args`), not at a `.cmd`/`.bat` file, which Node refuses to start. If the start itself fails the bridge logs it and retries with the backoff below instead of stopping.
- It should run until it is stopped, capturing every `capture.intervalMs`.
- If it exits, for any reason, the bridge starts it again after 5 s. While it keeps dying within 30 s of starting, the wait doubles (10, 20, 40 s) up to 60 s; a run of 30 s or more resets it to 5 s. A program that cannot be started at all (`ENOENT`, no permission) logs one message naming the backend, the command and the config key to fix, and is retried with the same backoff.
- When the bridge exits normally or crashes it asks the program to stop. When it is killed by a signal (Ctrl+C is fine, `kill` of the supervisor is not) nothing runs that could do so, so a backend must stop by itself: exit when stdout is closed or a write fails (`EPIPE`), or when its parent is gone (on POSIX, `os.getppid()` changes). On Windows only the program itself is stopped, not processes it started in turn.
- The bridge's working directory and environment are inherited, with the variables below added.

### stdout: JSON lines

One JSON object per line, UTF-8, `\n`-terminated, flushed after each line. Lines that are not a JSON object are ignored, so a stray debug print does no harm. An object is read by the first matching rule:

| Message | Meaning |
|---|---|
| `{"info": "text"}` | Progress worth a log line (`attached to window ...`, `waiting for Wow window`). Logged as `capture: text`. |
| `{"warn": "text"}` | Something is off but capture continues (`strip seen but rejected: checksum`). Logged as `capture: text`. Rate-limit these; the built-in decoders emit them at most every few seconds. |
| `{"error": "text"}` | A failure. Logged as `capture error: text`. It does not stop the program; exit if you cannot continue. |
| `{"id": <integer>, "text": "<string>"}` | A decoded strip: the payload the addon sent. Handed to the bridge's message handling. |

`id` is the strip's header id (0-65535): the addon's id of its newest unacknowledged message modulo 65536. It is not a per-strip counter; when older messages are acknowledged the same id can be redrawn with different text. `text` is the payload as the addon wrote it, decoded as UTF-8 (the built-in decoders turn invalid bytes into U+FFFD) and not trimmed or otherwise altered. For the current format that is one or more records separated by `\x1E`, each with fields separated by `\x1F` (session, chat, message id, folder, flags, name, optional context, text); the bridge splits them (`jobsFromStrip` in `protocol.js`), so the backend must not.

What the built-in decoders guarantee, and a backend should too:

- A strip is accepted only if it starts with the magic bytes `0xC7 0x1A`, its length fits the grid, and the two-byte Fletcher-style checksum over id, length and payload matches. Anything else is a `warn` at most, never an `id` message. The exact bit layout is `Codec.lua` in the addon; the decoder rules are in `decode()` in `bridge/capture_x11.py`.
- A message is emitted once: the decoders remember the last `id` and `text` and print only when either changes (the same id with new text is a new message), so a strip that stays up for seconds is not re-sent. (The bridge also de-duplicates by message id, but spamming it fills the log.)
- Cells are sampled at their center, tolerating gamma and noise (`tests/codec_test.js` renders and decodes noisy images).

### stderr

Everything on stderr is logged as `capture stderr: ...` (first 300 characters of each chunk). Use it for crashes and tracebacks.

### Environment

These are set for the `command` backend (the built-in backends get the same values as command line options). All are strings; `WINDOW_NAME` may be empty.

| Variable | From | Meaning |
|---|---|---|
| `WOW_AI_CAPTURE_CELL_PX` | `capture.cellPx` | Pixels per strip cell (default 4). |
| `WOW_AI_CAPTURE_CELLS_PER_ROW` | `capture.cellsPerRow` | Cells per strip row (default 200). |
| `WOW_AI_CAPTURE_MAX_ROWS` | `capture.maxRows` | Maximum strip rows (default 48). |
| `WOW_AI_CAPTURE_INTERVAL_MS` | `capture.intervalMs` | Capture period (default 250). |
| `WOW_AI_CAPTURE_PROCESS_NAME` | `capture.processName` | Game executable name without `.exe` (default `Wow`). |
| `WOW_AI_CAPTURE_WINDOW_NAME` | `capture.windowName` | Title substring to find the window by; empty when unset. |
| `WOW_AI_CAPTURE_CLIENT_FOLDER` | folder of `addonDir`'s client | Client folder name, e.g. `_forever_`; empty when unknown. |

The strip is `cellsPerRow × cellPx` wide and `maxRows × cellPx` tall (800 × 192 by default) in the top-left corner of the game's client area; see [CONFIGURATION.md](CONFIGURATION.md).

## Example

`config.json`:

```json
"capture": {
  "backend": "command",
  "command": "python3",
  "args": ["/home/me/my_capture.py"]
}
```

`my_capture.py`, a minimal backend that hands over to the X11 decoder with the bridge's settings (put your own screen grab and decoder in its place). `os.execv` makes the decoder this very process, so when the bridge stops the backend it stops the decoder too; a wrapper that starts a child instead has to pass that signal on itself:

```python
#!/usr/bin/env python3
import json, os, sys

env = os.environ
cmd = [sys.executable, "/path/to/wow-ai/bridge/capture_x11.py",
       "--cell", env["WOW_AI_CAPTURE_CELL_PX"], "--cells", env["WOW_AI_CAPTURE_CELLS_PER_ROW"],
       "--max-rows", env["WOW_AI_CAPTURE_MAX_ROWS"], "--interval-ms", env["WOW_AI_CAPTURE_INTERVAL_MS"],
       "--process-name", env["WOW_AI_CAPTURE_PROCESS_NAME"]]
print(json.dumps({"info": "my_capture handing over to capture_x11.py"}), flush=True)
os.execv(sys.executable, cmd)   # from here on capture_x11.py prints {"id": 12, "text": "..."} and friends
```

To try a backend without the game, have it print `{"id": 1, "text": "..."}` for a payload copied from a `strip #N` log line's source, or run the bridge with `--inject "text"` to test only the agent side.

## Adding a backend to the bridge

A backend that ships with the bridge is one entry in `BACKENDS` in `bridge/capture.js` (its `id`, the `platforms` it runs on, and a `build(cap, ctx)` returning the program, argv, extra environment and a hint for spawn failures), a row in the table above, and a case in `tests/capture_test.js`. Nothing else in the bridge changes.
