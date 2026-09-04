#!/usr/bin/env python3
"""Drive a headless Chrome that reuses the desktop profile's logins, over CDP.

Copies only the small auth-bearing files out of ~/.config/google-chrome into a scratch
profile so the live browser is never touched, then talks the DevTools protocol.

Both --remote-allow-origins=* and suppress_origin on the websocket are required or the
handshake 403s. Learned that the hard way; do not remove either.

Usage as a library:
    from cdp import Chrome
    with Chrome() as c:
        c.goto("https://mail.google.com/mail/u/0/#search/verify")
        print(c.text())
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    import websocket  # websocket-client
except ImportError:
    print("pip install websocket-client", file=sys.stderr)
    raise

PROFILE = os.path.expanduser("~/.config/google-chrome")
COPY = [
    "Local State",
    "Default/Cookies",
    "Default/Login Data",
    "Default/Preferences",
    "Default/Local Storage",
    "Default/Network/Cookies",
]


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Chrome:
    def __init__(self, headless=True, scratch=None, port=None, window="1440,2400"):
        self.scratch = scratch or tempfile.mkdtemp(prefix="cdp-profile-")
        self.port = port or _free_port()
        self.headless = headless
        self.window = window
        self.proc = None
        self.ws = None
        self._id = 0

    # ---------- lifecycle ----------
    def _seed_profile(self):
        for rel in COPY:
            src = os.path.join(PROFILE, rel)
            dst = os.path.join(self.scratch, rel)
            if not os.path.exists(src):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)

    def start(self):
        self._seed_profile()
        args = [
            "google-chrome",
            "--user-data-dir=" + self.scratch,
            "--remote-debugging-port=%d" % self.port,
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-features=Translate,OptimizationHints",
            "--window-size=" + self.window,
        ]
        if self.headless:
            args.append("--headless=new")
        self.proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        url = None
        for _ in range(120):
            try:
                with urllib.request.urlopen(
                    "http://127.0.0.1:%d/json/version" % self.port, timeout=1
                ) as r:
                    url = json.load(r)["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.25)
        if not url:
            raise RuntimeError("chrome did not expose CDP on port %d" % self.port)
        self.browser_ws = websocket.create_connection(
            url, suppress_origin=True, timeout=90
        )
        tgt = self._send_on(self.browser_ws, "Target.createTarget", {"url": "about:blank"})
        self.target = tgt["targetId"]
        pages = json.load(
            urllib.request.urlopen("http://127.0.0.1:%d/json/list" % self.port)
        )
        page = next(p for p in pages if p["id"] == self.target)
        self.ws = websocket.create_connection(
            page["webSocketDebuggerUrl"], suppress_origin=True, timeout=90
        )
        self.send("Page.enable")
        self.send("Runtime.enable")
        self.send("Network.enable")
        return self

    def close(self):
        for w in (getattr(self, "ws", None), getattr(self, "browser_ws", None)):
            try:
                w and w.close()
            except Exception:
                pass
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except Exception:
                self.proc.kill()
        shutil.rmtree(self.scratch, ignore_errors=True)

    def __enter__(self):
        return self.start()

    def __exit__(self, *a):
        self.close()

    # ---------- protocol ----------
    def _send_on(self, ws, method, params=None):
        self._id += 1
        mid = self._id
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg.get("result", {})

    def send(self, method, params=None):
        return self._send_on(self.ws, method, params)

    def js(self, expr, await_promise=False):
        r = self.send(
            "Runtime.evaluate",
            {
                "expression": expr,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
        )
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:600])
        return r.get("result", {}).get("value")

    # ---------- page helpers ----------
    def goto(self, url, wait_text=None, timeout=45):
        self.send("Page.navigate", {"url": url})
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.6)
            try:
                state = self.js("document.readyState")
            except Exception:
                continue
            if state in ("interactive", "complete"):
                if not wait_text:
                    return True
                if self.wait_text(wait_text, timeout=max(2, deadline - time.time())):
                    return True
        return False

    def wait_text(self, needle, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if needle.lower() in (self.text() or "").lower():
                    return True
            except Exception:
                pass
            time.sleep(0.7)
        return False

    def text(self):
        return self.js("document.body ? document.body.innerText : ''")

    def html(self):
        return self.js("document.documentElement.outerHTML")

    def url(self):
        return self.js("location.href")

    def cookies(self, urls):
        return self.send("Network.getCookies", {"urls": urls}).get("cookies", [])

    def shot(self, path, full=True):
        r = self.send(
            "Page.captureScreenshot", {"format": "png", "captureBeyondViewport": full}
        )
        import base64

        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        twin = os.path.splitext(path)[0] + ".txt"
        with open(twin, "w") as f:
            f.write((self.url() or "") + "\n\n" + (self.text() or ""))
        return path


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "https://dev.to/dashboard"
    want = sys.argv[2] if len(sys.argv) > 2 else None
    with Chrome() as c:
        ok = c.goto(target, wait_text=want)
        print("URL:", c.url())
        print("loaded:", ok)
        print((c.text() or "")[:3000])
