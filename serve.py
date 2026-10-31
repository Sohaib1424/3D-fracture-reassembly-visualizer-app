#!/usr/bin/env python3
"""
Serve the Reassembly Visualizer on this computer and open it in the browser.

    python serve.py                     then "Open folder" in the page
    python serve.py "E:\\dumps"          the sidebar starts on that folder
    python serve.py --port 9000 --no-browser

Browsers do not run a page's modules from a file:// address, so the page needs
a server. This one is Python's own, bound to 127.0.0.1: nothing outside this
computer can reach it. It serves this folder and, when FOLDER is given, the
.npz files under FOLDER, read-only, and nothing else.

Needs Python 3.8 or later and nothing else.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
DEFAULT_PORT = 8765
APP = "reassembly-visualizer"

# Set explicitly: Windows takes these from the registry, where .js is
# sometimes text/plain, and browsers refuse to run a module served that way.
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".md": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".npz": "application/octet-stream",
}

# Folders the scan never enters (the page's own scan skips the same ones).
SKIP = {"node_modules", "__pycache__", ".git", ".venv", "venv", ".idea", ".vscode"}
MAX_DEPTH = 12


# -- the dumps folder ---------------------------------------------------------

def list_dumps(root: Path) -> dict:
    """Every .npz under ``root`` as a tree; folders without any are left out.
    Paths start with the folder's own name, as in the page's own scan."""
    def visit(folder: Path, path: str, relative: str, depth: int) -> dict:
        node = {"name": folder.name or str(folder), "path": path, "kind": "dir", "children": []}
        if depth > MAX_DEPTH:
            return node
        try:
            entries = list(os.scandir(folder))
        except OSError:
            return node
        for entry in entries:
            name = entry.name
            inner = f"{relative}/{name}" if relative else name
            try:
                if entry.is_dir():
                    if name.startswith(".") or name in SKIP:
                        continue
                    child = visit(Path(entry.path), f"{path}/{name}", inner, depth + 1)
                    if child["children"]:
                        node["children"].append(child)
                elif entry.is_file() and name.lower().endswith(".npz"):
                    info = entry.stat()
                    node["children"].append({
                        "name": name, "path": f"{path}/{name}", "kind": "file",
                        "url": "api/file?path=" + urllib.parse.quote(inner, safe=""),
                        "size": info.st_size, "modified": int(info.st_mtime * 1000),
                    })
            except OSError:
                continue
        return node

    return visit(root, root.name or str(root), "", 0)


def resolve_dump(root: Path, relative: str) -> Optional[Path]:
    """The .npz at ``relative`` under ``root``, or None. No ``..``, no drive
    letters, no absolute paths: only files the listing could have shown."""
    parts = [part for part in relative.replace("\\", "/").split("/") if part not in ("", ".")]
    if not parts or any(part == ".." or ":" in part for part in parts):
        return None
    path = root.joinpath(*parts)
    base = os.path.abspath(root)
    if os.path.commonpath([os.path.abspath(path), base]) != base:
        return None
    if path.suffix.lower() != ".npz" or not path.is_file():
        return None
    return path


# -- the server -----------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    server_version = "ReassemblyVisualizer/1"

    def __init__(self, *args, dumps: Optional[Path] = None, **kwargs):
        self.dumps = dumps
        super().__init__(*args, **kwargs)

    def end_headers(self):
        # The page always loads its latest files after an update.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        return TYPES.get(Path(str(path)).suffix.lower()) or super().guess_type(path)

    def host_allowed(self) -> bool:
        # Only pages addressed to this server by its own name may use it, so a
        # web page elsewhere cannot reach it through a DNS trick.
        host = (self.headers.get("Host") or "").lower()
        port = self.server.server_address[1]
        return host in {f"127.0.0.1:{port}", f"localhost:{port}"}

    def do_GET(self):
        if not self.host_allowed():
            self.send_error(HTTPStatus.FORBIDDEN, "Open the page at http://127.0.0.1")
            return
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/api/hello":
            self.send_json({"app": APP})
        elif url.path == "/api/folder":
            self.send_json({"app": APP, "folder": list_dumps(self.dumps) if self.dumps else None})
        elif url.path == "/api/file":
            self.send_dump(urllib.parse.parse_qs(url.query).get("path", [""])[0])
        elif url.path.startswith("/api/"):
            self.send_error(HTTPStatus.NOT_FOUND)
        else:
            super().do_GET()

    def do_HEAD(self):
        if not self.host_allowed():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        super().do_HEAD()

    def send_json(self, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_dump(self, relative: str):
        path = resolve_dump(self.dumps, relative) if self.dumps else None
        try:
            handle = open(path, "rb") if path else None
        except OSError:
            handle = None
        if handle is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such dump in the folder")
            return
        with handle:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(os.fstat(handle.fileno()).st_size))
            self.end_headers()
            shutil.copyfileobj(handle, self.wfile)

    def log_request(self, code="-", size="-"):
        # Quiet unless something failed.
        try:
            if int(code) < 400:
                return
        except (TypeError, ValueError):
            pass
        super().log_request(code, size)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second server take a port that is already
    # in use, and the two then share the requests; without it a busy port
    # fails cleanly and the next one is tried.
    allow_reuse_address = sys.platform != "win32"

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return  # the browser closed the connection: nothing to report
        super().handle_error(request, client_address)


def running_here(port: int) -> bool:
    """Whether this app already answers on ``port``."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/hello", timeout=1.0) as response:
            return json.load(response).get("app") == APP
    except Exception:
        return False


def start(handler, port: int, exact: bool) -> Server:
    candidates = [port] if exact else [port + k for k in range(10)] + [0]
    failure = None
    for candidate in candidates:
        try:
            return Server(("127.0.0.1", candidate), handler)
        except OSError as error:
            failure = error
    raise SystemExit(f"The server could not start on port {port}: {failure}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", nargs="?", default=None,
                        help="a folder of dumps for the sidebar to start on (optional)")
    parser.add_argument("--port", type=int, default=None,
                        help=f"port to use (default {DEFAULT_PORT}, or the next free one)")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser")
    args = parser.parse_args(argv)

    dumps = None
    if args.folder:
        dumps = Path(args.folder).expanduser().resolve()
        if not dumps.is_dir():
            print(f"{args.folder} is not a folder.")
            return 2

    port = args.port or DEFAULT_PORT
    if dumps is None and args.port is None and running_here(port):
        url = f"http://127.0.0.1:{port}/"
        print(f"The visualizer is already running at {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return 0

    handler = partial(Handler, directory=str(HERE), dumps=dumps)
    server = start(handler, port, exact=args.port is not None)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Reassembly Visualizer: {url}")
    if dumps:
        print(f"Dumps from {dumps}")
    print("Leave this window open while you use the page. Ctrl+C stops the server.")
    if not args.no_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
