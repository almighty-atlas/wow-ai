#!/usr/bin/env python3
"""Wayland counterpart of capture_x11.py: screen-casts the WoW client window (or a
monitor) through the xdg-desktop-portal ScreenCast API, reads frames from PipeWire
with GStreamer and decodes the WoWAI pixel strip (see Codec.lua in the addon).
Prints one JSON line per new message to stdout, with the same
{info|warn|error|id,text} contract as the other capture scripts. Started by bridge.js.

Wayland lets no client read another window's pixels; the portal is the sanctioned
way: the user picks the game window once in a compositor dialog (a restore token
keeps the choice across restarts). Nothing here is compositor-private.

Needs, as optional system packages (imported lazily, so --test-image/--test-raw work
without them): PyGObject, GStreamer 1.x with the PipeWire plugin and gst-plugins-base,
xdg-desktop-portal and a ScreenCast backend (xdg-desktop-portal-gnome on Niri).

  capture_wayland.py --test-image strip.png   decode a PNG once and exit (tests)
  capture_wayland.py --test-raw f --width W --height H --stride S --format BGRx
  capture_wayland.py --probe-portal           report portal version/source types/missing deps
  capture_wayland.py --probe out.png          portal flow, one frame to a PNG + diagnostics
  capture_wayland.py --token-file PATH        where the portal restore token is kept

Exit codes: 3 missing dependency or no portal, 5 portal failure, 6 stream or session
ended. The bridge restarts a helper that exits (5 s, doubling to 60 s while it keeps dying
within 30 s), so these sleep --exit-delay (5 s) first: shorter than the bridge's 30 s
"healthy" mark, which keeps the backoff growing instead of resetting. A cancelled or
ignored picker is different: re-asking every few seconds would be nagging, so the helper
reports it once and then idles (restart the bridge to be asked again); --on-cancel exit
gives exit code 4 instead (tests).
"""

import argparse
import json
import math
import os
import re
import signal
import struct
import sys
import time
import zlib

EXIT_DEPS, EXIT_CANCELLED, EXIT_PORTAL, EXIT_ENDED = 3, 4, 5, 6

p = argparse.ArgumentParser()
p.add_argument("--cell", type=int, default=4)
p.add_argument("--cells", type=int, default=200)
p.add_argument("--max-rows", type=int, default=48)
p.add_argument("--interval-ms", type=int, default=250)
p.add_argument("--process-name", default="Wow",
               help="only used in messages: the portal dialog, not this script, picks the window")
p.add_argument("--window-name", default="", help="same as --process-name")
p.add_argument("--test-image", default="")
p.add_argument("--probe", default="")
p.add_argument("--probe-portal", action="store_true")
p.add_argument("--probe-crop", default="1600x600", help="size of the top-left crop --probe saves")
p.add_argument("--token-file", default="", help="restore token file (default $XDG_STATE_HOME/wow-ai/wayland-restore-token)")
p.add_argument("--no-restore", action="store_true", help="do not use or store a restore token (always show the picker)")
p.add_argument("--source-type", choices=("auto", "window", "monitor"), default="auto")
p.add_argument("--slack", type=int, default=8, help="pixels of misalignment searched around the window origin")
p.add_argument("--pw-target", choices=("node", "serial"), default="node",
               help="address the PipeWire stream by node id (path=) or by object.serial (target-object=)")
p.add_argument("--no-always-copy", action="store_true", help="leave pipewiresrc always-copy off")
p.add_argument("--portal-timeout", type=int, default=300, help="seconds to wait for the user in the picker")
p.add_argument("--exit-delay", type=float, default=5.0,
               help="seconds to sleep before exiting on errors; keep it under the bridge's 30 s healthy mark so its restart backoff grows")
p.add_argument("--on-cancel", choices=("wait", "exit"), default="wait",
               help="after a cancelled or unanswered picker: idle until the bridge stops us (default) or exit 4")
p.add_argument("--test-raw", default="")
p.add_argument("--width", type=int, default=0)
p.add_argument("--height", type=int, default=0)
p.add_argument("--stride", type=int, default=0)
p.add_argument("--format", default="BGRx")
# Test seam: a JSON scenario that replaces D-Bus, PipeWire and GStreamer (tests/capture_wayland_test.js).
p.add_argument("--fake-portal", default="", help=argparse.SUPPRESS)
args = p.parse_args()

CELL, CELLS, MAXROWS = args.cell, args.cells, args.max_rows
W, H = CELLS * CELL, MAXROWS * CELL
SLACK = args.slack
WANTED = args.window_name or args.process_name


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Frames: a pixel buffer plus its layout, whatever GStreamer (or a test) hands us
# ---------------------------------------------------------------------------

# format -> (bytes per pixel, red, green, blue byte index); GStreamer names are memory order
FORMATS = {
    "BGRx": (4, 2, 1, 0), "BGRA": (4, 2, 1, 0), "RGBx": (4, 0, 1, 2), "RGBA": (4, 0, 1, 2),
    "xRGB": (4, 1, 2, 3), "ARGB": (4, 1, 2, 3), "xBGR": (4, 3, 2, 1), "ABGR": (4, 3, 2, 1),
    "RGB": (3, 0, 1, 2), "BGR": (3, 2, 1, 0),
}


class FrameError(Exception):
    pass


class Frame:
    def __init__(self, data, width, height, stride, fmt, full_w=None, full_h=None):
        if fmt not in FORMATS:
            raise FrameError("unsupported pixel format '%s' (supported: %s)" % (fmt, ", ".join(sorted(FORMATS))))
        self.bpp, self.ro, self.go, self.bo = FORMATS[fmt]
        if width <= 0 or height <= 0:
            raise FrameError("frame size %dx%d is not valid" % (width, height))
        if stride < width * self.bpp:
            raise FrameError("stride %d is smaller than width*bytes-per-pixel (%d*%d) for format %s: "
                             "wrong stride or format" % (stride, width, self.bpp, fmt))
        need = stride * (height - 1) + width * self.bpp
        if len(data) < need:
            raise FrameError("buffer holds %d bytes but %dx%d, stride %d, format %s needs %d: "
                             "wrong size, stride or format" % (len(data), width, height, stride, fmt, need))
        self.data, self.width, self.height, self.stride, self.fmt = data, width, height, stride, fmt
        self.full_w, self.full_h = full_w or width, full_h or height

    def px(self, x, y):
        if x < 0 or y < 0 or x >= self.width or y >= self.height:
            return 0, 0, 0
        o = y * self.stride + x * self.bpp
        d = self.data
        return d[o + self.ro], d[o + self.go], d[o + self.bo]

    def crop(self, cw, ch):
        cw, ch = max(1, min(cw, self.width)), max(1, min(ch, self.height))
        if cw == self.width and ch == self.height:
            return self
        mv = memoryview(self.data)
        row = cw * self.bpp
        data = b"".join(bytes(mv[y * self.stride:y * self.stride + row]) for y in range(ch))
        return Frame(data, cw, ch, row, self.fmt, self.full_w, self.full_h)

    def rgb_rows(self, w, h):
        """The top-left w x h as packed RGB rows (for PNG output)."""
        w, h = min(w, self.width), min(h, self.height)
        mv = memoryview(self.data)
        out = bytearray()
        for y in range(h):
            src = bytes(mv[y * self.stride:y * self.stride + w * self.bpp])
            row = bytearray(w * 3)
            row[0::3], row[1::3], row[2::3] = src[self.ro::self.bpp], src[self.go::self.bpp], src[self.bo::self.bpp]
            out += b"\x00" + row
        return w, h, bytes(out)


# ---------------------------------------------------------------------------
# Decoder: identical strip rules to capture.ps1 / capture_x11.py, with a float cell
# pitch so a scaled picture (fractional scale, HiDPI, XWayland scaling) can still be read
# ---------------------------------------------------------------------------

def cell_value(px, c, r, P, ox, oy):
    rr, gg, bb = px(int(ox + (c + 0.5) * P), int(oy + (r + 0.5) * P))
    return (4 if rr >= 128 else 0) + (2 if gg >= 128 else 0) + (1 if bb >= 128 else 0)


# magic bytes 0xC7 0x1A as 3-bit cells: 6,1,6,1,5 and the top bit of the sixth cell clear
MAGIC_CELLS = (6, 1, 6, 1, 5)


def has_magic(px, P, ox, oy):
    for i, want in enumerate(MAGIC_CELLS):  # cheap exit: most candidates fail on the first cell
        if cell_value(px, i, 0, P, ox, oy) != want:
            return False
    return cell_value(px, 5, 0, P, ox, oy) < 4


def decode(px, P, ox, oy):
    acc = 0
    nbits = 0
    out = bytearray()
    needed = 6
    total = CELLS * MAXROWS
    for i in range(total):
        acc = (acc << 3) | cell_value(px, i % CELLS, i // CELLS, P, ox, oy)
        nbits += 3
        while nbits >= 8:
            out.append((acc >> (nbits - 8)) & 0xFF)
            nbits -= 8
            acc &= (1 << nbits) - 1
            if len(out) == 2 and (out[0] != 0xC7 or out[1] != 0x1A):
                return None
            if len(out) == 6:
                length = out[4] * 256 + out[5]
                needed = 8 + length
                if needed > total * 3 // 8:
                    return {"error": "length"}
            if len(out) >= needed:
                break
        if len(out) >= needed:
            break
    if len(out) < needed:
        return {"error": "truncated"}
    length = out[4] * 256 + out[5]
    s1 = s2 = 0
    for k in range(2, 6 + length):
        s1 = (s1 + out[k]) % 255
        s2 = (s2 + s1) % 255
    if out[6 + length] != s1 or out[7 + length] != s2:
        return {"error": "checksum"}
    text = bytes(out[6:6 + length]).decode("utf-8", errors="replace")
    return {"id": out[2] * 256 + out[3], "text": text}


def try_at(f, P, ox, oy):
    return decode(f.px, P, ox, oy) if has_magic(f.px, P, ox, oy) else None


def looks_like_strip(f, P, ox, oy):
    """Magic alone can show up by chance in a noisy picture; a strip is made of pure primaries."""
    pure = total = 0
    for c in range(24):
        for v in f.px(int(ox + (c + 0.5) * P), int(oy + 0.5 * P)):
            total += 1
            pure += v <= 96 or v >= 160
    return pure >= total * 0.9


# Candidate scales of the picture relative to the configured cell size.
SCALES = (1, 1.25, 1.5, 1.75, 2, 2.5, 3, 0.8, 2 / 3, 4 / 7, 0.5)


def coarse_pitches(scale_hint=None):
    out = []
    for s in ((scale_hint,) if scale_hint else ()) + SCALES:
        pp = CELL * s
        if pp >= 1.5 and all(abs(pp - q) > 0.01 for q in out):
            out.append(pp)
    return out


def fine_pitches(skip):
    step = max(0.05, CELL * 0.02)
    pp = CELL * 0.5
    while pp <= CELL * 3.5:
        if all(abs(pp - q) > 0.04 for q in skip):
            yield pp
        pp += step


def estimate_cells(f, P, ox, oy):
    """Cells the message spans, from its length field (the first 16 cells hold the 6-byte header)."""
    acc = 0
    for i in range(16):
        acc = (acc << 3) | cell_value(f.px, i, 0, P, ox, oy)
    header = acc.to_bytes(6, "big")
    length = header[4] * 256 + header[5]
    return max(24, min(CELLS, int(math.ceil((8 + length) * 8 / 3.0))))


def fit_row(f, P0, ox, oy, n):
    """Fit the real cell pitch from the colour edges along the strip's first row.
    Returns (pitch, left edge of cell 0, edges used) or None."""
    y = int(oy + 0.5 * P0)
    x0 = max(0, int(ox - P0))
    x1 = min(f.width, int(ox + n * P0 + P0) + 1)
    prev = None
    sn = sk = st = skk = skt = 0.0
    a, P = ox, P0
    for x in range(x0, x1):
        r, g, b = f.px(x, y)
        cls = (r >= 128, g >= 128, b >= 128)
        if prev is not None and cls != prev:
            k = round((x - a) / P)
            if abs(x - (a + k * P)) < 0.35 * P:
                sn += 1
                sk += k
                st += x
                skk += k * k
                skt += k * x
                den = sn * skk - sk * sk
                if sn >= 3 and den > 0:
                    P = (sn * skt - sk * st) / den
                    a = (st - P * sk) / sn
        prev = cls
    if sn < 8 or not (0.5 * P0 < P < 2.0 * P0):
        return None
    return P, a, int(sn)


def refine(f, P, ox, oy):
    """A candidate whose magic matched but whose checksum fails: re-measure pitch and origin."""
    fit = fit_row(f, P, ox, oy, estimate_cells(f, P, ox, oy))
    if not fit:
        return None, None
    Pf, af, _ = fit
    for dx, dy in ((0, 0), (0.5, 0), (-0.5, 0), (0, 0.5), (0, -0.5), (0.5, 0.5), (-0.5, -0.5)):
        r = try_at(f, Pf, af + dx, oy + dy)
        if r and "id" in r:
            return r, (Pf, af + dx, oy + dy)
    return None, Pf


# Regexes over per-pixel masks find candidate strip corners on a whole-monitor frame.
_HI = bytes(1 if i >= 128 else 0 for i in range(256))


def find_corners(f, limit=300):
    """Top-left corners of yellow runs (cell 0 of a strip is yellow): where a strip could start."""
    m = max(2, int(CELL * 0.5))
    rx = re.compile(b"\x01{%d,}" % m)
    ones = int.from_bytes(b"\x01" * f.width, "little")
    seen, out = set(), []
    for y in range(0, f.height, m):
        row = bytes(memoryview(f.data)[y * f.stride:y * f.stride + f.width * f.bpp])
        r = int.from_bytes(row[f.ro::f.bpp].translate(_HI), "little")
        g = int.from_bytes(row[f.go::f.bpp].translate(_HI), "little")
        b = int.from_bytes(row[f.bo::f.bpp].translate(_HI), "little")
        mask = (r & g & (b ^ ones)).to_bytes(f.width, "little")
        for mt in rx.finditer(mask):
            run = mt.end() - mt.start()
            if run > CELL * 4:
                continue
            at = mt.start() + run * 0.5
            # cells 0..4 of every strip are yellow, blue, yellow, blue, magenta
            if not (_blue(f.px(int(at + run), y)) and _yellow(f.px(int(at + 2 * run), y)) and _blue(f.px(int(at + 3 * run), y))):
                continue
            x, top = mt.start(), y
            while top > 0 and _yellow(f.px(x, top - 1)):
                top -= 1
            if (x, top) not in seen:
                seen.add((x, top))
                out.append((x, top))
                if len(out) >= limit:
                    return out
    return out


def _yellow(c):
    return c[0] >= 128 and c[1] >= 128 and c[2] < 128


def _blue(c):
    return c[0] < 128 and c[1] < 128 and c[2] >= 128


class Search:
    """Where the strip was last found, so steady-state decoding costs one pass."""

    def __init__(self, mode):
        self.mode = mode  # "window" or "monitor"
        self.hint = None
        self.last_fine = 0.0
        self.last_scan = 0.0
        self.scale_hint = None
        self.corners = []


def _scan(f, pitches, origins, window, rejected):
    """First (message, geometry) that validates; strip-like candidates that fail go to `rejected`."""
    for P in pitches:
        for bx, by, lo, hi in origins:
            if window:  # the strip sits at the window's top-left, a little off at most
                lo, hi = 0, int(math.ceil(SLACK * max(1.0, P / CELL)))
            for dy in range(lo, hi + 1):
                for dx in range(lo, hi + 1):
                    ox, oy = bx + dx, by + dy
                    r = try_at(f, P, ox, oy)
                    if r is None:
                        continue
                    if "id" in r:
                        return r, (P, ox, oy)
                    if looks_like_strip(f, P, ox, oy):
                        rejected.append((P, ox, oy, r))
    return None, None


def geometry(P, ox, oy):
    return {"pitch": P, "origin": (ox, oy)}


def find_and_decode(f, st, now=None):
    """Decode at the last good geometry, else search origins and pitches.
    Returns (message or None, geometry or None): a message is {id,text} or {error: ...}
    and the geometry ({pitch, origin}) says where and at what pitch it was seen."""
    now = time.time() if now is None else now
    if st.hint:
        r = try_at(f, *st.hint)
        if r is not None:
            return r, geometry(*st.hint)
        st.hint = None
    window = st.mode == "window"
    if window:
        origins = [(0, 0, 0, 0)]
    else:
        if now - st.last_scan >= 1.0 or not st.corners:
            st.corners = find_corners(f)
            st.last_scan = now
        origins = [(x, y, -2, 2) for x, y in st.corners]
    rejected = []
    coarse = coarse_pitches(st.scale_hint)
    r, hit = _scan(f, coarse, origins, window, rejected)
    if r is None and now - st.last_fine >= 2.0:
        st.last_fine = now
        r, hit = _scan(f, list(fine_pitches(coarse)), origins, window, rejected)
    if r is None and window and now - st.last_scan >= 2.0:
        # A title bar, client-side decorations or a Wine frame in the cast push the strip
        # further than --slack; look for its corner like on a monitor, but only now and then.
        st.last_scan = now
        corners = [(x, y, -2, 2) for x, y in find_corners(f) if x > SLACK or y > SLACK]
        if corners:
            r, hit = _scan(f, coarse, corners, False, rejected)
    if r is not None:
        st.hint = hit
        return r, geometry(*hit)
    first = None
    rejected.sort(key=lambda c: {"checksum": 0, "truncated": 1}.get(c[3]["error"], 2))  # closest to valid first
    for P, ox, oy, err in rejected[:3]:
        fixed, measured = refine(f, P, ox, oy)
        if fixed is not None:
            st.hint = measured
            return fixed, geometry(*measured)
        if first is None:
            first = (err, geometry(measured or P, ox, oy))
    return first if first else (None, None)


def rejection_warning(err, cand, frame):
    """Why a strip that is there does not decode: scaling is the usual reason on Wayland."""
    P = cand.get("pitch") if cand else None
    text = "strip seen but rejected: " + err
    if P and abs(P - CELL) > max(0.15, CELL * 0.03):
        text += (" - strip-like pattern found but it does not validate, likely scaling or blur; detected cell pitch ~%.2f px "
                 "instead of %d px (picture scaled ~%.2fx). Run the game and its output at integer scale 1 or an exact "
                 "multiple (see docs/INSTALL-LINUX.md)" % (P, CELL, P / CELL))
    elif P:
        text += (" - the cell pitch matches (%d px) so the colours are being altered: blur, colour management/HDR or "
                 "video scaling in the cast" % CELL)
    if frame is not None and (frame.full_w, frame.full_h) != (frame.width, frame.height):
        text += " [frame %dx%d]" % (frame.full_w, frame.full_h)
    return text


# ---------------------------------------------------------------------------
# PNG in/out (tests and --probe)
# ---------------------------------------------------------------------------

def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat = 8, b""
    width = height = depth = ctype = None
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            width, height, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if depth != 8 or ctype not in (2, 6):
        raise ValueError("only 8-bit RGB/RGBA PNGs are supported")
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = width * bpp
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride if f else 0):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(line)
        prev = line
    return Frame(b"".join(bytes(r) for r in rows), width, height, stride, "RGB" if bpp == 3 else "RGBA")


def write_png(path, frame, w, h):
    w, h, raw = frame.rgb_rows(w, h)

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return w, h


def decode_once(frame, mode="window"):
    """One-shot decode of a whole picture (tests, probes): (message, candidate)."""
    return find_and_decode(frame, Search(mode))


def report_once(frame):
    msg, cand = decode_once(frame)
    if msg and "id" in msg:
        emit(msg)
    elif msg:
        emit({"error": rejection_warning(msg["error"], cand, None)})
    else:
        emit({"error": "no valid strip in image"})


# ---------------------------------------------------------------------------
# Optional system dependencies, imported lazily
# ---------------------------------------------------------------------------

# key -> (what, Arch/CachyOS package, Debian/Ubuntu package)
DEP_HELP = {
    "gi": ("PyGObject (python module 'gi')", "python-gobject", "python3-gi"),
    "gst": ("GStreamer GObject-introspection data (Gst-1.0 typelib)", "gstreamer", "gir1.2-gstreamer-1.0"),
    "pipewiresrc": ("GStreamer element 'pipewiresrc' (PipeWire plugin)", "gst-plugin-pipewire", "gstreamer1.0-pipewire"),
    "videoconvert": ("GStreamer element 'videoconvert'", "gst-plugins-base", "gstreamer1.0-plugins-base"),
    "appsink": ("GStreamer element 'appsink'", "gst-plugins-base", "gstreamer1.0-plugins-base"),
}


def load_modules():
    """(modules dict, missing keys). WOWAI_WAYLAND_TEST_MISSING=gi,pipewiresrc,... forces misses (tests)."""
    forced = set(filter(None, os.environ.get("WOWAI_WAYLAND_TEST_MISSING", "").split(",")))
    mods, missing = {}, []
    try:
        if "gi" in forced:
            raise ImportError("forced")
        import gi
        from gi.repository import Gio, GLib
        mods.update(gi=gi, Gio=Gio, GLib=GLib)
    except (ImportError, ValueError):
        return mods, ["gi"]
    try:
        if "gst" in forced:
            raise ValueError("forced")
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst
        Gst.init(None)
        mods["Gst"] = Gst
    except (ImportError, ValueError):
        return mods, ["gst"]
    try:
        gi.require_version("GstVideo", "1.0")
        from gi.repository import GstVideo
        mods["GstVideo"] = GstVideo  # optional: row stride metadata; falls back to size/height
    except (ImportError, ValueError):
        mods["GstVideo"] = None
    for name in ("pipewiresrc", "videoconvert", "appsink"):
        if name in forced or mods["Gst"].ElementFactory.find(name) is None:
            missing.append(name)
    return mods, missing


def deps_message(missing):
    whats = [DEP_HELP[k][0] for k in missing]
    arch = sorted({DEP_HELP[k][1] for k in missing})
    deb = sorted({DEP_HELP[k][2] for k in missing})
    return ("Wayland capture is missing %s. Install - Arch/CachyOS: sudo pacman -S %s; Debian/Ubuntu: sudo apt install %s "
            "(see docs/INSTALL-LINUX.md)" % ("; ".join(whats), " ".join(arch), " ".join(deb)))


# ---------------------------------------------------------------------------
# Portal: real (Gio D-Bus + GStreamer) and the scenario-driven fake used by tests
# ---------------------------------------------------------------------------

class PortalUnavailable(Exception):
    pass


class Cancelled(Exception):
    pass


class PortalFailed(Exception):
    pass


class PortalTimeout(PortalFailed):
    pass


class PortalRejected(PortalFailed):
    """A request answered with an error response: the one failure a stale restore token explains."""
    pass


class StreamEnded(Exception):
    pass


SOURCE_NAMES = {1: "monitor", 2: "window", 4: "virtual"}
PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"


def names(mask, table):
    return [n for bit, n in sorted(table.items()) if mask & bit]


CURSOR_NAMES = {1: "hidden", 2: "embedded", 4: "metadata"}


def pick_source_type(avail, want):
    """(types bitmask to request, note or None)."""
    if want == "monitor":
        return 1, None
    if want == "window" or want == "auto":
        if avail & 2:
            return 2, None
        if want == "window":
            raise PortalFailed("this portal backend cannot share a single window (AvailableSourceTypes=%d); "
                               "use --source-type monitor or a backend with window support "
                               "(xdg-desktop-portal-gnome on Niri)" % avail)
        return 1, ("the portal offers no window sharing (xdg-desktop-portal-wlr never does); falling back to a whole "
                   "monitor: pick the monitor the game is on, the strip is searched for in the full picture, which "
                   "costs more CPU")
    return 1, None


class GioSession:
    def __init__(self, portal, handle, streams, fd, restore_token, state, requested):
        self.portal, self.handle, self.fd, self.state = portal, handle, fd, state
        node, props = streams[0]
        self.node = node
        self.serial = props.get("pipewire-serial")
        self.size = tuple(props["size"]) if props.get("size") else None
        # source_type is only reported from portal version 3; one type was asked for, so that is it
        self.source_type = props.get("source_type", requested)
        self.restore_token = restore_token

    def closed(self):
        self.portal.pump()
        return self.state["closed"]

    def open_source(self):
        return GstSource(self.portal.m, self)

    def close(self):
        if self.fd is None:
            return
        self.portal.close_session(self.handle)
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.fd = None


class GioPortal:
    def __init__(self, mods):
        self.m = mods
        self.Gio, self.GLib = mods["Gio"], mods["GLib"]
        try:
            self.bus = self.Gio.bus_get_sync(self.Gio.BusType.SESSION, None)
        except self.GLib.Error as e:
            raise PortalUnavailable("no D-Bus session bus (%s)" % e.message)
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.counter = 0

    def pump(self):
        ctx = self.GLib.MainContext.default()
        while ctx.pending():
            ctx.iteration(False)

    def _call(self, path, iface, method, params, reply, flags=None):
        return self.bus.call_sync(PORTAL_BUS, path, iface, method, params, reply,
                                  flags or self.Gio.DBusCallFlags.NONE, 10000, None)

    def info(self):
        GLib = self.GLib
        try:
            res = self._call(PORTAL_PATH, "org.freedesktop.DBus.Properties", "GetAll", GLib.Variant("(s)", (SCREENCAST,)),
                             GLib.VariantType("(a{sv})"))
        except GLib.Error as e:
            raise PortalUnavailable("org.freedesktop.portal.Desktop is not reachable (%s)" % e.message)
        d = res.unpack()[0]
        if not d:
            raise PortalUnavailable("the portal has no org.freedesktop.portal.ScreenCast interface "
                                    "(no ScreenCast backend installed)")
        return {"version": d.get("version", 1), "source_types": d.get("AvailableSourceTypes", 1),
                "cursor_modes": d.get("AvailableCursorModes", 0)}

    def _request(self, method, build, timeout):
        """Subscribe to the Request's Response before calling (the portal may answer instantly)."""
        GLib, Gio = self.GLib, self.Gio
        self.counter += 1
        token = "wowai%d_%d" % (os.getpid(), self.counter)
        req = "/org/freedesktop/portal/desktop/request/%s/%s" % (self.sender, token)
        box = {}

        def on_response(_c, _s, _p, _i, _n, params, *_rest):
            box["r"] = params.unpack()
        sub = self.bus.signal_subscribe(PORTAL_BUS, "org.freedesktop.portal.Request", "Response", req, None,
                                        Gio.DBusSignalFlags.NONE, on_response)
        try:
            try:
                build(token)
            except GLib.Error as e:
                raise PortalFailed("%s failed: %s" % (method, e.message))
            deadline = time.time() + timeout
            while "r" not in box:
                if time.time() > deadline:
                    if method == "Start":  # only Start waits for the user
                        raise PortalTimeout("timed out waiting for %s" % method)
                    raise PortalFailed("the portal backend did not answer %s within %d s (is xdg-desktop-portal-gnome "
                                       "installed and the compositor started as a systemd session, e.g. niri-session?)"
                                       % (method, timeout))
                self.pump()
                time.sleep(0.02)
        finally:
            self.bus.signal_unsubscribe(sub)
        code, results = box["r"]
        if code == 1:
            raise Cancelled()
        if code != 0:
            raise PortalRejected("%s returned response %d (the portal backend refused or failed)" % (method, code))
        return results

    def start(self, info, want, token, hide_cursor=True):
        GLib, Gio = self.GLib, self.Gio
        V = GLib.Variant
        types, note = pick_source_type(info["source_types"], want)
        if note:
            emit({"warn": note})
        session_token = "wowai_s%d_%d" % (os.getpid(), self.counter + 1)

        def create(t):
            self._call(PORTAL_PATH, SCREENCAST, "CreateSession",
                       V("(a{sv})", ({"handle_token": V("s", t), "session_handle_token": V("s", session_token)},)),
                       GLib.VariantType("(o)"))
        res = self._request("CreateSession", create, 30)
        handle = res["session_handle"]
        state = {"closed": False}
        sub = self.bus.signal_subscribe(PORTAL_BUS, "org.freedesktop.portal.Session", "Closed", handle, None,
                                        Gio.DBusSignalFlags.NONE, lambda *_a: state.__setitem__("closed", True))

        def select(t):
            opts = {"handle_token": V("s", t), "types": V("u", types), "multiple": V("b", False)}
            if hide_cursor and info["version"] >= 2 and info["cursor_modes"] & 1:
                opts["cursor_mode"] = V("u", 1)
            if info["version"] >= 4 and not args.no_restore:
                opts["persist_mode"] = V("u", 2)
                if token:
                    opts["restore_token"] = V("s", token)
            self._call(PORTAL_PATH, SCREENCAST, "SelectSources", V("(oa{sv})", (handle, opts)), GLib.VariantType("(o)"))

        def start(t):
            self._call(PORTAL_PATH, SCREENCAST, "Start", V("(osa{sv})", (handle, "", {"handle_token": V("s", t)})),
                       GLib.VariantType("(o)"))
        try:
            self._request("SelectSources", select, 30)
            emit({"info": "restoring the previous screencast selection (the portal dialog appears if it is not accepted)"
                  if token else "pick the %s %s in the portal dialog" % (WANTED, "window" if types == 2 else "monitor")})
            res = self._request("Start", start, args.portal_timeout)
            streams = res.get("streams") or []
            if not streams:
                raise PortalFailed("the portal returned no stream")
            try:
                out, fds = self.bus.call_with_unix_fd_list_sync(
                    PORTAL_BUS, PORTAL_PATH, SCREENCAST, "OpenPipeWireRemote", V("(oa{sv})", (handle, {})),
                    GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, 10000, None, None)
                fd = fds.get(out.unpack()[0])
            except GLib.Error as e:
                raise PortalFailed("OpenPipeWireRemote failed: %s" % e.message)
        except Exception:
            self.close_session(handle)
            self.bus.signal_unsubscribe(sub)
            raise
        return GioSession(self, handle, streams, fd, res.get("restore_token"), state, types)

    def close_session(self, handle):
        try:
            self.bus.call_sync(PORTAL_BUS, handle, "org.freedesktop.portal.Session", "Close", None, None,
                               self.Gio.DBusCallFlags.NONE, 2000, None)
        except Exception:
            pass


def meta_stride(GstVideo, buf):
    """Row stride from the buffer's GstVideoMeta, or 0. stride is a fixed-size array field, which
    not every PyGObject version can read."""
    try:
        meta = GstVideo.buffer_get_video_meta(buf) if GstVideo else None
        return int(meta.stride[0]) if meta is not None else 0
    except (TypeError, ValueError, AttributeError, IndexError, NotImplementedError):
        return 0


def frame_from_buffer(buf, fmt, w, h, crop, stride=0):
    """(Frame, stride guessed from an uneven size). Gst.Buffer.extract_dup is core API; buf.map() only
    yields usable bytes with gst-python's overrides installed. Only the rows the crop needs are copied."""
    size = buf.get_size()
    guessed = False
    if not stride:
        stride = size // h
        guessed = bool(size % h)
    rows = max(1, min(h, crop[1])) if crop else h
    f = Frame(buf.extract_dup(0, min(size, stride * rows)), w, rows, stride, fmt, w, h)
    return (f.crop(crop[0], rows) if crop else f), guessed


class GstSource:
    def __init__(self, mods, session):
        self.Gst, self.GstVideo = mods["Gst"], mods["GstVideo"]
        Gst = self.Gst
        if session.serial is not None and args.pw_target == "serial":
            target = "target-object=%d" % session.serial
        else:
            target = "path=%d" % session.node
        keep = max(250, args.interval_ms)
        desc = ("pipewiresrc fd=%d %s always-copy=%s keepalive-time=%d do-timestamp=true "
                "! video/x-raw ! videoconvert ! video/x-raw,format=BGRx "
                "! appsink name=sink max-buffers=1 drop=true sync=false emit-signals=false"
                % (session.fd, target, "false" if args.no_always_copy else "true", keep))
        try:
            self.pipeline = Gst.parse_launch(desc)
        except Exception as e:
            raise PortalFailed("cannot build the GStreamer pipeline: %s" % e)
        self.sink = self.pipeline.get_by_name("sink")
        self.bus = self.pipeline.get_bus()
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise PortalFailed("GStreamer could not start the PipeWire pipeline (is PipeWire running?)")
        self.warned_format = False

    def _check_bus(self):
        Gst = self.Gst
        msg = self.bus.timed_pop_filtered(0, Gst.MessageType.ERROR | Gst.MessageType.EOS)
        if not msg:
            return
        if msg.type == Gst.MessageType.EOS:
            raise StreamEnded("the PipeWire stream ended (the shared window was closed or the compositor stopped the cast)")
        err, dbg = msg.parse_error()
        text = err.message
        if "negotiat" in text.lower() or "not-negotiated" in (dbg or ""):
            text += " - format negotiation failed; the stream offers a format videoconvert cannot turn into BGRx"
        raise StreamEnded("GStreamer error: " + text)

    def next_frame(self, timeout, crop):
        self._check_bus()
        sample = self.sink.emit("try-pull-sample", int(timeout * self.Gst.SECOND))
        if sample is None:
            self._check_bus()
            return None
        buf, caps = sample.get_buffer(), sample.get_caps()
        s = caps.get_structure(0)
        fmt, w, h = s.get_string("format"), s.get_value("width"), s.get_value("height")
        f, guessed = frame_from_buffer(buf, fmt, w, h, crop, meta_stride(self.GstVideo, buf))
        if guessed and not self.warned_format:
            self.warned_format = True
            emit({"warn": "frame buffer of %d bytes is not a multiple of its height %d; guessing stride %d" % (buf.get_size(), h, f.stride)})
        return f

    def close(self):
        try:
            self.pipeline.set_state(self.Gst.State.NULL)
        except Exception:
            pass


class FakeSession:
    """Scenario-driven stand-in for a portal session (tests only)."""

    def __init__(self, sc, token, requested):
        self.sc, self.restore_token = sc, sc.get("new_restore_token")
        st = (sc.get("streams") or [{}])[0]
        self.node, self.serial = st.get("node", 1), st.get("serial")
        self.size = tuple(st["size"]) if st.get("size") else None
        self.source_type = st.get("source_type", requested)
        self.frames = list(sc.get("frames") or [])
        self.token_used = token

    def closed(self):
        return False

    def open_source(self):
        return FakeSource(self)

    def close(self):
        pass


class FakeSource:
    def __init__(self, session):
        self.session = session

    def next_frame(self, timeout, crop):
        sc = self.session.sc
        if not self.session.frames:
            after = sc.get("after", "closed")
            if after == "hold":
                time.sleep(timeout)
                return None
            raise StreamEnded({"closed": "the portal closed the screencast session (the shared window went away?)",
                               "eos": "the PipeWire stream ended (the shared window was closed or the compositor stopped the cast)",
                               "error": "GStreamer error: Internal data stream error."}.get(after, after))
        spec = self.session.frames.pop(0)
        if "png" in spec:
            f = read_png(spec["png"])
        else:
            f = load_raw(spec["raw"], spec["width"], spec["height"], spec.get("stride", 0), spec.get("format", "BGRx"))
        return f.crop(*crop) if crop else f

    def close(self):
        pass


class FakePortal:
    def __init__(self, path):
        self.sc = json.load(open(path))
        self.attempt = 0

    def info(self):
        kind = self.sc.get("portal", "ok")
        if kind == "unavailable":
            raise PortalUnavailable("org.freedesktop.portal.Desktop is not reachable (fake)")
        if kind == "no-screencast":
            raise PortalUnavailable("the portal has no org.freedesktop.portal.ScreenCast interface (fake)")
        return {"version": self.sc.get("version", 5), "source_types": self.sc.get("source_types", 3),
                "cursor_modes": self.sc.get("cursor_modes", 7)}

    def start(self, info, want, token, hide_cursor=True):
        sc = dict(self.sc)
        attempts = sc.get("attempts") or []
        if self.attempt < len(attempts):
            sc.update(attempts[self.attempt])
        self.attempt += 1
        types, note = pick_source_type(info["source_types"], want)
        if note:
            emit({"warn": note})
        sc.setdefault("streams", [{"node": 1, "size": [1920, 1080], "source_type": types}])
        if token and sc.get("restore_token_in") not in (None, token):
            raise PortalRejected("SelectSources returned response 2 (restore token rejected)")
        if sc.get("open_remote_fails"):
            raise PortalFailed("OpenPipeWireRemote failed: (fake)")
        resp = sc.get("start_response", 0)
        if resp == 1:
            raise Cancelled()
        if resp != 0:
            raise PortalRejected("Start returned response %d (the portal backend refused or failed)" % resp)
        emit({"info": "starting the screencast"})
        return FakeSession(sc, token, types)

    def pump(self):
        pass


# ---------------------------------------------------------------------------
# Restore token (user-private file)
# ---------------------------------------------------------------------------

def token_path():
    if args.token_file:
        return args.token_file
    base = os.environ.get("XDG_STATE_HOME", "")
    if not os.path.isabs(base):  # the XDG spec says to ignore a relative value
        base = os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "wow-ai", "wayland-restore-token")


def load_token():
    if args.no_restore:
        return None
    try:
        return open(token_path()).read().strip() or None
    except OSError:
        return None


def save_token(token):
    if args.no_restore or not token:
        return
    path = token_path()
    try:
        os.makedirs(os.path.dirname(path) or ".", mode=0o700, exist_ok=True)
        tmp = path + ".tmp"
        try:  # a leftover tmp file would keep its old permissions
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(token + "\n")
        os.replace(tmp, path)
    except OSError as e:
        emit({"warn": "cannot store the portal restore token (%s); you will be asked again next time" % e})


def drop_token():
    try:
        os.unlink(token_path())
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Capture
# ---------------------------------------------------------------------------

def load_raw(path, width, height, stride, fmt):
    bpp = FORMATS[fmt][0] if fmt in FORMATS else 4
    return Frame(open(path, "rb").read(), width, height, stride or width * bpp, fmt)


def die(code, obj, delay=0.0):
    emit(obj)
    if delay:
        time.sleep(delay)
    sys.exit(code)


def stand_down(message):
    """The user declined (or ignored) the picker: say so once and stop asking. Exiting would make the
    bridge restart us and pop the dialog up again every few seconds."""
    emit({"error": message})
    if args.on_cancel == "exit" or args.probe:  # a probe runs from a shell that stays around
        sys.exit(EXIT_CANCELLED)
    parent = os.getppid()
    while os.getppid() == parent:  # an orphaned helper (bridge gone) must not linger
        time.sleep(2)
    sys.exit(0)


def describe_info(info):
    return {"version": info["version"], "sourceTypes": names(info["source_types"], SOURCE_NAMES),
            "cursorModes": names(info["cursor_modes"], CURSOR_NAMES)}


PORTAL_HELP = ("Install xdg-desktop-portal and a ScreenCast backend (Arch/CachyOS: sudo pacman -S xdg-desktop-portal "
               "xdg-desktop-portal-gnome pipewire; Debian/Ubuntu: sudo apt install xdg-desktop-portal "
               "xdg-desktop-portal-gnome pipewire) and run the compositor as a systemd session (niri-session) so "
               "the portal can reach it; see docs/INSTALL-LINUX.md")


def make_portal():
    """(portal, mods) with every dependency checked; exits with one clear error otherwise."""
    if args.fake_portal:
        return FakePortal(args.fake_portal), {}
    mods, missing = load_modules()
    if missing:
        die(EXIT_DEPS, {"error": deps_message(missing)}, args.exit_delay)
    try:
        return GioPortal(mods), mods
    except PortalUnavailable as e:
        die(EXIT_DEPS, {"error": "xdg-desktop-portal ScreenCast is not available: %s. %s" % (e, PORTAL_HELP)}, args.exit_delay)


def get_info(portal):
    try:
        return portal.info()
    except PortalUnavailable as e:
        die(EXIT_DEPS, {"error": "xdg-desktop-portal ScreenCast is not available: %s. %s" % (e, PORTAL_HELP)}, args.exit_delay)


def acquire(portal, info):
    """Run the portal flow. A rejected restore token is dropped and the picker asked once more."""
    token = load_token()
    for attempt in (1, 2):
        try:
            session = portal.start(info, args.source_type, token)
            break
        except Cancelled:
            stand_down("screen sharing was cancelled in the portal dialog; restart the bridge and pick the %s window - "
                       "nothing can be decoded without it" % WANTED)
        except PortalTimeout:
            stand_down("nothing was chosen in the portal dialog within %d s; restart the bridge and pick the %s window"
                       % (args.portal_timeout, WANTED))
        except PortalFailed as e:
            if token and attempt == 1 and isinstance(e, PortalRejected):
                drop_token()
                token = None
                emit({"info": "the stored restore token was not accepted (%s); asking again" % e})
                continue
            die(EXIT_PORTAL, {"error": "screencast portal failure: %s" % e}, args.exit_delay)
    if session.restore_token:
        save_token(session.restore_token)  # tokens are single use: keep the new one at once
    elif not args.no_restore and info["version"] >= 4 and not args.fake_portal:
        emit({"info": "the portal returned no restore token; the picker will show again after a restart"})
    return session


def source_label(session):
    kind = SOURCE_NAMES.get(session.source_type, "source")
    size = "%dx%d" % session.size if session.size else "unknown size"
    return "attached to Wayland %s cast (%s, PipeWire node %s)" % (kind, size, session.node)


def make_search(session):
    return Search("window" if session.source_type == 2 else "monitor")


def region_for(st):
    """How much of a frame to copy: just the strip once found, a generous corner while searching."""
    if st.hint:
        P, ox, oy = st.hint
        return int(ox + CELLS * P) + 16, int(oy + MAXROWS * P) + 16
    if st.mode == "monitor":
        return None
    smax = 3.5
    return int(W * smax + SLACK * smax) + 16, int(H * smax + SLACK * smax) + 16


def stream_loop(session, source):
    st = make_search(session)
    last_key = None
    last_warn = 0.0
    last_frame = time.time()
    attached = False
    interval = args.interval_ms / 1000.0
    dims = None
    while True:
        started = time.time()
        if session.closed():
            raise StreamEnded("the portal closed the screencast session (the shared window went away?)")
        f = source.next_frame(min(max(interval, 0.05), 0.5), region_for(st))
        if f is None:
            if time.time() - last_frame > 10 and time.time() - last_warn >= 10:
                last_warn = time.time()
                emit({"warn": "no frames from the stream for %d s (window minimised or on another workspace? "
                              "compositors may pause the cast)" % (time.time() - last_frame)})
            continue
        last_frame = time.time()
        if not attached:
            attached = True
            emit({"info": source_label(session)})
        if dims != (f.full_w, f.full_h):
            if dims is not None:
                st.hint = None
            dims = (f.full_w, f.full_h)
            if session.size and session.size[0] and f.full_w != session.size[0]:
                st.scale_hint = f.full_w / float(session.size[0])
                if abs(st.scale_hint - 1) > 0.01:
                    emit({"info": "frame is %dx%d but the compositor reports %dx%d: the cast is scaled by ~%.2f, "
                                  "searching for that cell pitch" % (f.full_w, f.full_h, session.size[0], session.size[1], st.scale_hint)})
        msg, cand = find_and_decode(f, st)
        if msg and "error" in msg:
            if time.time() - last_warn >= 5:
                last_warn = time.time()
                emit({"warn": rejection_warning(msg["error"], cand, f)})
        elif msg:
            key = "%d:%s" % (msg["id"], msg["text"])
            if key != last_key:
                last_key = key
                emit(msg)
        rest = interval - (time.time() - started)
        if rest > 0:
            end = time.time() + rest
            while time.time() < end:
                if session.closed():
                    break
                time.sleep(min(0.05, max(0, end - time.time())))


def probe_portal():
    mods, missing = ({}, []) if args.fake_portal else load_modules()
    out = {"info": "wayland capture probe", "session": os.environ.get("XDG_SESSION_TYPE", ""),
           "desktop": os.environ.get("XDG_CURRENT_DESKTOP", ""), "missing": [DEP_HELP[k][0] for k in missing],
           "tokenFile": token_path(), "tokenStored": load_token() is not None}
    ok = not missing
    if "Gio" in mods or args.fake_portal:
        try:
            portal = FakePortal(args.fake_portal) if args.fake_portal else GioPortal(mods)
            out["portal"] = describe_info(portal.info())
            if not (portal.info()["source_types"] & 2):
                out["note"] = "no window sharing: only a whole monitor can be cast (the strip is searched in the full picture)"
        except PortalUnavailable as e:
            out["portal"] = {"error": str(e)}
            out["hint"] = PORTAL_HELP
            ok = False
    if missing:
        out["hint"] = deps_message(missing)
    emit(out)
    sys.exit(0 if ok else EXIT_DEPS)


def probe(portal, info):
    w, h = (int(v) for v in args.probe_crop.lower().split("x"))
    session = acquire(portal, info)
    source = session.open_source()
    try:
        st = make_search(session)
        deadline = time.time() + 20
        f = None
        while f is None and time.time() < deadline:
            f = source.next_frame(0.5, None)
        if f is None:
            die(1, {"error": "no frame arrived from the stream within 20 s"})
        if session.size and session.size[0] and f.full_w != session.size[0]:
            st.scale_hint = f.full_w / float(session.size[0])
        msg, cand = find_and_decode(f, st)
        out_w, out_h = write_png(args.probe, f, w, h)
        res = {"info": "saved %dx%d crop of a %dx%d frame to %s" % (out_w, out_h, f.full_w, f.full_h, args.probe),
               "portal": describe_info(info), "source": SOURCE_NAMES.get(session.source_type, session.source_type),
               "streamSize": list(session.size) if session.size else None,
               "frame": {"width": f.width, "height": f.height, "stride": f.stride, "format": f.fmt},
               "restoreToken": bool(session.restore_token),
               "strip": msg if msg and "id" in msg else None}
        if cand:
            res["pitch"] = round(cand["pitch"], 3)
            res["origin"] = [round(v, 2) for v in cand["origin"]]
        if msg and "error" in msg:
            res["rejected"] = rejection_warning(msg["error"], cand, f)
        elif not msg:
            res["rejected"] = "no strip found in this frame (is the WoW AI window open with a message sent?)"
        emit(res)
    finally:
        source.close()
        session.close()


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if args.test_image:
        report_once(read_png(args.test_image))
        sys.exit(0)
    if args.test_raw:
        try:
            report_once(load_raw(args.test_raw, args.width, args.height, args.stride, args.format))
        except FrameError as e:
            emit({"error": "raw frame: %s" % e})
            sys.exit(1)
        sys.exit(0)
    if args.probe_portal:
        probe_portal()
    portal, _mods = make_portal()
    info = get_info(portal)
    if args.probe:
        probe(portal, info)
        return
    session = acquire(portal, info)
    source = session.open_source()
    try:
        stream_loop(session, source)
    except StreamEnded as e:
        # Exit rather than re-negotiate in place: the bridge restarts us, and the restore token
        # (when the backend honours it) re-attaches without the picker.
        emit({"info": "%s; exiting so the bridge restarts the capture" % e})
        source.close()
        session.close()
        time.sleep(args.exit_delay)
        sys.exit(EXIT_ENDED)
    finally:
        source.close()
        session.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (FrameError, ValueError, OSError) as e:
        emit({"error": "%s: %s" % (type(e).__name__, e)})
        sys.exit(1)
