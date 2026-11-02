#!/usr/bin/env python3
"""Generate the Claude Companion icons: a graphite Pocket key with the app's orange 9x9 pixel paw.

The paw is the same bitmap the UI draws (PIX.paw in ui/js/ui.js), on whole-pixel cells so small sizes stay
crisp; the key body is the dark plastic of Collegiapp's Pocket design (P9 chrome #2a2722, accent #ff5b1f).

Python stdlib only:

    python src-tauri/icons/gen_icons.py

Writes next to this script: 32x32.png, 128x128.png, 128x128@2x.png, icon.png (512), tray.png (32, paw only),
icon.ico (16-64 as 32-bit BMP entries + 256 as PNG), icon.icns (PNG entries on the macOS 824/1024 grid).
"""

import os
import struct
import zlib

OUT = os.path.dirname(os.path.abspath(__file__))

PAW = "..##.##..|..##.##..|##.....##|##.....##|...###...|..#####..|.#######.|.#######.|..#####.."


def hexc(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


BODY_TOP, BODY_BOT, LIP = hexc("#45403a"), hexc("#2a2722"), hexc("#0b0a09")
ACC_TOP, ACC = hexc("#ff8a55"), hexc("#ff5b1f")
RING = hexc("#000000")


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def inside_round(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(n, tray=False, mac=False):
    px = [[(0, 0, 0, 0) for _ in range(n)] for _ in range(n)]
    if mac:
        m = n * 100 / 1024
        x0, y0, x1, y1 = m, m * .9, n - m, n - m * 1.1
    else:
        m = 0 if n <= 32 else n * .03
        x0, y0, x1, y1 = m, m, n - m, n - m
    r = (x1 - x0) * .22
    lip = max(1.0, n * .035)
    if not tray:
        ss = 4
        for y in range(n):
            for x in range(n):
                body = rim = 0
                for sy in range(ss):
                    for sx in range(ss):
                        fx, fy = x + (sx + .5) / ss, y + (sy + .5) / ss
                        if inside_round(fx, fy, x0, y0, x1, y1 - lip, r):
                            body += 1
                        elif inside_round(fx, fy, x0, y0, x1, y1, r):
                            rim += 1
                cov = (body + rim) / (ss * ss)
                if cov == 0:
                    continue
                t = (y - y0) / max(1, (y1 - y0))
                col = mix(BODY_TOP, BODY_BOT, min(1, max(0, t)))
                if rim > body:
                    col = LIP
                px[y][x] = col + (round(255 * cov),)
    # the paw on whole-pixel cells, centred on the key face
    face = (x1 - x0) if not tray else n
    cell = max(1, int(face * (.62 if not tray else 1.0) / 9))
    size = cell * 9
    ox = round((n - size) / 2)
    oy = round(((y0 + y1 - lip) / 2 if not tray else n / 2) - size / 2)
    rows = PAW.split("|")
    for gy, row in enumerate(rows):
        for gx, ch in enumerate(row):
            if ch != "#":
                continue
            for y in range(oy + gy * cell, oy + (gy + 1) * cell):
                for x in range(ox + gx * cell, ox + (gx + 1) * cell):
                    if 0 <= x < n and 0 <= y < n:
                        px[y][x] = mix(ACC_TOP, ACC, gy / 8) + (255,)
    return px


def png_bytes(rows):
    h, w = len(rows), len(rows[0])
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def bmp_dib_bytes(rows):
    h, w = len(rows), len(rows[0])
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    xor = bytearray()
    for row in reversed(rows):
        for (r, g, b, a) in row:
            xor += bytes((b, g, r, a))
    return header + bytes(xor) + bytes(((w + 31) // 32) * 4 * h)


def write_ico(path, entries):
    out = bytearray(struct.pack("<HHH", 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for size, data in entries:
        dim = 0 if size >= 256 else size
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in entries:
        out += data
    with open(path, "wb") as f:
        f.write(out)


def write_icns(path, entries):
    body = bytearray()
    for ostype, data in entries:
        body += ostype + struct.pack(">I", len(data) + 8) + data
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + bytes(body))


def main():
    def save(name, rows):
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(png_bytes(rows))

    save("32x32.png", render(32))
    save("128x128.png", render(128))
    save("128x128@2x.png", render(256))
    save("icon.png", render(512))
    save("tray.png", render(32, tray=True))
    small = (16, 20, 24, 32, 40, 48, 64)
    write_ico(os.path.join(OUT, "icon.ico"), [(s, bmp_dib_bytes(render(s))) for s in small] + [(256, png_bytes(render(256)))])
    write_icns(os.path.join(OUT, "icon.icns"), [
        (b"ic11", png_bytes(render(32, mac=True))), (b"ic12", png_bytes(render(64, mac=True))),
        (b"ic07", png_bytes(render(128, mac=True))), (b"ic13", png_bytes(render(256, mac=True))),
        (b"ic08", png_bytes(render(256, mac=True))), (b"ic14", png_bytes(render(512, mac=True))),
        (b"ic09", png_bytes(render(512, mac=True))),
    ])
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
