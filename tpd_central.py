#!/usr/bin/env python3
"""
Tisbury PD Central Server - kiosk app + officer app, managed from one place.

  /kiosk/    Visitor Self-Service (lobby)        - open to anyone
  /officer/  Officer Portal                      - sign-in required
  /api/      shared data: accounts, officers, CC, field types, imported forms

What "central" means here:
  - Officers, email CC, imported PDFs, signature boxes, field types and staff accounts are
    stored on this server, so every device sees the same thing.
  - To update an app, replace its files in central\\kiosk or central\\officer. Devices pick
    up the new version on their own within about a minute (when they are on the home screen).
  - Devices keep a copy so the apps still work offline.

Standard library only. Usage:
    python tpd_central.py              # http://localhost:8090 (this PC only)
    python tpd_central.py --https      # https://localhost:8493
    python tpd_central.py --https --lan  # other devices on the network (needs a trusted cert)
    python tpd_central.py --reset-users  # forgot admin password (forms and officers are kept)
"""

import argparse
import hashlib
import hmac
import html as htmlmod
import http.server
import json
import os
import re
import secrets
import smtplib
import base64
from email.message import EmailMessage
from email.utils import formataddr
import ssl
import sys
import threading
import time
import uuid
import webbrowser
from urllib.parse import urlsplit, parse_qs, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ROOT = os.path.join(HERE, "central")
APPS = {"kiosk": os.path.join(ROOT, "kiosk"), "officer": os.path.join(ROOT, "officer")}
CLIENT_JS = os.path.join(ROOT, "client.js")
DATA = os.path.abspath(os.environ.get("DATA_DIR") or os.path.join(ROOT, "data"))
FORMS = os.path.join(DATA, "forms")
SF = os.path.join(DATA, "state.json")
SERVER_VERSION = "1"

IDLE = 30 * 60              # staff sessions (kiosk Staff setup)
OFFICER_IDLE = 12 * 3600    # officer app sessions
MAXAGE = 12 * 3600

os.makedirs(FORMS, exist_ok=True)
LOCK = threading.RLock()

# ---------- storage ----------
MAIL_DEFAULT = {"on": False, "selfOn": False, "relayKey": "", "relayOrigins": "", "relayAllow": "", "from": "", "name": "", "host": "", "port": 587, "sec": "starttls", "user": "", "pass": ""}
S = {"users": [], "officers": [], "cc": "", "kinds": {}, "gmkey": "", "forms": [], "rev": 1, "mail": dict(MAIL_DEFAULT)}
try:
    with open(SF, encoding="utf-8") as f:
        S.update(json.load(f))
except Exception:
    pass
S["mail"] = {**MAIL_DEFAULT, **(S.get("mail") or {})}
for _o in S["officers"]:
    _o.setdefault("id", str(uuid.uuid4()))


def mail_on():
    m = S["mail"]
    return bool(m.get("on") and m.get("host") and m.get("from"))


NO_REPLY = "Do Not Reply <no-reply@no-reply.invalid>"  # .invalid never exists, so replies bounce at once


def send_mail(to, cc, subject, text, files, no_reply=False):
    m = S["mail"]
    msg = EmailMessage()
    msg["From"] = formataddr((m.get("name") or "", m["from"]))
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = cc
    msg["Subject"] = subject
    if no_reply:
        msg["Reply-To"] = NO_REPLY
        msg["Auto-Submitted"] = "auto-generated"
        msg["X-Auto-Response-Suppress"] = "All"
        msg["Precedence"] = "auto_reply"
    msg.set_content(text)
    for fn, data in files:
        msg.add_attachment(data, maintype="application", subtype="pdf", filename=fn)
    host, port, sec = m["host"], int(m.get("port") or 587), m.get("sec") or "starttls"
    ctx = ssl.create_default_context()
    if sec == "ssl":
        srv = smtplib.SMTP_SSL(host, port, timeout=30, context=ctx)
    else:
        srv = smtplib.SMTP(host, port, timeout=30)
        if sec == "starttls":
            srv.starttls(context=ctx)
    with srv:
        if m.get("user"):
            srv.login(m["user"], m.get("pass") or "")
        srv.send_message(msg)


def save():
    S["rev"] = int(S.get("rev", 0)) + 1
    t = SF + ".tmp"
    with open(t, "w", encoding="utf-8") as f:
        json.dump(S, f, indent=1)
    os.replace(t, SF)


def audit(ev, who, **x):
    try:
        rec = {"t": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z", "ev": ev, "who": who, **x}
        with open(os.path.join(DATA, "audit.log"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


# ---------- app versions (change automatically when files change) ----------
_ver_cache = {}


def app_files(app):
    base, out = APPS[app], []
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if not d.startswith(".")]
        for n in fn:
            if n.startswith(".") or n == "sw.js":
                continue
            out.append(os.path.relpath(os.path.join(dp, n), base).replace(os.sep, "/"))
    return sorted(out)


def app_version(app):
    c = _ver_cache.get(app)
    if c and time.time() - c[0] < 3:
        return c[1]
    h = hashlib.sha1(SERVER_VERSION.encode())
    paths = [(r, os.path.join(APPS[app], r)) for r in app_files(app)] + [("client.js", CLIENT_JS)]
    for rel, p in paths:
        try:
            st = os.stat(p)
            h.update(f"{rel}|{st.st_size}|{st.st_mtime_ns}\n".encode())
        except OSError:
            pass
    v = h.hexdigest()[:12]
    _ver_cache[app] = (time.time(), v)
    return v


# ---------- page patching ----------
def patch_index(app, text):
    try:
        with open(CLIENT_JS, encoding="utf-8") as f:
            client = f.read()
    except OSError:
        client = ""
    marker = "dbAll().then("
    i = text.rfind(marker)
    if i < 0 or not client:
        print(f"WARNING: could not connect the {app} app to the server (app file layout changed).")
        warn = ('<div style="background:#c0392b;color:#fff;padding:10px;font:600 15px sans-serif;text-align:center">'
                'Server sync is not active for this version of the app. Data stays on this device.</div>')
        return text.replace("<body>", "<body>" + warn, 1)
    text = text[:i] + "\n" + client + "\n" + text[i:]
    text = text.replace('<option value="staff">Staff</option><option value="admin">Admin</option>',
                        '<option value="staff">Staff</option><option value="officer">Officer (officer app only)</option>'
                        '<option value="admin">Admin</option>', 1)
    text = text.replace("a.innerHTML=`${acctHtml()}", "a.innerHTML=`${acctHtml()}${pdMailCard()}", 1)
    text = text.replace("<button class=\"big\" onclick=\"printIt()\">${touchDev?'\U0001f5a8\ufe0f Print / Share':'\U0001f5a8\ufe0f Print'}</button>"
                        '<button class="big" onclick="emailIt()">\u2709\ufe0f Email officer</button>',
                        "${pdDoneBtns(touchDev)}${pdSelfBtn()}", 1)
    text = text.replace("'X-Unsent: 1\\r\\nTo: '", "'X-Unsent: 1\\r\\n'+(PDC.from?'From: '+PDC.from+'\\r\\n':'')+'To: '", 1)
    if app == "officer":
        text = text.replace("v=APP==='officer'?'admin':",
                            "v=APP==='officer'?(session&&session.role==='officer'?(pdNote('Staff setup needs a staff or admin account.',true),'home'):'admin'):", 1)
        text = text.replace('onclick="logout();return false">Log out', 'onclick="pdOfficerLogout();return false">Sign out', 1)
    return text


def service_worker(app):
    v = app_version(app)
    shell = ["./"] + app_files(app)
    return f"""/* generated by tpd_central.py - app version {v} */
const C='pd-central-{app}-{v}',SHELL={json.dumps(shell)};
self.addEventListener('install',e=>{{e.waitUntil(caches.open(C).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{{}})))).then(()=>self.skipWaiting()))}});
self.addEventListener('activate',e=>{{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C&&(x.startsWith('pd-central-{app}-')||x.startsWith('pd-{app}-'))).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))}});
const page=r=>r.mode==='navigate'||/\\/$|\\.html$/.test(new URL(r.url).pathname);
self.addEventListener('fetch',e=>{{const r=e.request,u=new URL(r.url);
 if(r.method!=='GET'||u.origin!==location.origin||u.pathname.includes('/api/'))return;
 if(page(r)){{e.respondWith((async()=>{{const c=await caches.open(C);
  try{{const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),5000);const n=await fetch(r,{{signal:ctl.signal}});clearTimeout(t);
   if(n.redirected||n.status===401){{if('{app}'==='officer')await caches.delete(C);return n}}
   if(n.ok)c.put(r,n.clone());return n}}
  catch(x){{return(await c.match(r,{{ignoreSearch:true}}))||(await c.match('index.html'))||Response.error()}}}})());return}}
 e.respondWith(caches.open(C).then(async c=>(await c.match(r,{{ignoreSearch:true}}))||fetch(r).then(n=>{{if(n.ok&&!n.redirected)c.put(r,n.clone());return n}})))}});
"""


LANDING = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tisbury PD Apps</title><style>body{margin:0;font:16px system-ui,sans-serif;background:#f4f6fa;color:#14213d}
main{max-width:520px;margin:40px auto;padding:0 16px}a{display:block;margin:12px 0;padding:18px;border-radius:12px;background:#fff;
border:1px solid #d4dcea;text-decoration:none;color:inherit}b{display:block;font-size:19px;color:#0b1a55}span{color:#5c677d}
@media(prefers-color-scheme:dark){body{background:#0f1626;color:#e6ebf5}a{background:#18223a;border-color:#2a3654}b{color:#9cc3ff}span{color:#a7b1c6}}</style></head>
<body><main><h1>Tisbury Police apps</h1><a href="kiosk/"><b>Visitor Self-Service</b><span>Lobby kiosk. Staff setup manages accounts, officers and forms for both apps.</span></a>
<a href="officer/"><b>Officer Portal</b><span>Officer forms. Sign-in required.</span></a>
<p style="text-align:center;margin-top:22px"><a href="setup" style="display:inline;padding:0;border:0;background:none;color:#5c677d;text-decoration:underline">Set up this device</a></p></main></body></html>"""

SETUP = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up this device</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f6fa;color:#14213d}
main{max-width:640px;margin:30px auto;padding:0 16px}.c{background:#fff;border:1px solid #d4dcea;border-radius:12px;padding:16px 20px;margin:14px 0}
h1{font-size:24px}h2{font-size:18px;margin:0 0 6px}.b{display:inline-block;margin:6px 0;padding:12px 18px;border-radius:10px;background:#124a8a;color:#fff;text-decoration:none;font-weight:600}
ol{padding-left:20px;margin:6px 0}code{background:#eef2f8;padding:1px 5px;border-radius:5px}.ok{color:#0a8f4a;font-weight:600}
@media(prefers-color-scheme:dark){body{background:#0f1626;color:#e6ebf5}.c{background:#18223a;border-color:#2a3654}code{background:#22304d}}</style></head>
<body><main><h1>Set up this device</h1>
<p>Do this once per computer, tablet or phone so it trusts this server. After that there are no security warnings, and the apps can work offline and be installed.</p>
<a class="b" href="tpd-ca.crt" download="TPD-Local-CA.crt">Download the certificate</a>
<div class="c"><h2>Windows (Chrome / Edge)</h2><ol><li>Open the downloaded <b>TPD-Local-CA.crt</b> &gt; <b>Install Certificate</b>.</li>
<li>Choose <b>Current User</b> (or <b>Local Machine</b> for every user; needs admin) &gt; Next.</li>
<li><b>Place all certificates in the following store</b> &gt; Browse &gt; <b>Trusted Root Certification Authorities</b> &gt; OK &gt; Next &gt; Finish &gt; Yes.</li>
<li>Close every Chrome/Edge window, then open this server again.</li></ol></div>
<div class="c"><h2>iPad / iPhone (Safari)</h2><ol><li>Tap the download button &gt; <b>Allow</b>.</li><li>Settings &gt; <b>Profile Downloaded</b> &gt; Install.</li>
<li>Settings &gt; General &gt; About &gt; <b>Certificate Trust Settings</b> &gt; turn on <b>TPD Local CA</b>.</li></ol></div>
<div class="c"><h2>Android</h2><ol><li>Download the certificate.</li><li>Settings &gt; search <b>CA certificate</b> &gt; Install a certificate &gt; CA certificate &gt; Install anyway &gt; pick the file.</li></ol></div>
<p>IT can also push <code>TPD-Local-CA.crt</code> to all department PCs with Group Policy.</p>
<p><a href="./">Back to the apps</a></p></main></body></html>"""

LOGIN = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#7a1f1f"><link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icon-192.png">
<title>Officer Portal - Sign in</title><style>body{margin:0;font:16px system-ui,sans-serif;background:#f4f6fa;color:#14213d}
main{max-width:380px;margin:48px auto;padding:0 16px}.c{background:#fff;border:1px solid #d4dcea;border-radius:14px;padding:22px}
img{display:block;margin:0 auto 10px;height:96px}h1{font-size:21px;text-align:center;margin:0 0 16px}label{display:block;margin:12px 0 4px;font-weight:600}
input{width:100%;box-sizing:border-box;font:inherit;padding:12px;border:1px solid #c3cde0;border-radius:10px}
button{width:100%;margin-top:18px;padding:13px;font:600 17px system-ui;border:0;border-radius:10px;background:#7a1f1f;color:#fff}
#m{color:#c0392b;min-height:1.2em}.n{color:#5c677d;font-size:14px}
@media(prefers-color-scheme:dark){body{background:#0f1626;color:#e6ebf5}.c{background:#18223a;border-color:#2a3654}input{background:#0f1626;color:#e6ebf5;border-color:#2a3654}.n{color:#a7b1c6}}</style></head>
<body><main><div class="c"><img src="icon-192.png" alt=""><h1>Officer Portal</h1>__NOTE__
<form id="f"><label for="u">Username</label><input id="u" autocapitalize="off" autocomplete="username" required>
<label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required>
<button>Sign in</button><p id="m"></p></form></div></main>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const m=document.getElementById('m');m.textContent='';
try{const r=await fetch('../api/login',{method:'POST',credentials:'same-origin',headers:{'x-pd':'1','content-type':'application/json'},
body:JSON.stringify({u:document.getElementById('u').value.trim(),p:document.getElementById('p').value,long:true})});
const d=await r.json();if(!r.ok)throw new Error(d.error||'Sign-in failed');location.href='./'}catch(x){m.textContent=x.message}}</script></body></html>"""


# ---------- security helpers ----------
def hash_pw(pw, salt):
    return hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1,
                          dklen=64, maxmem=64 * 1024 * 1024).hex()


def mk_user(u, p, role):
    salt = secrets.token_hex(16)
    return {"u": u, "role": role, "salt": salt, "hash": hash_pw(p, salt), "fails": 0, "lock": 0}


def now_ms():
    return int(time.time() * 1000)


SESS, HITS = {}, {}


def limited(key, mx, win):
    n = time.time()
    a = [t for t in HITS.get(key, []) if n - t < win]
    a.append(n)
    HITS[key] = a
    return len(a) > mx


def sess_idle(s):
    return OFFICER_IDLE if s.get("long") else IDLE


def janitor():
    while True:
        time.sleep(60)
        n = time.time()
        with LOCK:
            for k in [k for k, s in SESS.items() if n - s["last"] > sess_idle(s) or n - s["created"] > MAXAGE]:
                SESS.pop(k, None)
            for k in [k for k, a in HITS.items() if not any(n - t < 600 for t in a)]:
                HITS.pop(k, None)


ok_email_re = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def ok_email(e):
    return not e or (len(e) <= 200 and bool(ok_email_re.match(e)))


def ok_emails(e):
    return all(ok_email(x.strip()) for x in re.split(r"[,;]", e or "") if x.strip())


def is_pdf(b):
    return len(b) > 8 and b[:5] == b"%PDF-"


def clean_name(n):
    n = re.sub(r"[\x00-\x1f\\/]", "", str(n or "form"))
    n = os.path.basename(n).strip()[:120] or "form"
    return n if re.search(r"\.pdf$", n, re.I) else n + ".pdf"


def pub(o):
    return {"u": o["u"], "role": o["role"]}


class HttpError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json",
        ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg",
        ".svg": "image/svg+xml", ".ico": "image/x-icon", ".pdf": "application/pdf", ".wasm": "application/wasm"}

OFFICER_PUBLIC = {"login", "manifest.webmanifest", "icon-192.png", "icon-512.png"}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "TPD-Central"
    sys_version = ""
    secure = False

    def log_message(self, fmt, *args):
        if "/api/version" in (args[0] if args else ""):
            return
        print(f"  {self.client_address[0]}  {fmt % args}")

    def ip(self):
        return self.client_address[0]

    def cookies(self):
        out = {}
        for c in re.split(r";\s*", self.headers.get("cookie") or ""):
            if "=" in c:
                k, v = c.split("=", 1)
                out[k] = unquote(v)
        return out

    def send(self, code, body=b"", ctype=None, extra=None):
        self.send_response(code)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        if ctype:
            self.send_header("Content-Type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def json(self, code, o, extra=None):
        self.send(code, json.dumps(o).encode(), "application/json", {"Cache-Control": "no-store", **(extra or {})})

    def fail(self, code, msg):
        self.json(code, {"error": msg})

    def body(self, limit):
        n = int(self.headers.get("content-length") or 0)
        if n > limit:
            raise HttpError(413, "File too large")
        return self.rfile.read(n) if n else b""

    def read_json(self, limit=1_000_000):
        b = self.body(limit)
        try:
            v = json.loads(b.decode() or "{}")
        except Exception:
            raise HttpError(400, "Bad request")
        if not isinstance(v, dict):
            raise HttpError(400, "Bad request")
        return v

    def cookie_header(self, val, age):
        return f"pdsid={val}; HttpOnly; Path=/; SameSite=Lax; Max-Age={age}" + ("; Secure" if self.secure else "")

    def get_sess(self):
        t = self.cookies().get("pdsid")
        s = SESS.get(t) if t else None
        if not s:
            return None
        n = time.time()
        if n - s["last"] > sess_idle(s) or n - s["created"] > MAXAGE:
            SESS.pop(t, None)
            return None
        s["last"] = n
        u = next((x for x in S["users"] if x["u"] == s["u"]), None)
        if not u:
            SESS.pop(t, None)
            return None
        s["role"] = u["role"]
        return s

    def new_session(self, u, role, long=False):
        t = secrets.token_hex(32)
        n = time.time()
        SESS[t] = {"u": u, "role": role, "created": n, "last": n, "long": bool(long)}
        return {"Set-Cookie": self.cookie_header(t, MAXAGE)}

    def do_GET(self): self.route()
    def do_HEAD(self): self.route()
    def do_POST(self): self.route()
    def do_PUT(self): self.route()
    def do_DELETE(self): self.route()
    def do_OPTIONS(self): self.route()

    def route(self):
        try:
            u = urlsplit(self.path)
            p = unquote(u.path)
            if p == "/api/relay":
                return self.api_relay()
            if p in ("/api/email", "/api/mail/test") and self.command == "POST":
                return self.api_send(p[5:])
            if p.startswith("/api/"):
                q = {k: v[0] for k, v in parse_qs(u.query).items()}
                with LOCK:
                    return self.api(p[5:], q)
            if self.command not in ("GET", "HEAD"):
                return self.send(405)
            if p == "/tpd-ca.crt":
                import tpd_server
                try:
                    with open(tpd_server.CA_CRT, "rb") as f:
                        return self.send(200, f.read(), "application/x-x509-ca-cert",
                                         {"Content-Disposition": 'attachment; filename="TPD-Local-CA.crt"', "Cache-Control": "no-cache"})
                except OSError:
                    return self.send(404, b"No certificate (the server is not running with --https)", "text/plain")
            if p == "/setup":
                return self.send(200, SETUP.encode(), "text/html; charset=utf-8", {"Cache-Control": "no-cache"})
            if p in ("/", "/index.html"):
                return self.send(200, LANDING.encode(), "text/html; charset=utf-8", {"Cache-Control": "no-cache"})
            m = re.match(r"^/(kiosk|officer)(/.*)?$", p)
            if not m:
                return self.send(404, b"Not found", "text/plain")
            app, rest = m.group(1), m.group(2)
            if rest is None:
                return self.send(301, extra={"Location": f"/{app}/"})
            return self.app_file(app, rest.lstrip("/"))
        except HttpError as e:
            self.fail(e.code, e.msg)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass
        except Exception as e:
            print("Server error:", repr(e))
            try:
                self.fail(500, "Server error")
            except Exception:
                pass

    def app_file(self, app, rel):
        if app == "officer" and rel not in OFFICER_PUBLIC:
            with LOCK:
                s = self.get_sess()
            if not s:
                if rel in ("", "index.html"):
                    return self.send(302, extra={"Location": "login", "Cache-Control": "no-store"})
                return self.send(401, b"Sign in required", "text/plain", {"Cache-Control": "no-store"})
        if app == "officer" and rel == "login":
            note = ""
            if not S["users"]:
                note = '<p class="n">No accounts yet. Create the admin account first: open the Visitor app and tap Staff setup.</p>'
            return self.send(200, LOGIN.replace("__NOTE__", note).encode(), "text/html; charset=utf-8",
                             {"Cache-Control": "no-store"})
        if rel == "sw.js":
            return self.send(200, service_worker(app).encode(), "text/javascript; charset=utf-8",
                             {"Cache-Control": "no-cache", "Service-Worker-Allowed": f"/{app}/"})
        if rel == "":
            rel = "index.html"
        base = APPS[app]
        fp = os.path.normpath(os.path.join(base, rel))
        if not fp.startswith(base + os.sep):
            return self.send(403)
        try:
            with open(fp, "rb") as f:
                b = f.read()
        except (FileNotFoundError, IsADirectoryError, PermissionError, NotADirectoryError):
            return self.send(404, b"Not found", "text/plain")
        ext = os.path.splitext(fp)[1].lower()
        if rel == "index.html":
            b = patch_index(app, b.decode("utf-8")).encode("utf-8")
            cc = "no-cache"
        else:
            cc = "no-cache"
        if app == "officer":
            cc = "private, " + cc
        self.send(200, b, MIME.get(ext, "application/octet-stream"), {"Cache-Control": cc})

    # ---------- sending email (runs outside the data lock; SMTP can be slow) ----------
    def api_send(self, p):
        try:
            if self.headers.get("x-pd") != "1":
                return self.fail(403, "Bad request")
            with LOCK:
                s = self.get_sess()
                if not mail_on() and p == "email":
                    return self.fail(501, "Email is not set up on the server.")
                if not S["mail"].get("host") or not S["mail"].get("from"):
                    return self.fail(400, "Enter the sender address and the mail server first.")
                if p == "mail/test":
                    if not s or s["role"] != "admin":
                        return self.fail(403, "Admin only")
                    b = self.read_json()
                    to = str(b.get("to") or "").strip()
                    if not to or not ok_email(to):
                        return self.fail(400, "Enter a valid address for the test.")
                    job = ([to], "", "Test email from the Tisbury PD apps",
                           "This is a test. If you can read it, Email officer is set up correctly.", [])
                    who = s["u"]
                elif isinstance(b := self.read_json(40_000_000), dict) and b.get("self") is not None:
                    # Visitor emails a copy to themselves. Fixed subject/body, one recipient,
                    # nobody else copied, and replies go to an address that cannot exist.
                    officer_app = bool(s) and b.get("app") == "officer"  # always allowed in the officer app
                    to = str(b.get("self") or "").strip()
                    if len(to) > 200 or not re.match(r"^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$", to):
                        return self.fail(400, "Enter a valid email address.")
                    if limited("self:" + (s["u"] if officer_app else self.ip()), 30 if officer_app else 3, 600) \
                            or limited("selfto:" + to.lower(), 3, 3600):
                        return self.fail(429, "Too many emails. Ask at the front desk.")
                    files = self.pdf_files(b)
                    pt = b.get("lang") == "pt"
                    form = re.sub(r"[\r\n<>]+", " ", str(b.get("name") or "")).strip()[:120]
                    subject = ("Sua cópia: " if pt else "Your copy: ") + (form or ("formulário" if pt else "form")) + " - Tisbury Police"
                    body = (("Em anexo está a cópia do formulário que você preencheu no Departamento de Polícia de Tisbury.\n\n"
                             "Esta é uma mensagem automática. Respostas a este e-mail não são recebidas. "
                             "Para falar com o departamento, ligue ou visite a recepção.\n")
                            if pt else
                            ("Attached is a copy of the form you completed at the Tisbury Police Department.\n\n"
                             "This is an automated message. Replies to this email are not received. "
                             "To contact the department, call or visit the front desk.\n"))
                    job = ([to], "", subject, body, files, True)
                    who = s["u"] if officer_app else "visitor@" + self.ip()
                    p = "email-self"
                else:
                    if limited("mail:" + self.ip(), 10, 600):
                        return self.fail(429, "Too many emails. Try again later.")
                    ids = b.get("to") if isinstance(b.get("to"), list) else []
                    offs = [o for o in S["officers"] if o.get("id") in ids and o.get("email")]
                    if not offs:
                        return self.fail(400, "The selected officer(s) have no email address.")
                    files = self.pdf_files(b)
                    subject = re.sub(r"[\r\n]+", " ", str(b.get("subject") or "Completed form"))[:200]
                    text = str(b.get("text") or "")[:4000]
                    job = ([o["email"] for o in offs], S["cc"], subject, text, files)
                    who = s["u"] if s else self.ip()
            send_mail(*job)
            with LOCK:
                audit({"email": "email", "email-self": "email-self"}.get(p, "mail-test"), who, to=job[0], cc=job[1],
                      files=[f[0] for f in job[4]])
            return self.json(200, {"ok": True})
        except HttpError as e:
            return self.fail(e.code, e.msg)
        except Exception as x:
            with LOCK:
                audit("email-failed", self.ip(), err=str(x)[:300])
            msg = str(x)
            if isinstance(x, smtplib.SMTPAuthenticationError):
                msg = "The mail server rejected the username or password."
            return self.fail(502, "The email could not be sent: " + msg[:200])

    # ---------- mail endpoint for the GitHub (standalone) apps ----------
    def relay_origin(self):
        o = (self.headers.get("origin") or "").rstrip("/")
        allowed = (S["mail"].get("relayOrigins") or "").split()
        return o if o and o in allowed else None

    def relay_out(self, code, obj):
        h = {"Cache-Control": "no-store", "Vary": "Origin"}
        o = self.relay_origin()
        if o:
            h.update({"Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS",
                      "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600"})
        self.send(code, json.dumps(obj).encode(), "application/json", h)

    def api_relay(self):
        if self.command == "OPTIONS":
            return self.relay_out(204 if self.relay_origin() else 403, {})
        if self.command != "POST":
            return self.relay_out(405, {"error": "Use POST"})
        try:
            with LOCK:
                mm = S["mail"]
                if self.headers.get("origin") and not self.relay_origin():
                    return self.relay_out(403, {"error": "This website is not allowed. Add it under Email sending > Allowed app websites on the server."})
                b = self.read_json(40_000_000)
                if not mm.get("relayKey"):
                    return self.relay_out(503, {"error": "The server's key for the GitHub apps is not set."})
                if not hmac.compare_digest(str(b.get("key") or ""), mm["relayKey"]):
                    if limited("relaybad:" + self.ip(), 10, 600):
                        return self.relay_out(429, {"error": "Too many attempts."})
                    return self.relay_out(401, {"error": "Wrong key. Check Staff setup > Email sending."})
                if not mail_on():
                    return self.relay_out(501, {"error": "Email is not set up on the server."})
                kind = b.get("kind")
                if kind == "test":
                    to = str((b.get("to") or [""])[0]).strip()
                    if not ok_email(to) or not to:
                        return self.relay_out(400, {"error": "Enter a valid address for the test."})
                    job = ([to], "", "Test email from the Tisbury PD apps",
                           "This is a test. If you can read it, automatic email is set up correctly.", [])
                elif kind == "officer":
                    if limited("relay:" + self.ip(), 30, 600):
                        return self.relay_out(429, {"error": "Too many emails. Try again later."})
                    to = [str(x).strip() for x in (b.get("to") or []) if isinstance(x, str) and ok_email(str(x).strip()) and str(x).strip()]
                    if not to:
                        return self.relay_out(400, {"error": "The selected officer(s) have no email address."})
                    known = {o["email"].lower() for o in S["officers"] if o.get("email")}
                    extra = [x.lower() for x in (mm.get("relayAllow") or "").split()]
                    ok = lambda a: a.lower() in known or any((x.startswith("@") and a.lower().endswith(x)) or a.lower() == x for x in extra)
                    bad = [a for a in to if not ok(a)]
                    if bad:
                        return self.relay_out(403, {"error": "Not an allowed officer address: " + ", ".join(bad)})
                    files = self.pdf_files(b)
                    subject = re.sub(r"[\r\n]+", " ", str(b.get("subject") or "Completed form"))[:200]
                    job = (to, S["cc"], subject, str(b.get("text") or "")[:4000], files)
                elif kind == "self":
                    to = str(b.get("self") or "").strip()
                    if len(to) > 200 or not re.match(r"^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$", to):
                        return self.relay_out(400, {"error": "Enter a valid email address."})
                    if limited("rself:" + self.ip(), 30, 600) or limited("selfto:" + to.lower(), 3, 3600):
                        return self.relay_out(429, {"error": "Too many emails. Ask at the front desk."})
                    files = self.pdf_files(b)
                    pt = b.get("lang") == "pt"
                    form = re.sub(r"[\r\n<>]+", " ", str(b.get("name") or "")).strip()[:120]
                    subject = ("Sua cópia: " if pt else "Your copy: ") + (form or ("formulário" if pt else "form")) + " - Tisbury Police"
                    body = (("Em anexo está a cópia do formulário que você preencheu no Departamento de Polícia de Tisbury.\n\n"
                             "Esta é uma mensagem automática. Respostas a este e-mail não são recebidas.\n") if pt else
                            ("Attached is a copy of the form you completed at the Tisbury Police Department.\n\n"
                             "This is an automated message. Replies to this email are not received.\n"))
                    job = ([to], "", subject, body, files, True)
                else:
                    return self.relay_out(400, {"error": "Unknown request"})
            send_mail(*job)
            with LOCK:
                audit("relay-" + kind, "github-app@" + self.ip(), to=job[0], files=[f[0] for f in job[4]])
            return self.relay_out(200, {"ok": True})
        except HttpError as e:
            return self.relay_out(e.code, {"error": e.msg})
        except Exception as x:
            with LOCK:
                audit("relay-failed", self.ip(), err=str(x)[:300])
            msg = "The mail server rejected the username or password." if isinstance(x, smtplib.SMTPAuthenticationError) else str(x)[:200]
            return self.relay_out(502, {"error": "The email could not be sent: " + msg})

    def pdf_files(self, b):
        pdfs = b.get("pdfs") if isinstance(b.get("pdfs"), list) else (
            [{"filename": b.get("filename"), "pdf": b.get("pdf")}] if b.get("pdf") else [])
        files = []
        for f in pdfs[:3]:
            try:
                data = base64.b64decode(str((f or {}).get("pdf") or ""))
            except Exception:
                data = b""
            if not is_pdf(data) or len(data) > 15_000_000:
                raise HttpError(400, "Invalid PDF")
            files.append((clean_name((f or {}).get("filename")), data))
        if not files:
            raise HttpError(400, "No PDF attached")
        return files

    # ---------- API ----------
    def api(self, p, q):
        m = self.command
        s = self.get_sess()
        if m not in ("GET", "HEAD") and self.headers.get("x-pd") != "1":
            return self.fail(403, "Bad request")
        app = "officer" if q.get("app") == "officer" else "kiosk"

        def need(*roles):
            if not s:
                self.fail(401, "Please sign in")
                return False
            if roles and s["role"] not in roles:
                self.fail(403, "Your account can't do that")
                return False
            return True

        staff = lambda: need("admin", "staff")
        admin = lambda: need("admin")
        officer_ok = bool(s)

        def form_list():
            return [{"id": f["id"], "name": f["name"], "lang": f["lang"], "audience": f.get("audience", "all"),
                     "ver": f.get("ver", 1)}
                    for f in S["forms"]
                    if f.get("audience", "all") == "all" or (app == "officer" and officer_ok)]

        if p == "version" and m == "GET":
            return self.json(200, {"ver": app_version(app), "rev": S["rev"]})

        if p == "state" and m == "GET":
            if app == "officer" and not s:
                return self.fail(401, "Please sign in")
            out = {"needSetup": not S["users"], "session": pub(s) if s else None, "rev": S["rev"],
                   "ver": app_version(app), "officers": S["officers"], "cc": S["cc"],
                   "kinds": S["kinds"].get(app, {}), "forms": form_list(),
                   "mailOn": mail_on(), "mailFrom": S["mail"]["from"] if mail_on() else "",
                   "selfOn": mail_on()}
            if app == "officer":
                out["gmkey"] = S.get("gmkey", "")
            if s and s["role"] == "admin":
                out["users"] = [pub(x) for x in S["users"]]
            return self.json(200, out)

        if p == "setup" and m == "POST":
            if S["users"]:
                return self.fail(409, "Already set up")
            b = self.read_json()
            u, pw = str(b.get("u") or "").strip(), str(b.get("p") or "")
            if not u or len(u) > 60:
                return self.fail(400, "Enter a username.")
            if len(pw) < 10:
                return self.fail(400, "Password must be at least 10 characters.")
            S["users"].append(mk_user(u, pw, "admin"))
            save()
            audit("setup", u)
            return self.json(200, {"session": {"u": u, "role": "admin"}}, self.new_session(u, "admin"))

        if p == "login" and m == "POST":
            if limited("login:" + self.ip(), 30, 60):
                return self.fail(429, "Too many attempts. Wait a minute.")
            b = self.read_json()
            u, pw = str(b.get("u") or "").strip(), str(b.get("p") or "")
            r = next((x for x in S["users"] if x["u"].lower() == u.lower()), None)
            if r and r.get("lock", 0) > now_ms():
                mins = -(-(r["lock"] - now_ms()) // 60000)
                return self.fail(429, f"Too many attempts. Try again in {mins} min.")
            h = hash_pw(pw, r["salt"] if r else "0" * 32)
            if not r or not hmac.compare_digest(h, r["hash"]):
                if r:
                    r["fails"] = r.get("fails", 0) + 1
                    if r["fails"] >= 5:
                        r["lock"], r["fails"] = now_ms() + 300_000, 0
                    save()
                audit("login-failed", u, ip=self.ip())
                return self.fail(401, "Incorrect username or password.")
            r["fails"] = 0
            save()
            audit("login", r["u"], ip=self.ip(), app="officer" if b.get("long") else "kiosk")
            return self.json(200, {"session": pub(r)}, self.new_session(r["u"], r["role"], b.get("long")))

        if p == "logout" and m == "POST":
            t = self.cookies().get("pdsid")
            if t:
                SESS.pop(t, None)
            return self.json(200, {"ok": True}, {"Set-Cookie": self.cookie_header("", 0)})

        if p == "users" and m == "GET":
            if not admin():
                return
            return self.json(200, {"users": [pub(x) for x in S["users"]]})

        if p == "users" and m == "POST":
            if not admin():
                return
            b = self.read_json()
            u, pw = str(b.get("u") or "").strip(), str(b.get("p") or "")
            role = b.get("role") if b.get("role") in ("admin", "staff", "officer") else "staff"
            if not u or len(u) > 60:
                return self.fail(400, "Enter a username.")
            if any(x["u"].lower() == u.lower() for x in S["users"]):
                return self.fail(409, "Username already exists.")
            if len(pw) < 10:
                return self.fail(400, "Password must be at least 10 characters.")
            S["users"].append(mk_user(u, pw, role))
            save()
            audit("user-add", s["u"], user=u, role=role)
            return self.json(200, {"ok": True})

        if p.startswith("users/") and m == "DELETE":
            if not admin():
                return
            u = unquote(p[6:])
            if u == s["u"]:
                return self.fail(400, "You cannot remove your own account.")
            i = next((i for i, x in enumerate(S["users"]) if x["u"] == u), -1)
            if i < 0:
                return self.fail(404, "Not found")
            S["users"].pop(i)
            save()
            for k in [k for k, v in SESS.items() if v["u"] == u]:
                SESS.pop(k, None)
            audit("user-remove", s["u"], user=u)
            return self.json(200, {"ok": True})

        if p == "password" and m == "POST":
            if not need():
                return
            b = self.read_json()
            u, pw = str(b.get("u") or ""), str(b.get("p") or "")
            if s["role"] != "admin" and u != s["u"]:
                return self.fail(403, "Not allowed")
            if len(pw) < 10:
                return self.fail(400, "Password must be at least 10 characters.")
            r = next((x for x in S["users"] if x["u"] == u), None)
            if not r:
                return self.fail(404, "Not found")
            r.update(mk_user(r["u"], pw, r["role"]))
            save()
            audit("password", s["u"], user=u)
            return self.json(200, {"ok": True})

        if p == "settings" and m == "PUT":
            b = self.read_json(2_000_000)
            key, val = b.get("key"), b.get("value")
            if key == "kinds":
                if not need():
                    return
                if not isinstance(val, dict) or len(json.dumps(val)) > 500_000:
                    return self.fail(400, "Bad field settings")
                S["kinds"][app] = val
            else:
                if not staff():
                    return
                if key == "officers":
                    if not isinstance(val, list) or len(val) > 300:
                        return self.fail(400, "Bad officers list")
                    out = []
                    for o in val:
                        if not isinstance(o, dict):
                            continue
                        name = str(o.get("name") or "").strip()[:100]
                        email = str(o.get("email") or "").strip()
                        if not name:
                            continue
                        if not ok_email(email):
                            return self.fail(400, "Invalid email for " + name)
                        oid = str(o.get("id") or "")
                        out.append({"id": oid if re.match(r"^[\w-]{8,64}$", oid) else str(uuid.uuid4()),
                                    "name": name, "email": email})
                    S["officers"] = out
                elif key == "cc":
                    val = str(val or "").strip()
                    if len(val) > 500 or not ok_emails(val):
                        return self.fail(400, "Invalid CC email")
                    S["cc"] = val
                elif key == "gmkey":
                    S["gmkey"] = str(val or "").strip()[:200]
                else:
                    return self.fail(400, "Unknown setting")
            save()
            audit("setting", s["u"], key=key, app=app)
            return self.json(200, {"ok": True, "rev": S["rev"]})

        if p == "mail" and m == "GET":
            if not admin():
                return
            mm = S["mail"]
            return self.json(200, {**{k: v for k, v in mm.items() if k != "pass"}, "passSet": bool(mm.get("pass"))})

        if p == "mail" and m == "PUT":
            if not admin():
                return
            b = self.read_json()
            frm = str(b.get("from") or "").strip()
            if frm and not ok_email(frm):
                return self.fail(400, "The sender address is not a valid email.")
            sec = b.get("sec") if b.get("sec") in ("starttls", "ssl", "none") else "starttls"
            try:
                port = int(b.get("port") or 587)
                assert 1 <= port <= 65535
            except Exception:
                return self.fail(400, "Invalid port.")
            on = bool(b.get("on"))
            host = str(b.get("host") or "").strip()[:200]
            if on and (not frm or not host):
                return self.fail(400, "To turn email on, enter the sender address and the mail server.")
            mm = S["mail"]
            mm.update(on=on, selfOn=bool(b.get("selfOn")), **{"from": frm}, name=str(b.get("name") or "").strip()[:100], host=host,
                      port=port, sec=sec, user=str(b.get("user") or "").strip()[:200])
            if b.get("pass"):
                mm["pass"] = str(b["pass"])[:500]
            if "relayKey" in b:
                rk = str(b.get("relayKey") or "").strip()
                if rk and len(rk) < 16:
                    return self.fail(400, "The key for the GitHub apps must be at least 16 characters.")
                mm["relayKey"] = rk[:200]
            if "relayOrigins" in b:
                origins = [o.strip().rstrip("/") for o in re.split(r"[\s,]+", str(b.get("relayOrigins") or "")) if o.strip()]
                if any(not re.match(r"^https://[\w.-]+(:\d+)?$", o) for o in origins):
                    return self.fail(400, "Allowed websites must look like https://yourname.github.io")
                mm["relayOrigins"] = " ".join(origins)[:1000]
            if "relayAllow" in b:
                mm["relayAllow"] = " ".join(x.strip() for x in re.split(r"[\s,;]+", str(b.get("relayAllow") or "")) if x.strip())[:2000]
            save()
            audit("mail-settings", s["u"], on=on, sender=frm, host=host)
            return self.json(200, {"ok": True, "mailOn": mail_on(), "from": frm, "passSet": bool(mm.get("pass")),
                                   "selfOn": mail_on() and bool(mm.get("selfOn"))})

        if p == "forms" and m == "POST":
            if not staff():
                return
            buf = self.body(25_000_000)
            if not is_pdf(buf):
                return self.fail(400, "That is not a PDF file.")
            name = clean_name(q.get("name"))
            lang = "pt" if q.get("lang") == "pt" else "en"
            aud = "officer" if q.get("audience") == "officer" else "all"
            f = next((x for x in S["forms"] if x["name"].lower() == name.lower() and x.get("audience", "all") == aud), None)
            if f:
                f.update(lang=lang, name=name, ver=f.get("ver", 1) + 1)
            else:
                f = {"id": str(uuid.uuid4()), "name": name, "lang": lang, "audience": aud, "ver": 1}
                S["forms"].append(f)
            with open(os.path.join(FORMS, f["id"] + ".pdf"), "wb") as fh:
                fh.write(buf)
            save()
            audit("form-upload", s["u"], name=name, lang=lang, audience=aud)
            return self.json(200, {"id": f["id"], "ver": f["ver"], "rev": S["rev"]})

        fm = re.match(r"^forms/([\w-]{8,64})$", p)
        if fm:
            f = next((x for x in S["forms"] if x["id"] == fm.group(1)), None)
            if not f:
                return self.fail(404, "Form not found")
            fp = os.path.join(FORMS, f["id"] + ".pdf")
            if m in ("GET", "HEAD"):
                if f.get("audience", "all") == "officer" and not s:
                    return self.fail(401, "Please sign in")
                try:
                    with open(fp, "rb") as fh:
                        b = fh.read()
                except OSError:
                    return self.fail(404, "Form file missing")
                return self.send(200, b, "application/pdf", {"Cache-Control": "no-store"})
            if m == "PUT":
                if not staff():
                    return
                buf = self.body(25_000_000)
                if not is_pdf(buf):
                    return self.fail(400, "That is not a PDF file.")
                with open(fp, "wb") as fh:
                    fh.write(buf)
                if q.get("lang") in ("en", "pt"):
                    f["lang"] = q["lang"]
                f["ver"] = f.get("ver", 1) + 1
                save()
                audit("form-update", s["u"], name=f["name"])
                return self.json(200, {"id": f["id"], "ver": f["ver"], "rev": S["rev"]})
            if m == "DELETE":
                if not staff():
                    return
                S["forms"] = [x for x in S["forms"] if x["id"] != f["id"]]
                save()
                try:
                    os.remove(fp)
                except OSError:
                    pass
                audit("form-remove", s["u"], name=f["name"])
                return self.json(200, {"ok": True, "rev": S["rev"]})

        return self.fail(404, "Not found")


def main():
    ap = argparse.ArgumentParser(description="Tisbury PD central server (kiosk + officer apps)")
    ap.add_argument("--port", type=int)
    ap.add_argument("--https", action="store_true", help="serve HTTPS (certificate from tpd_server.py)")
    ap.add_argument("--lan", action="store_true", help="allow other devices on the network (use with --https)")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--reset-users", action="store_true")
    a = ap.parse_args()

    if a.reset_users:
        S["users"] = []
        save()
        print("All accounts removed. Open the Visitor app > Staff setup to create a new admin.")
        return
    for app, d in APPS.items():
        if not os.path.exists(os.path.join(d, "index.html")):
            print(f"Can't find the {app} app. Expected: {os.path.join(d, 'index.html')}")
            return
    if a.lan and not a.https:
        print("--lan needs --https (other devices need a secure connection). Use: --https --lan")
        return

    port = a.port or (8493 if a.https else 8090)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0" if a.lan else "127.0.0.1", port), Handler)
    if a.https:
        import tpd_server
        tpd_server.make_cert()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(tpd_server.CERT_FILE, tpd_server.KEY_FILE)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        Handler.secure = True
    threading.Thread(target=janitor, daemon=True).start()

    url = f"{'https' if a.https else 'http'}://localhost:{port}/"
    print("\nTisbury PD Central Server running")
    print(f"  Visitor app:  {url}kiosk/")
    print(f"  Officer app:  {url}officer/")
    if a.lan:
        import tpd_server
        dns, ips = tpd_server.this_pc_names()
        print("\n  OTHER COMPUTERS on the network open one of these:")
        for h in [d for d in dns if d != "localhost"] + [i for i in ips if i != "127.0.0.1"]:
            print(f"      https://{h}:{port}/")
        print(f"  First time on each computer: open  https://{(dns[1:] or ips[1:] or ['localhost'])[0]}:{port}/setup")
        print("  and install the certificate (steps on that page). Certificate file:")
        print(f"      {tpd_server.CA_CRT}")
        print("  If other computers can't connect at all, Windows Firewall is blocking port", port, "(see README).\n")
    print(f"  Data:         {DATA}   (back this folder up)")
    print("  Update an app by replacing its files in central\\kiosk or central\\officer.")
    print("  Close this window or press Ctrl+C to stop.\n")
    if not a.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
