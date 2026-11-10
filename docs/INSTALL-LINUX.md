# Installing on Linux (Wine)

The addon is the same; only the bridge's screen capture differs. On Linux the bridge runs `bridge/capture_x11.py` (python3 + libX11 through ctypes, no packages to install) instead of `capture.ps1`, and writes the slot files straight into the Wine prefix.

## Requirements

- An **X11** session (`echo $XDG_SESSION_TYPE` prints `x11`) for the default capture. Wayland blocks reading other windows' pixels; on Wayland (Niri, GNOME, KDE...) use the opt-in [portal capture](#wayland-niri-gnome-kde--via-xdg-desktop-portal) below.
- The game under Wine (Lutris, Bottles, a hand-made prefix...), **windowed or borderless**.
- Node.js 22.2+, python3, and at least one agent CLI logged in (see [AGENTS.md](AGENTS.md)).

## Install

```bash
git clone https://github.com/chelinho139/wow-ai
cd wow-ai
npm ci                      # only needed to run the tests
node setup.js --wow "$HOME/.wine/drive_c/Program Files (x86)/World of Warcraft/_forever_" --project ~/path/to/the/project
```

Without `--wow`, `setup.js` looks in `$WINEPREFIX`, `~/.wine` and `~/Games/battlenet`. Then fully restart the game, enable *WoW AI* on the AddOns screen, and start the bridge with `npm start`.

## Check the capture (do this once)

Log in, open the WoW AI window and send any message, then while the strip of colored squares is in the top-left corner run:

```bash
npm run probe
```

It finds the game window, saves what the capture sees to `bridge/probe.png`, and prints whether it could decode a strip. If the picture is black or stale while the game shows the strip, the compositor is letting the game flip its own buffers. Try, in order:

1. `"keepComposited": true` under `capture` in `bridge/config.json` (asks mutter/KWin to keep compositing the game window), then restart the bridge.
2. Plain windowed mode in the game settings.
3. `nvidia-settings -a AllowFlipping=0` (NVIDIA).
4. As a last resort `/wow-ai mode reload` in game: no capture at all, one UI reload per message.

`bridge.log` shows `capture: attached to window 0x...` once the window is found. If it keeps saying `waiting for Wow window`, set `capture.processName` to your executable's name, or `capture.windowName` to part of the window title. Other capture programs can be plugged in with `capture.backend` ([CAPTURE.md](CAPTURE.md)). `capture.python` picks the interpreter if `python3` is not the one on your `PATH`.

## Wayland (Niri, GNOME, KDE ...) via xdg-desktop-portal

> **Status: written against the portal and GStreamer documentation, not yet validated on a live Wayland session.** The decoder, the scaling search, the portal flow and the bridge wiring are covered by `npm test` with synthetic frames and a fake portal; the D-Bus, PipeWire and GStreamer parts are not. Work through [Checking the Wayland capture](#checking-the-wayland-capture) and report what you see. X11 stays the default (`"auto"` never picks Wayland); Wayland is opt-in with `"backend": "wayland"` under `capture` in `bridge/config.json`.

A Wayland client cannot read another window's pixels, so `bridge/capture_wayland.py` asks the desktop's ScreenCast portal (`org.freedesktop.portal.ScreenCast`, the API OBS and browsers use). You pick the WoW window once in a compositor dialog; the portal hands over a PipeWire stream, GStreamer turns frames into `BGRx` pixels and the usual strip decoder reads the top-left corner. No root, no compositor-private protocol, no input simulation.

### What is needed

| Piece | Arch / CachyOS | Debian / Ubuntu |
|---|---|---|
| PyGObject | `python-gobject` | `python3-gi` |
| GStreamer + GI data | `gstreamer` | `gir1.2-gstreamer-1.0` |
| `videoconvert`, `appsink` | `gst-plugins-base` | `gstreamer1.0-plugins-base` |
| `pipewiresrc` | `gst-plugin-pipewire` | `gstreamer1.0-pipewire` |
| `GstVideo` GI data (row stride; optional) | `gst-plugins-base-libs` | `gir1.2-gst-plugins-base-1.0` |
| Portal + a ScreenCast backend | `xdg-desktop-portal`, `xdg-desktop-portal-gnome` (Niri, GNOME), `xdg-desktop-portal-kde` (KDE) | same names |
| PipeWire | `pipewire` | `pipewire` |

```bash
# CachyOS / Arch
sudo pacman -S python-gobject gstreamer gst-plugins-base gst-plugin-pipewire xdg-desktop-portal xdg-desktop-portal-gnome pipewire
# Debian / Ubuntu
sudo apt install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-plugins-base gstreamer1.0-pipewire xdg-desktop-portal xdg-desktop-portal-gnome pipewire
```

A missing piece produces one `error` line naming it and its package (the bridge log shows `capture error: ...`), then the helper sleeps `--exit-delay` (5 s) and exits so the bridge's restart loop stays calm.

### Niri

Per the niri wiki ([Screencasting](https://github.com/YaLTeR/niri/blob/main/docs/wiki/Screencasting.md), [Important Software](https://github.com/YaLTeR/niri/blob/main/docs/wiki/Important-Software.md), [Xwayland](https://github.com/YaLTeR/niri/blob/main/docs/wiki/Xwayland.md)):

- Screencasting needs a working D-Bus session, PipeWire, **`xdg-desktop-portal-gnome`** and niri **started as a session** (`niri-session`, or from a display manager). Started bare from a TTY, the portal cannot talk to niri. `xdg-desktop-portal-wlr` is not enough: it does not offer window sharing.
- Niri casts monitors and individual windows (window casting arrived in niri 0.1.7, June 2024). It also offers a "niri Dynamic Cast Target" entry in the dialog; avoid it for this, pick the window itself.
- Do not set `GDK_BACKEND` globally; it breaks the screencast portal.
- Do not hide the game with a `block-out-from "screencast"` window rule: the stream would be solid black.
- Wine under niri runs as an X11 client through xwayland-satellite (built in since niri 25.08, needs `xwayland-satellite` >= 0.7 installed), which presents it to niri as an ordinary window the portal can list. Wine's native Wayland driver (or Proton-GE with `PROTON_ENABLE_WAYLAND=1`) is a plain Wayland window too. Both are untested with this project.

### Turn it on

```json
"capture": { "backend": "wayland" }
```

in `bridge/config.json` (merged with the other `capture` keys; `processName`, `windowName`, `cellPx`, `cellsPerRow`, `maxRows`, `intervalMs` and `python` apply as for `x11`; `keepComposited` is ignored). On a Wayland-only session with the default `"auto"`, the bridge logs a one-line suggestion to do this and keeps running the X11 capture; it never switches by itself. See [CAPTURE.md](CAPTURE.md) for backends in general.

### Run it by hand

```bash
python3 bridge/capture_wayland.py --probe-portal      # nothing is shared; checks packages and portal
python3 bridge/capture_wayland.py --probe bridge/probe.png   # or: npm run probe:wayland
python3 bridge/capture_wayland.py                     # the real thing, prints JSON lines
```

The first real run opens the compositor's share dialog: **choose the World of Warcraft window** (a window, not "Entire screen"). The helper asks for the cursor hidden and `persist_mode=2`, and stores the portal's restore token in `$XDG_STATE_HOME/wow-ai/wayland-restore-token` (default `~/.local/state/wow-ai/`, directory 0700, file 0600; `--token-file` overrides, `--no-restore` never stores one). With a valid token the dialog is skipped on the next start. Tokens are single use: the helper stores the fresh one the portal returns at once. To pick a different window, delete the file (or run with `--no-restore`). Whether the backend honours the token for windows is backend-specific; if the dialog shows every time, that is the backend, not an error.

Options in the same spirit as `capture_x11.py`: `--cell`, `--cells`, `--max-rows`, `--interval-ms`, `--process-name` / `--window-name` (only used in messages: the dialog, not the script, chooses the window), plus `--source-type auto|window|monitor`, `--slack`, `--probe-crop WxH`, `--exit-delay SECONDS`, `--on-cancel wait|exit`, `--pw-target node|serial`, `--no-always-copy`.

- **Window or monitor:** `auto` asks for a window and falls back to a whole monitor (with a `warn`) when the portal offers no window sharing. On a monitor cast the strip is searched for in the full picture (it is yellow-blue-yellow-blue-magenta at its start), which costs noticeably more CPU, and anything covering the game's top-left corner hides the strip.
- **When the stream ends** (game closed, session closed by the compositor, PipeWire gone) the helper prints an `info` line, sleeps `--exit-delay` (5 s) and exits 6; the bridge restarts it 5 s later. With a restore token the restart is silent while the window exists; with the game closed the dialog may pop up once, and then follows the next bullet, so stop the bridge when you stop playing.
- **Cancelled or ignored dialog:** one `error` line, then the helper idles instead of exiting, so the picker does not come back every few seconds. Restart the bridge (or the helper) and pick the WoW window. The same happens when nobody answers within `--portal-timeout` (300 s). `--on-cancel exit` exits 4 instead (tests).
- **Missing packages, no portal, portal failure:** one `error` line, exit 3 or 5 after `--exit-delay`. The bridge restarts the helper after 5 s, 10 s, 20 s ... up to 60 s: it only resets that backoff after a run of 30 s or more, which is why the delay is kept at 5 s. The bridge log therefore repeats the same error about once a minute until you fix it; the capture then starts on its own.
- **A restore token the portal rejects** is deleted and the dialog is shown once more.

### Scaling and alignment

A window cast may not map 1:1 onto the game's pixels (fractional output scale, HiDPI, XWayland scaling). The helper tolerates a few pixels of offset like `capture_x11.py`, and additionally measures the cell pitch: it tries your configured pitch times 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 0.8, 2/3, 0.5 and a fine sweep, then fits the exact pitch from the colour edges and locks on whatever validates (magic bytes + checksum). Nearest-neighbour and mildly blurred scaling decode. If a strip is clearly there but never validates you get a rate-limited `warn` such as `strip seen but rejected: checksum - strip-like pattern found but it does not validate, likely scaling or blur; detected cell pitch ~5.33 px instead of 4 px`. Then:

- Run the output at scale 1 (or an integer scale), or set the fractional scale off for the monitor the game is on (`output "..." { scale 1 }` in niri), or avoid the compositor scaling the XWayland surface.
- The game's own UI scale does not matter for the strip (it is drawn in UIParent pixels, see [ARCHITECTURE.md](ARCHITECTURE.md)); the output/Wine DPI scaling does.
- A picture that is blurred, colour-managed/HDR-tonemapped or video-scaled at the same pitch warns with "the cell pitch matches ... so the colours are being altered".

### Checking the Wayland capture

Manual validation for a CachyOS + Niri + WoW Forever (Wine/Lutris) PC. Do it in this order and stop at the first step that fails.

1. **Session.** `echo $XDG_SESSION_TYPE $XDG_CURRENT_DESKTOP` → `wayland niri`. `systemctl --user is-active niri.service` → `active` (niri-session). `pgrep -a xdg-desktop-portal` shows `xdg-desktop-portal` (the GNOME backend starts on demand). `journalctl --user -b -u niri | grep "X11 socket"` shows xwayland-satellite listening.
2. **Packages and portal (nothing shared).**
   ```bash
   python3 bridge/capture_wayland.py --probe-portal
   ```
   Expected: one JSON line, exit 0, `"missing":[]`, `"portal":{"version":5,"sourceTypes":["monitor","window"],"cursorModes":["hidden","embedded","metadata"]}` (version and cursor modes may differ; `window` must be listed). `missing` entries give the package to install; a `portal.error` means no ScreenCast backend or no session (see the troubleshooting table).
3. **Game up.** Start WoW Forever from Lutris/Wine, log in, open the WoW AI window and send any message so the strip of coloured squares is drawn. Keep the game window visible on its workspace (a hidden or minimised window may stop producing frames).
4. **Frame probe.**
   ```bash
   npm run probe:wayland        # = python3 bridge/capture_wayland.py --probe bridge/probe.png
   ```
   The share dialog appears: pick the **WoW window**. Expected: a JSON line with `"source":"window"`, `"streamSize":[w,h]`, `"frame":{"format":"BGRx",...}`, `"pitch":4` (or the detected scaled pitch), `"strip":{"id":N,"text":"..."}` and exit 0. Open `bridge/probe.png`: it is the top-left crop of the frame; the strip of coloured squares must be sharp. Black picture, wrong window or no strip: see the table.
5. **Restore token.** `ls -l ~/.local/state/wow-ai/wayland-restore-token` (mode `-rw-------`). Run step 4 again: with a backend that supports it the dialog does not appear and the probe succeeds immediately. Record whether it did.
6. **Live helper (optional).** `python3 bridge/capture_wayland.py --interval-ms 250` and send a message from the game: expect `{"info":"attached to Wayland window cast (WxH, PipeWire node N)"}` then `{"id":N,"text":"..."}` once per new message. Close the game window: expect an `info` line "the PipeWire stream ended" or "closed the screencast session" and exit 6 after 5 s. Stop it with Ctrl-C before the next step.
7. **Bridge with the Wayland backend.** Set `"backend": "wayland"` under `capture` in `bridge/config.json`, then `npm start`. The banner shows `capture  : on (wayland, Wow, 200x48 cells of 4px)`. `bridge.log` should show, in order: `capture: pick the Wow window in the portal dialog` (only when no token is stored), `capture: attached to Wayland window cast (WxH, PipeWire node N)`, and later `strip #N: 1 message(s)`.

#### End to end: from the game chat to an agent reply

This is the acceptance run. It needs the bridge on the same PC as the game; nothing else is installed in the game.

1. **WoW Forever under Niri.** Start the game as in step 3 (windowed or borderless, visible).
2. **Start the bridge locally** with the config from step 7 (`npm start`, leave it running). If the share dialog appears, pick the WoW window. If you change the config, restart the bridge.
3. **Choose the API agent.** If the branch that adds the OpenAI-compatible `local` agent is merged: put its block under `agents.local` in `bridge/config.json` (`baseUrl` like `http://<ollama-host>:11434/v1` and a `model`; see [AGENTS.md](AGENTS.md)), restart the bridge, and in the game chat type `/wow-ai agent local`. Otherwise use any installed agent (`/wow-ai agent claude`). Confirm the reply label later shows that agent.
4. **Send a message from the in-game chat**, for example `/ai Say PONG and name this zone.` (`/wow-ai <text>` is the same; typing into the WoW AI window works too).
5. **The bridge reads it through the Wayland backend, with no `/reload`.** Within about a second `bridge.log` shows `strip #N: 1 message(s)` followed by the agent run starting. The game must not reload its UI. If nothing appears: `capture: strip seen but rejected ...` means scaling or blur (see the table), no capture line at all means the helper is waiting for the dialog or the stream.
6. **The reply arrives in game**: the agent's closing lines in the chat frame (`[open]` shows the whole reply) and the full text in the WoW AI window, labelled with the agent that wrote it.
7. **Follow-up retaining context.** Send `/ai And what did I just ask you?`. The answer must refer to the first question (same chat, same session). Note whether it did.
8. **Restart behaviour.** Stop the bridge with Ctrl-C and start it again: with a working restore token no dialog appears and steps 4-7 work again. Record whether the dialog came back.

**If something fails**, send back: the output of steps 2 and 4 (the JSON lines), `bridge/probe.png`, the `capture:` lines from `bridge/bridge.log` (the whole run of the acceptance flow, with timestamps), `niri --version`, `pipewire --version`, `gst-inspect-1.0 pipewiresrc | head -5`, `journalctl --user -b -u xdg-desktop-portal -u xdg-desktop-portal-gnome | tail -50`, `echo $WAYLAND_DISPLAY $DISPLAY`, the niri output scale (`niri msg outputs`), and whether the game runs through xwayland-satellite or Wine's Wayland driver. The helper never writes anything else to disk besides the probe PNG and the token file.

### Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `error`: `PyGObject (python module 'gi')` / `GStreamer element 'pipewiresrc'` ... | Install the named package (table above). |
| `error`: `xdg-desktop-portal ScreenCast is not available` | No ScreenCast backend or no session bus: install `xdg-desktop-portal-gnome`, run niri through `niri-session`, make sure the helper runs inside the graphical session (not a bare ssh). |
| `warn`: `portal offers no window sharing ... falling back to a whole monitor` | The backend (e.g. `xdg-desktop-portal-wlr`) cannot share windows. Use the GNOME backend on niri, or accept monitor casting (more CPU; the corner must stay uncovered). |
| Dialog never appears, helper waits | The portal could not show it: check `journalctl --user -u xdg-desktop-portal-gnome`; `GDK_BACKEND` must not be set globally. After 300 s (`--portal-timeout`) it fails with exit 5. |
| `error`: `screen sharing was cancelled` (exit 4) | You closed the dialog. Restart the bridge and pick the WoW window. |
| `error`: `screencast portal failure ... response 2` (exit 5) | The backend refused. Delete the restore token, retry; check the portal journal. |
| Black picture in `probe.png` | A `block-out-from "screencast"` rule matches the game, or the window is hidden/minimised; the game may also render through a path the compositor does not cast. Try `--no-always-copy`, or windowed/borderless mode. |
| Dialog appears at every start | The backend does not persist selections for windows, or the token file is unwritable (`warn` says so). Not harmful. |
| `warn`: `no frames from the stream` | The window is on another workspace, minimised or occluded and the compositor pauses the cast. Bring it back. |
| `warn`: `strip seen but rejected ... detected cell pitch` | Scaling or blur; see "Scaling and alignment". |
| `error`: `... format negotiation failed` | PipeWire offered a format `videoconvert` cannot turn into BGRx (often DMA-BUF only); report `gst-inspect-1.0 pipewiresrc` and your GPU/driver. |
| `{"error":"no valid strip in image"}` from `--test-image` | Not a Wayland problem: the picture holds no strip. |

Sources used for these notes: the portal's [ScreenCast interface](https://github.com/flatpak/xdg-desktop-portal/blob/main/data/org.freedesktop.portal.ScreenCast.xml) (version 6 documented there: `types` bitmask MONITOR=1 / WINDOW=2 / VIRTUAL=4, `cursor_mode` Hidden=1, `persist_mode` 2 and single-use `restore_token` from version 4, streams carry `size` and `source_type`, the `Request::Response` signal with codes 0 / 1 cancelled / 2 other), the niri release notes for [window screencasting in 0.1.7](https://github.com/niri-wm/niri/releases/tag/v0.1.7), and GStreamer's `pipewiresrc` properties (`fd`, `path`, `target-object`, `always-copy`, `keepalive-time`).
