#!/usr/bin/env python3
"""
TPD App Server - a simple local HTTPS server for HTML apps (Plate Runner, etc.)

- Serves every file in the "apps" folder next to this script (created if missing).
- Makes its own self-signed certificate the first time and reuses it after that.
- Opens the browser automatically.

Usage:
    python tpd_server.py                 # https://localhost:8443, this computer only
    python tpd_server.py --port 9443     # different port
    python tpd_server.py --lan           # also reachable from other devices on the network
    python tpd_server.py --dir C:\\path   # serve a different folder
    python tpd_server.py --http          # plain http://localhost:8080 (no certificate warning;
                                         #  offline mode and "Install app" work on this PC)
"""

import argparse
import datetime
import http.server
import ipaddress
import os
import socket
import ssl
import subprocess
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(HERE, "cert")
CERT_FILE = os.path.join(CERT_DIR, "tpd-server.crt")
KEY_FILE = os.path.join(CERT_DIR, "tpd-server.key")



def lan_ip():
    """Best guess at this machine's network IP (no traffic is actually sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# ---------------------------------------------------------------------------------------
# Certificates without any extra packages (pure Python).
# The first run makes a small certificate authority ("TPD Local CA", cert\tpd-ca.crt).
# Other computers trust that CA once; the server certificate it issues is renewed
# automatically when this PC's name or network address changes, with no new setup.
# ---------------------------------------------------------------------------------------
import base64 as _b64
import hashlib as _hl
import json as _json
import secrets as _sec

CA_CRT = os.path.join(CERT_DIR, "tpd-ca.crt")
CA_KEY = os.path.join(CERT_DIR, "tpd-ca.key")
INFO = os.path.join(CERT_DIR, "tpd-server.json")
IT_DIR = os.path.join(HERE, "cert-from-it")   # put server.crt + server.key here to use IT's certificate


def _is_prime(n):
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(40):
        x = pow(_sec.randbelow(n - 3) + 2, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits):
    while True:
        c = _sec.randbits(bits) | (3 << (bits - 2)) | 1
        if c % 65537 != 1 and _is_prime(c):
            return c


def _rsa(bits=2048):
    e = 65537
    while True:
        p, q = _prime(bits // 2), _prime(bits // 2)
        if p == q:
            continue
        n, phi = p * q, (p - 1) * (q - 1)
        if n.bit_length() == bits and phi % e:
            d = pow(e, -1, phi)
            return {"n": n, "e": e, "d": d, "p": p, "q": q}


# --- DER encoding ---
def _len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def _tlv(tag, body):
    return bytes([tag]) + _len(len(body)) + body


def _int(v):
    b = v.to_bytes(max(1, (v.bit_length() + 8) // 8), "big")
    return _tlv(0x02, b)


def _seq(*x):
    return _tlv(0x30, b"".join(x))


def _set(*x):
    return _tlv(0x31, b"".join(x))


def _oid(dotted):
    a = [int(x) for x in dotted.split(".")]
    out = bytes([40 * a[0] + a[1]])
    for v in a[2:]:
        chunk = [v & 0x7F]
        v >>= 7
        while v:
            chunk.append(0x80 | (v & 0x7F))
            v >>= 7
        out += bytes(reversed(chunk))
    return _tlv(0x06, out)


_NULL = b"\x05\x00"
_bits = lambda b, unused=0: _tlv(0x03, bytes([unused]) + b)
_oct = lambda b: _tlv(0x04, b)
_utf8 = lambda s: _tlv(0x0C, s.encode())
_TRUE = b"\x01\x01\xff"
_SHA256RSA = _seq(_oid("1.2.840.113549.1.1.11"), _NULL)


def _time(t):
    return _tlv(0x17, t.strftime("%y%m%d%H%M%SZ").encode()) if t.year < 2050 else \
        _tlv(0x18, t.strftime("%Y%m%d%H%M%SZ").encode())


def _name(cn):
    return _seq(_set(_seq(_oid("2.5.4.3"), _utf8(cn))), _set(_seq(_oid("2.5.4.10"), _utf8("Tisbury PD apps"))))


def _spki(k):
    return _seq(_seq(_oid("1.2.840.113549.1.1.1"), _NULL), _bits(_seq(_int(k["n"]), _int(k["e"]))))


def _keyid(k):
    return _hl.sha1(_seq(_int(k["n"]), _int(k["e"]))).digest()


def _ext(oid, der, critical=False):
    return _seq(_oid(oid), *([_TRUE] if critical else []), _oct(der))


def _sign(k, data):
    di = _seq(_seq(_oid("2.16.840.1.101.3.4.2.1"), _NULL), _oct(_hl.sha256(data).digest()))
    size = (k["n"].bit_length() + 7) // 8
    em = b"\x00\x01" + b"\xff" * (size - len(di) - 3) + b"\x00" + di
    return pow(int.from_bytes(em, "big"), k["d"], k["n"]).to_bytes(size, "big")


def _cert(subject_cn, k, issuer_cn, ik, days, exts):
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    tbs = _seq(
        _tlv(0xA0, _int(2)), _int(_sec.randbits(63) | 1), _SHA256RSA, _name(issuer_cn),
        _seq(_time(now - datetime.timedelta(days=1)), _time(now + datetime.timedelta(days=days))),
        _name(subject_cn), _spki(k), _tlv(0xA3, _seq(*exts)))
    return _seq(tbs, _SHA256RSA, _bits(_sign(ik, tbs)))


def _pem(label, der):
    b = _b64.b64encode(der).decode()
    return f"-----BEGIN {label}-----\n" + "\n".join(b[i:i + 64] for i in range(0, len(b), 64)) + f"\n-----END {label}-----\n"


def _key_pem(k):
    der = _seq(_int(0), _int(k["n"]), _int(k["e"]), _int(k["d"]), _int(k["p"]), _int(k["q"]),
               _int(k["d"] % (k["p"] - 1)), _int(k["d"] % (k["q"] - 1)), _int(pow(k["q"], -1, k["p"])))
    return _pem("RSA PRIVATE KEY", der)


def _read_key(path):
    der = _b64.b64decode("".join(l for l in open(path).read().splitlines() if not l.startswith("-----")))
    vals, i = [], 2 + (der[1] & 0x7F if der[1] & 0x80 else 0)
    while i < len(der):
        ln, j = der[i + 1], i + 2
        if ln & 0x80:
            nb = ln & 0x7F
            ln, j = int.from_bytes(der[i + 2:i + 2 + nb], "big"), i + 2 + nb
        vals.append(int.from_bytes(der[j:j + ln], "big"))
        i = j + ln
    return dict(zip(("v", "n", "e", "d", "p", "q"), vals))


def this_pc_names():
    """Names and addresses other computers may use to reach this PC."""
    dns, ips = ["localhost"], ["127.0.0.1"]
    host = socket.gethostname()
    for n in (host, socket.getfqdn()):
        n = (n or "").strip().lower()
        if n and n not in dns and not n.startswith("localhost"):
            dns.append(n)
    cand = [lan_ip()]
    try:
        cand += [a[4][0] for a in socket.getaddrinfo(host, None, socket.AF_INET)]
    except OSError:
        pass
    for ip in cand:
        if ip not in ips and not ip.startswith("127.") and not ip.startswith("169.254."):
            ips.append(ip)
    return dns, ips


_PRIVATE_NETS = [("10.0.0.0", "255.0.0.0"), ("172.16.0.0", "255.240.0.0"),
                 ("192.168.0.0", "255.255.0.0"), ("127.0.0.0", "255.0.0.0"), ("100.64.0.0", "255.192.0.0")]


def _ip4(s):
    return bytes(int(x) for x in s.split("."))


CA_LIMITS = os.path.join(CERT_DIR, "tpd-ca-limits.json")


def _covered(dns, ips):
    """True if the CA's limits (if any) allow every name and address this server uses."""
    try:
        lim = _json.load(open(CA_LIMITS))
    except Exception:
        return True  # older CA without limits, or no record
    def ok_dns(d):
        return any(d == x or d.endswith("." + x) for x in lim["dns"])
    def ok_ip(ip):
        a = int.from_bytes(_ip4(ip), "big")
        return any(a & int.from_bytes(_ip4(m), "big") == int.from_bytes(_ip4(n), "big") for n, m in lim["ips"])
    return all(ok_dns(d) for d in dns) and all(ok_ip(i) for i in ips)


def _name_constraints(dns, ips=()):
    """CA may only vouch for this server's own names and private (LAN/Tailscale) addresses,
    so even a stolen CA key can't be used to fake Gmail, a bank, CJIS, etc. on department devices."""
    names = []
    for d in dns:
        names.append(d)
        if "." in d and d != "localhost":
            names.append(d.split(".", 1)[1])  # the PC's domain, e.g. tisbury.local
    seen, subtrees = set(), []
    for d in names:
        if d and d not in seen:
            seen.add(d)
            subtrees.append(_seq(_tlv(0x82, d.encode())))
    nets = list(_PRIVATE_NETS) + [(i, "255.255.255.255") for i in ips]  # plus this PC's own addresses
    for net, mask in nets:
        subtrees.append(_seq(_tlv(0x87, _ip4(net) + _ip4(mask))))
    _json.dump({"dns": list(seen), "ips": nets}, open(CA_LIMITS, "w"))
    return _ext("2.5.29.30", _seq(_tlv(0xA0, b"".join(subtrees))), True)


def ca_is_limited():
    try:
        der = _b64.b64decode("".join(l for l in open(CA_CRT).read().splitlines() if not l.startswith("-----")))
        return _oid("2.5.29.30") in der
    except Exception:
        return False


def make_cert(quiet=False, new_ca=False):
    """Make sure cert\\tpd-server.crt is valid for this PC's current names and addresses."""
    global CERT_FILE, KEY_FILE
    it_crt, it_key = os.path.join(IT_DIR, "server.crt"), os.path.join(IT_DIR, "server.key")
    if os.path.exists(it_crt) and os.path.exists(it_key):
        CERT_FILE, KEY_FILE = it_crt, it_key
        return
    CERT_FILE, KEY_FILE = os.path.join(CERT_DIR, "tpd-server.crt"), os.path.join(CERT_DIR, "tpd-server.key")
    dns, ips = this_pc_names()
    if new_ca:
        for f in (CA_CRT, CA_KEY, INFO, CA_LIMITS):
            try:
                os.remove(f)
            except OSError:
                pass
        print("Old certificate authority removed. Every device must install the new TPD-Local-CA.crt (see /setup).")
    try:
        info = _json.load(open(INFO))
        fresh = datetime.datetime.fromisoformat(info["expires"]) - datetime.datetime.now(datetime.timezone.utc) > datetime.timedelta(days=30)
        if fresh and set(dns) <= set(info["dns"]) and set(ips) <= set(info["ips"]) \
                and os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE) and os.path.exists(CA_CRT):
            return
    except Exception:
        pass
    os.makedirs(CERT_DIR, exist_ok=True)
    try:
        if not (os.path.exists(CA_CRT) and os.path.exists(CA_KEY)):
            print("Making this server's certificate authority (one time, takes a few seconds)...")
            ca = _rsa()
            kid = _keyid(ca)
            der = _cert("TPD Local CA", ca, "TPD Local CA", ca, 3650, [
                _ext("2.5.29.19", _seq(_TRUE, _int(0)), True),
                _ext("2.5.29.15", _bits(b"\x86", 1), True),
                _ext("2.5.29.14", _oct(kid)),
                _name_constraints(dns, ips)])
            open(CA_KEY, "w").write(_key_pem(ca))
            open(CA_CRT, "w").write(_pem("CERTIFICATE", der))
        ca = _read_key(CA_KEY)
        if not _covered(dns, ips):
            print("WARNING: this PC's name or network address changed to one the certificate authority does not cover.\n"
                  "         Other devices will reject the connection. Start once with --new-ca and reinstall the\n"
                  "         certificate on each device (or ask IT for a certificate; see cert-from-it).")
        print("Making the server certificate for: " + ", ".join(dns + ips))
        k = _rsa()
        san = b"".join([_tlv(0x82, d.encode()) for d in dns] + [_tlv(0x87, bytes(int(x) for x in ip.split("."))) for ip in ips])
        der = _cert(dns[1] if len(dns) > 1 else "localhost", k, "TPD Local CA", ca, 825, [
            _ext("2.5.29.19", _seq(), True),
            _ext("2.5.29.15", _bits(b"\xa0", 5), True),
            _ext("2.5.29.37", _seq(_oid("1.3.6.1.5.5.7.3.1"))),
            _ext("2.5.29.17", _seq(san)),
            _ext("2.5.29.14", _oct(_keyid(k))),
            _ext("2.5.29.35", _seq(_tlv(0x80, _keyid(ca))))])
        open(KEY_FILE, "w").write(_key_pem(k))
        open(CERT_FILE, "w").write(_pem("CERTIFICATE", der) + open(CA_CRT).read())  # include the CA in the chain
        exp = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=825)).isoformat()
        _json.dump({"dns": dns, "ips": ips, "expires": exp}, open(INFO, "w"))
    except Exception as x:
        print("Could not make a certificate: " + str(x))
        raise SystemExit(1)



class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript",
        ".json": "application/json", ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # Always serve the latest version of a file after you edit it
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()}  {fmt % args}")


def main():
    p = argparse.ArgumentParser(description="Simple HTTPS server for TPD apps")
    p.add_argument("--port", type=int, default=8443)
    p.add_argument("--dir", default=os.path.join(HERE, "apps"))
    p.add_argument("--lan", action="store_true",
                   help="allow other devices on the network to connect")
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--http", action="store_true",
                   help="plain HTTP on this computer only (localhost counts as secure in browsers)")
    a = p.parse_args()

    os.makedirs(a.dir, exist_ok=True)
    if a.http:
        a.lan = False  # plain HTTP is only safe/secure-context on localhost
        if a.port == 8443:
            a.port = 8080
    else:
        make_cert()

    bind = "0.0.0.0" if a.lan else "127.0.0.1"
    handler = lambda *args, **kw: Handler(*args, directory=a.dir, **kw)
    httpd = http.server.ThreadingHTTPServer((bind, a.port), handler)
    if not a.http:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT_FILE, KEY_FILE)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    url = f"{'http' if a.http else 'https'}://localhost:{a.port}/"
    print("\nTPD App Server running")
    print(f"  Serving: {a.dir}")
    print(f"  Open:    {url}")
    if a.lan:
        print(f"  Network: https://{lan_ip()}:{a.port}/")
    print("  Close this window or press Ctrl+C to stop.\n")

    if not a.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
