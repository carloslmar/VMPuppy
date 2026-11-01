#!/usr/bin/env python3
import argparse
import asyncio
import base64
import json
import logging
import os
import socket
import time
from datetime import datetime

BASE_PORT = 37393          

MDC_DeviceRequest = 0x01
MDC_AllStatusReq = 0x02
MDRS_DeviceStatus = 0x05
MDRS_DeviceReply = 0x07      #ECH!
MDRS_DataTransfer = 0x08
MDCF_GetCondition = 0x09
MDCF_BlockRead = 0x0B
MDCF_BlockWrite = 0x0C
MDCF_CompleteWrite = 0x0D
MDCF_SetCondition = 0x0E
MDRE_InvalidFlashAddress = 0xFB

MFID_0_Input = 0x01000000
MFID_1_Storage = 0x02000000
MFID_2_LCD = 0x04000000
MFID_3_Clock = 0x08000000

REFRESH_MESSAGE = b"FF FF FF FF\r\n"

LCD_BYTES = 192             
FLASH_SIZE = 128 * 1024
BLOCK = 512
BIOS_SIZE = 64 * 1024
BIOS_NAMES = ("american_v1.05.bin", "american_v1_05.bin", "vmu_bios.bin", "bios.bin")
BUS_NAMES = "ABCD"

log = logging.getLogger("vmu")
HERE = os.path.dirname(os.path.abspath(__file__))



def _bcd(v):
    return ((v // 10) << 4) | (v % 10)


def formatted_flash(now=None):
    now = now or datetime.now()
    f = bytearray(FLASH_SIZE)
    root, fat = 255 * BLOCK, 254 * BLOCK

    def w16(off, v):
        f[off] = v & 0xFF
        f[off + 1] = (v >> 8) & 0xFF

    f[root:root + 0x10] = b"\x55" * 0x10
    f[root + 0x10:root + 0x15] = bytes([1, 0xFF, 0xFF, 0xFF, 0x64])   
    f[root + 0x30:root + 0x38] = bytes([_bcd(now.year // 100 % 100), _bcd(now.year % 100), _bcd(now.month),
                                        _bcd(now.day), _bcd(now.hour), _bcd(now.minute), _bcd(now.second),
                                        (now.weekday() + 1) % 7])   
    for off, v in ((0x40, 0xFF), (0x42, 0), (0x44, 255), (0x46, 254), (0x48, 1), (0x4A, 253),
                   (0x4C, 13), (0x50, 200), (0x52, 41), (0x54, 0), (0x56, 128)):
        w16(root + off, v)
    for i in range(256):
        w16(fat + i * 2, 0xFFFC)
    w16(fat + 255 * 2, 0xFFFA)
    w16(fat + 254 * 2, 0xFFFA)
    for i in range(253, 241, -1):
        w16(fat + i * 2, i - 1)
    w16(fat + 241 * 2, 0xFFFA)
    return f


class Vmu:
    def __init__(self, bus, path):
        self.bus = bus
        self.path = path
        self.docked = True
        self.owner = None            
        self.flash = None
        self.version = 0             
        self.load()

    @property
    def name(self):
        return BUS_NAMES[self.bus]

    def load(self):
        if os.path.exists(self.path) and os.path.getsize(self.path) == FLASH_SIZE:
            with open(self.path, "rb") as fh:
                self.flash = bytearray(fh.read())
        else:
            if os.path.exists(self.path):
                log.warning("%s is not a 128 KB VMU image. Making a new one, be patient.", self.path)
                os.replace(self.path, self.path + ".bad")
            self.flash = formatted_flash()
            self.save_all()
            log.info("Created a new VMU for port %s: %s", self.name, self.path)

    def save_all(self):
        tmp = self.path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(self.flash)
        os.replace(tmp, self.path)

    def write_range(self, offset, data):
        self.flash[offset:offset + len(data)] = data
        self.version += 1
        try:
            with open(self.path, "r+b") as fh:
                fh.seek(offset)
                fh.write(data)
        except OSError:
            self.save_all()

    def replace_all(self, data):
        self.flash[:] = data
        self.version += 1
        self.save_all()

    def info(self):
        return {"t": "vmu", "bus": self.bus, "docked": self.docked, "owner": self.owner}


class Hub:
    def __init__(self):
        self.frames = [bytes(LCD_BYTES)] * 4
        self.connected = [False] * 4
        self.beeps = [0] * 4
        self.frame_counts = [0] * 4
        self.clients = set()
        self.vmus = []
        self.bios = None
        self.bios_path = None

    def subscribe(self):
        q = asyncio.Queue(maxsize=256)
        self.clients.add(q)
        return q

    def unsubscribe(self, q):
        self.clients.discard(q)

    def publish(self, event):
        msg = json.dumps(event, separators=(",", ":"))
        for q in list(self.clients):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass

    def snapshot(self):
        out = [{"t": "hello", "bios": self.bios is not None}]
        for bus in range(4):
            out.append({"t": "status", "bus": bus, "connected": self.connected[bus]})
            out.append(self.vmus[bus].info())
            out.append({"t": "frame", "bus": bus, "d": base64.b64encode(self.frames[bus]).decode()})
        return [json.dumps(e, separators=(",", ":")) for e in out]

    def set_connected(self, bus, value):
        self.connected[bus] = value
        self.publish({"t": "status", "bus": bus, "connected": value})

    def set_frame(self, bus, data):
        self.frames[bus] = data
        self.frame_counts[bus] += 1
        self.publish({"t": "frame", "bus": bus, "d": base64.b64encode(data).decode()})

    def set_beep(self, bus, freq):
        if self.beeps[bus] != freq:
            self.beeps[bus] = freq
            self.publish({"t": "beep", "bus": bus, "hz": freq})

    def vmu_changed(self, vmu, notify_host=True):
        self.publish(vmu.info())
        save_dock_state()
        if notify_host:
            link = FlycastLink.active[vmu.bus]
            if link is not None:
                link.send_refresh()


hub = Hub()
STATE_FILE = None
BIOS_ARG = None


def save_dock_state():
    if not STATE_FILE:
        return
    try:
        with open(STATE_FILE, "w") as fh:
            json.dump({BUS_NAMES[v.bus]: {"docked": v.docked, "owner": v.owner} for v in hub.vmus}, fh)
    except OSError:
        pass


def load_dock_state():
    try:
        with open(STATE_FILE) as fh:
            data = json.load(fh)
        for v in hub.vmus:
            s = data.get(BUS_NAMES[v.bus])
            if s and not s.get("docked", True):
                v.docked, v.owner = False, s.get("owner")
                log.info("Port %s: VMU is still ejected (being played on a phone)", v.name)
    except (OSError, ValueError):
        pass


#Totally not copied from core/input/dreampotato.cpp (Yeah, it was.)
def encode_msg(command, dest, origin, data=b""):
    assert len(data) % 4 == 0
    parts = [command, dest, origin, len(data) // 4, *data]
    return (" ".join(f"{b:02X}" for b in parts) + "\r\n").encode()


def decode_msg(line):
    raw = bytes(int(tok, 16) for tok in line.split())
    if len(raw) < 4:
        raise ValueError("short message")
    command, dest, origin, size = raw[:4]
    data = raw[4:4 + size * 4]
    if len(data) != size * 4:
        raise ValueError(f"truncated: expected {size * 4} data bytes, got {len(data)}")
    return command, dest, origin, data


def device_info_reply():
    """28-word MDRS_DeviceStatus body, the same values a real VMU / DreamPotato report."""
    d = bytearray()
    d += (MFID_1_Storage | MFID_2_LCD | MFID_3_Clock).to_bytes(4, "little")
    d += (0x403F7E7E).to_bytes(4, "little")      
    d += (0x00100500).to_bytes(4, "little")      
    d += (0x00410F00).to_bytes(4, "little")      
    d += bytes([0xFF, 0x00])                    
    d += b"Visual Memory".ljust(30, b" ")
    d += b"Produced By or Under License From SEGA ENTERPRISES,LTD.".ljust(60, b" ")
    d += (0x007C).to_bytes(2, "little")
    d += (0x0082).to_bytes(2, "little")
    assert len(d) == 112
    return bytes(d)

#Flycast
class FlycastLink:
    """One TCP connection from Flycast/Hollycast for one controller bus."""
    active = [None] * 4

    def __init__(self, bus, reader, writer):
        self.bus, self.reader, self.writer = bus, reader, writer
        self.vmu = hub.vmus[bus]
        self.hot_plug = False        

    def send(self, payload):
        try:
            self.writer.write(payload)
        except (ConnectionError, OSError):
            pass

    def send_refresh(self):
        if self.hot_plug:
            self.send(REFRESH_MESSAGE)

    async def run(self):
        name = BUS_NAMES[self.bus]
        old = FlycastLink.active[self.bus]
        if old is not None:
            old.writer.close()
        FlycastLink.active[self.bus] = self
        log.info("Flycast connected on port %s (VMU %s)", name, "docked" if self.vmu.docked else "ejected")
        hub.set_connected(self.bus, True)
        try:
            while True:
                line = await self.reader.readline()
                if not line:
                    break
                line = line.decode("ascii", "replace").strip()
                if not line:
                    continue
                try:
                    self.handle(*decode_msg(line))
                    await self.writer.drain()
                except ValueError as e:
                    log.debug("Port %s: bad message (%s): %.60s", name, e, line)
        except (ConnectionError, OSError):
            pass
        finally:
            if FlycastLink.active[self.bus] is self:
                FlycastLink.active[self.bus] = None
                hub.set_connected(self.bus, False)
                hub.set_beep(self.bus, 0)
                log.info("Flycast disconnected from port %s", name)
            self.writer.close()

    def handle(self, command, dest, origin, data):
        vmu = self.vmu
        fn = int.from_bytes(data[:4], "little") if len(data) >= 4 else 0
        slot = dest & 0x1F
        bus_ap = self.bus << 6

        if command == MDCF_GetCondition and fn == MFID_0_Input:
            # Hollycast asks which expansion slots currently hold a docked VMU.
            self.hot_plug = True
            mask = 0x01 if vmu.docked else 0x00
            self.send(encode_msg(MDRS_DeviceReply, bus_ap | 0x20, bus_ap | mask))
            return

        if command in (MDC_DeviceRequest, MDC_AllStatusReq):
            if vmu.docked and slot & 0x01:
                self.send(encode_msg(MDRS_DeviceStatus, bus_ap, bus_ap | 0x01, device_info_reply()))
            else:
                self.send(REFRESH_MESSAGE)           
            return

        if fn == MFID_1_Storage:
            if command == MDCF_BlockRead:
                block = data[7]
                body = MFID_1_Storage.to_bytes(4, "little") + bytes(data[4:8]) \
                    + bytes(vmu.flash[block * BLOCK:(block + 1) * BLOCK])
                self.send(encode_msg(MDRS_DataTransfer, bus_ap, bus_ap | 0x01, body))
            elif command == MDCF_BlockWrite:
                if len(data) != 8 + BLOCK // 4:
                    log.warning("Port %s: unexpected save write of %d bytes", self.vmu.name, len(data))
                    self.send(encode_msg(MDRE_InvalidFlashAddress, bus_ap, bus_ap | 0x01))
                    return
                block, phase = data[7], data[5]
                if not vmu.docked:
                    log.warning("Port %s: game saved while the VMU is ejected. Don't worry. "
                                "Just dock your VMU to save your game in it. :D", vmu.name)
                vmu.write_range(block * BLOCK + phase * (BLOCK // 4), bytes(data[8:]))
                self.send(encode_msg(MDRS_DeviceReply, bus_ap, bus_ap | 0x01))
                hub.publish({"t": "io", "bus": self.bus})
            elif command == MDCF_CompleteWrite:
                self.send(encode_msg(MDRS_DeviceReply, bus_ap, bus_ap | 0x01))
            return

        if command == MDCF_BlockWrite and fn == MFID_2_LCD:
            frame = data[8:8 + LCD_BYTES]
            if len(frame) == LCD_BYTES and vmu.docked:
                hub.set_frame(self.bus, bytes(frame))
            return

        if command == MDCF_SetCondition and fn == MFID_3_Clock and len(data) >= 6:
            period, on = data[4], data[5]
            freq = 0 if (period == 0 or on == 0 or on >= period) else round(1_000_000 / period)
            hub.set_beep(self.bus, freq if vmu.docked else 0)
            return



async def start_flycast_listeners():
    servers = []
    for bus in range(4):
        port = BASE_PORT + bus

        async def on_conn(reader, writer, bus=bus):
            sock = writer.get_extra_info("socket")
            if sock is not None:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            await FlycastLink(bus, reader, writer).run()

        errors = []
        for host in ("::1", "127.0.0.1"):
            try:
                servers.append(await asyncio.start_server(on_conn, host, port))
            except OSError as e:
                errors.append((host, e))
        in_use = [h for h, e in errors if e.errno in (98, 48, 10048)]   # EADDRINUSE on Linux/mac/Windows
        if in_use:
            log.error("Port %d is already in use! Are you running DreamPotato? "
                      "Please close it and restart.", port)
        elif len(errors) == 2:
            log.error("Can't listen on localhost port %d: %s", port, errors[-1][1])
        for host, e in errors:
            log.debug("No listener on [%s]:%d (%s)", host, port, e)
    return servers


#tiny HTTP server
ASSETS = {
    "/assets/vmu.webp": ("assets/vmu.webp", "image/webp"),
    "/assets/keepawake.mp4": ("assets/keepawake.mp4", "video/mp4"),
    "/vmu-core.js": ("vmu-core.js", "text/javascript; charset=utf-8"),
}
REASONS = {200: "OK", 206: "Partial Content", 400: "Bad Request", 404: "Not Found",
           405: "Method Not Allowed", 409: "Conflict", 413: "Payload Too Large, Onii-chan"}


async def handle_http(reader, writer):
    try:
        request = await asyncio.wait_for(reader.readline(), 10)
        headers = {}
        while True:
            h = await asyncio.wait_for(reader.readline(), 10)
            if h in (b"\r\n", b"\n", b""):
                break
            k, _, v = h.decode("latin-1").partition(":")
            headers[k.strip().lower()] = v.strip()
        parts = request.decode("latin-1").split()
        if len(parts) < 2:
            return await send(writer, 400, "text/plain", b"Bad request")
        method, target = parts[0], parts[1]
        path, _, query = target.partition("?")
        params = dict(p.partition("=")[::2] for p in query.split("&") if p)

        body = b""
        if method == "POST":
            n = int(headers.get("content-length", "0") or 0)
            if n > FLASH_SIZE + 4096:
                return await send(writer, 413, "text/plain", b"Too large")
            if n:
                body = await asyncio.wait_for(reader.readexactly(n), 20)
        elif method not in ("GET", "HEAD"):
            return await send(writer, 405, "text/plain", b"Method not allowed")

        if path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return await send(writer, 200, "text/html; charset=utf-8", f.read())
        if path in ASSETS:
            rel, ctype = ASSETS[path]
            with open(os.path.join(HERE, rel), "rb") as f:
                return await send(writer, 200, ctype, f.read(), headers.get("range"))
        if path == "/events":
            return await serve_events(writer)
        if path == "/status":
            body = json.dumps({"connected": hub.connected, "frames": hub.frame_counts,
                               "docked": [v.docked for v in hub.vmus], "bios": hub.bios is not None}).encode()
            return await send(writer, 200, "application/json", body)
        if path == "/bios":
            if hub.bios is None:                      # maybe it was added after start-up
                hub.bios_path, hub.bios = find_bios(BIOS_ARG)
            if hub.bios is None:
                return await send(writer, 404, "text/plain", b"No VMU BIOS file found next to vmu_bridge.py")
            return await send(writer, 200, "application/octet-stream", hub.bios, private=True)
        if path.startswith("/vmu/"):
            return await handle_vmu_api(writer, method, path, params, body)
        return await send(writer, 404, "text/plain", b"Not found")
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError, OSError):
        pass
    finally:
        writer.close()


async def handle_vmu_api(writer, method, path, params, body):
    # /vmu/<A-D>/<action>
    try:
        _, _, letter, action = path.split("/", 3)
        vmu = hub.vmus[BUS_NAMES.index(letter.upper())]
    except (ValueError, IndexError):
        return await send(writer, 404, "text/plain", b"Unknown VMU")
    client = params.get("client", "")

    if action == "flash" and method == "GET":
        return await send(writer, 200, "application/octet-stream", bytes(vmu.flash), private=True)

    if method != "POST":
        return await send(writer, 405, "text/plain", b"Use POST")

    if action == "eject":
        was_docked = vmu.docked
        vmu.docked = False
        vmu.owner = client
        hub.frames[vmu.bus] = bytes(LCD_BYTES)
        hub.set_beep(vmu.bus, 0)
        hub.vmu_changed(vmu, notify_host=was_docked)
        log.info("Port %s: VMU %s by phone", vmu.name, "ejected" if was_docked else "taken over")
        return await send(writer, 200, "application/octet-stream", bytes(vmu.flash), private=True)

    if action in ("dock", "flash", "blocks") and (vmu.docked or (vmu.owner and vmu.owner != client)):
        return await send(writer, 409, "text/plain", b"This phone does not hold the VMU")

    if action == "blocks":
        if not body or len(body) % (BLOCK + 1):
            return await send(writer, 400, "text/plain", b"Bad block data")
        for i in range(0, len(body), BLOCK + 1):
            vmu.write_range(body[i] * BLOCK, body[i + 1:i + 1 + BLOCK])
        return await send(writer, 200, "application/json", b'{"ok":true}')

    if action in ("dock", "flash"):
        if len(body) != FLASH_SIZE:
            return await send(writer, 400, "text/plain", b"Expected 128 KB of VMU data")
        if bytes(vmu.flash) != body:
            vmu.replace_all(body)
        if action == "dock":
            vmu.docked = True
            vmu.owner = None
            hub.vmu_changed(vmu)
            log.info("Port %s: VMU docked", vmu.name)
        return await send(writer, 200, "application/json", b'{"ok":true}')

    return await send(writer, 404, "text/plain", b"Unknown action")


async def send(writer, code, ctype, body, range_header=None, private=False):
    extra = ""
    if code == 200 and range_header and range_header.startswith("bytes="):
        # Safari is trash, and so is Apple.
        try:
            start_s, _, end_s = range_header[6:].split(",")[0].partition("-")
            if start_s:
                start = int(start_s)
                end = min(int(end_s), len(body) - 1) if end_s else len(body) - 1
            else:
                start, end = max(0, len(body) - int(end_s)), len(body) - 1
            if start <= end < len(body):
                extra = f"Content-Range: bytes {start}-{end}/{len(body)}\r\n"
                body, code = body[start:end + 1], 206
        except ValueError:
            pass
    if ctype.startswith(("video/", "image/")):
        extra += "Accept-Ranges: bytes\r\n"
    cache = "max-age=3600" if ctype.startswith(("video/", "image/")) and not private else "no-store"
    writer.write(f"HTTP/1.1 {code} {REASONS[code]}\r\nContent-Type: {ctype}\r\n"
                 f"Content-Length: {len(body)}\r\nCache-Control: {cache}\r\n{extra}"
                 f"Connection: close\r\n\r\n".encode() + body)
    await writer.drain()


async def serve_events(writer):
    writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                 b"Cache-Control: no-cache\r\nConnection: keep-alive\r\n"
                 b"X-Accel-Buffering: no\r\n\r\nretry: 1000\n\n")
    q = hub.subscribe()
    try:
        for msg in hub.snapshot():
            writer.write(f"data: {msg}\n\n".encode())
        await writer.drain()
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), 15)
                writer.write(f"data: {msg}\n\n".encode())
            except asyncio.TimeoutError:
                writer.write(b": ping\n\n")
            await writer.drain()
    finally:
        hub.unsubscribe(q)


def lan_addresses():
    addrs = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))         
            addrs.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in addrs and not ip.startswith("127."):
                addrs.append(ip)
    except OSError:
        pass
    return addrs or ["<this-pc-ip>"]


def find_bios(explicit):
    candidates = [explicit] if explicit else [os.path.join(HERE, n) for n in BIOS_NAMES] + \
        [os.path.join(HERE, "bios", n) for n in BIOS_NAMES]
    for p in candidates:
        if p and os.path.isfile(p):
            if os.path.getsize(p) != BIOS_SIZE:
                log.error("%s is %d bytes; a VMU BIOS must be exactly 64 KB.", p, os.path.getsize(p))
                continue
            with open(p, "rb") as fh:
                return p, fh.read()
    return None, None


async def main():
    ap = argparse.ArgumentParser(description="Use your phone as Flycast's VMU.")
    ap.add_argument("--http-port", type=int, default=8080, help="web page port (default 8080)")
    ap.add_argument("--bind", default="0.0.0.0", help="web page bind address (default all interfaces)")
    ap.add_argument("--bios", help="path to the VMU BIOS (american_v1.05.bin); default: next to this script")
    ap.add_argument("--saves", default=os.path.join(HERE, "saves"), help="folder for VMU save files")
    ap.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")

    os.makedirs(args.saves, exist_ok=True)
    hub.vmus = [Vmu(b, os.path.join(args.saves, f"vmu_{BUS_NAMES[b]}1.bin")) for b in range(4)]
    global STATE_FILE
    STATE_FILE = os.path.join(args.saves, "dock_state.json")
    load_dock_state()
    global BIOS_ARG
    BIOS_ARG = args.bios
    hub.bios_path, hub.bios = find_bios(args.bios)

    await start_flycast_listeners()
    try:
        await asyncio.start_server(handle_http, args.bind, args.http_port)
    except OSError as e:
        log.error("Can't open web port %d (%s). Try --http-port 8081", args.http_port, e.strerror)
        return

    print()
    print("  VMPuppy is running.")
    print("  Open one of the following URLs on your phone's browser:")
    for ip in lan_addresses():
        print(f"     http://{ip}:{args.http_port}")
    print(f"  Saves: {args.saves}")
    if hub.bios:
        print(f"  BIOS:  {hub.bios_path}")
    else:
        print("  BIOS:  not found. Put american_v1.05.bin next to vmu_bridge.py to play VMU games.")
    print("  Waiting for Flycast... (Ctrl+C to quit)")
    print()
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
