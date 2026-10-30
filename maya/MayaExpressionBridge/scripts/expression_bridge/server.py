"""Localhost TCP server.

Socket I/O runs on worker threads; every `cmds` call is marshalled onto Maya's
main thread through `dispatch.run_on_main`. Maya-side changes are pushed to
every authorized client as JSON-RPC notifications (see `sync.py`).
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import socketserver
import threading
from pathlib import Path

from . import PROTOCOL_VERSION, adapter, dispatch, scanner, sync
from .protocol import Handler, encode, notification

log = logging.getLogger("expression_bridge")

MAX_LINE_BYTES = 8 * 1024 * 1024
_server = None
_session_file = None


def session_dir():
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "MayaExpressionBridge"


def build_methods(cmds, on_main=dispatch.run_on_main, watcher=None):
    def on_maya(fn):
        return lambda **kw: on_main(fn, cmds, **kw)

    def set_expression(c, id, text=None, settings=None, expectedHash=None):
        result = adapter.set_(c, id, text, settings, expectedHash)
        if watcher is not None:
            watcher.note_written(id, result["hash"])
        return result

    return {
        "list": on_maya(scanner.scan),
        "get": on_maya(lambda c, id: adapter.get(c, id)),
        "set": on_maya(set_expression),
        "select": on_maya(lambda c, object: adapter.select(c, object)),
    }


class _RequestHandler(socketserver.StreamRequestHandler):
    def setup(self):
        super().setup()
        self.write_lock = threading.Lock()  # responses and pushes share the socket

    def send(self, message):
        with self.write_lock:
            self.wfile.write(encode(message))

    def handle(self):
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return
        log.info("Client connected")
        try:
            while True:
                line = self.rfile.readline(MAX_LINE_BYTES)
                if not line:
                    break
                if not line.strip():
                    continue
                response, authorized = self.server.handler.handle(line)
                if authorized:
                    self.server.add_client(self)
                self.send(response)
        finally:
            self.server.remove_client(self)
            log.info("Client disconnected")


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, handler):
        super().__init__(address, _RequestHandler)
        self.handler = handler
        self._clients = set()
        self._clients_lock = threading.Lock()

    def add_client(self, client):
        with self._clients_lock:
            self._clients.add(client)

    def remove_client(self, client):
        with self._clients_lock:
            self._clients.discard(client)

    def broadcast(self, method, params):
        with self._clients_lock:
            clients = list(self._clients)
        for client in clients:
            try:
                client.send(notification(method, params))
            except OSError:
                self.remove_client(client)


class _Bridge:
    def __init__(self, server, watcher, poller):
        self.server, self.watcher, self.poller = server, watcher, poller


def start(port=0, cmds=None, on_main=dispatch.run_on_main, poll_interval=sync.POLL_SECONDS):
    """Start the bridge. Port 0 picks a free port, published in session.json.

    `poll_interval=None` disables the background poll (tests call `poll()` directly).
    """
    global _server, _session_file
    if _server is not None:
        return _server.server.server_address[1]
    if cmds is None:
        from maya import cmds

    token = secrets.token_urlsafe(32)
    server = _Server(("127.0.0.1", port), None)
    watcher = sync.Watcher(cmds, server.broadcast)
    server.handler = Handler(token, build_methods(cmds, on_main, watcher), log)
    threading.Thread(target=server.serve_forever, name="ExpressionBridge", daemon=True).start()

    # start() is normally called on the main thread, so install directly.
    watcher.install()
    poller = None
    if poll_interval:
        poller = sync.Poller(watcher, on_main, poll_interval)
        poller.start()
    _server = _Bridge(server, watcher, poller)

    actual_port = server.server_address[1]
    _session_file = _write_session(actual_port, token, cmds)
    log.info("Expression bridge listening on 127.0.0.1:%d", actual_port)
    return actual_port


def watcher():
    return _server.watcher if _server else None


def _write_session(port, token, cmds):
    directory = session_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "session.json"
    try:
        maya_version = cmds.about(version=True)
    except Exception:
        maya_version = None
    data = {"port": port, "token": token, "pid": os.getpid(),
            "mayaVersion": maya_version, "protocol": PROTOCOL_VERSION}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)  # atomic, so the client never reads a half-written file
    return path


def stop():
    """Stop the bridge. Call on the main thread."""
    global _server, _session_file
    if _server is None:
        return
    if _server.poller:
        _server.poller.stop()
    _server.watcher.uninstall()
    _server.server.shutdown()
    _server.server.server_close()
    _server = None
    if _session_file is not None:
        _session_file.unlink(missing_ok=True)
        _session_file = None
