"""Web server for Slime Forge (serve it over Tailscale).

    python server.py                  listen on 127.0.0.1:8000
    python server.py --port 8080

Then expose it on your tailnet:
    tailscale serve --bg 8000
Each browser gets its own save, keyed by a random token it keeps in localStorage.
"""
import argparse
import json
import os
import re
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

from slimeforge.engine import Game

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
PKG = os.path.join(ROOT, "slimeforge")
SAVES = os.path.join(ROOT, "saves")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

games = {}
lock = threading.Lock()


def save_path(token):
    return os.path.join(SAVES, token + ".json")


def get_game(token):
    if token not in games:
        path = save_path(token)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                games[token] = Game.loads(f.read())
        else:
            games[token] = Game()
    return games[token]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def translate_path(self, path):
        # Serve /slimeforge/* from the package folder; everything else from web/.
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/slimeforge/"):
            rel = clean[len("/slimeforge/"):]
            return os.path.join(PKG, *[p for p in rel.split("/") if p not in ("", "..", ".")])
        return super().translate_path(path)

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/ping":
            return self._json(200, {"ok": True})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/cmd":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "bad json"})
        token = str(data.get("token", ""))
        cmd = str(data.get("cmd", ""))[:200]
        if not TOKEN_RE.match(token):
            return self._json(400, {"error": "bad token"})
        with lock:
            game = get_game(token)
            out = game.handle(cmd)
            os.makedirs(SAVES, exist_ok=True)
            with open(save_path(token), "w", encoding="utf-8") as f:
                f.write(game.dumps())
            bar = game.bar()
        self._json(200, {"out": out, "bar": bar})

    def log_message(self, fmt, *args):
        pass  # keep the console quiet; set to print() to debug


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Slime Forge on http://{args.host}:{args.port}  (Ctrl+C to stop)")
    print("Tailscale: run  tailscale serve --bg", args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
