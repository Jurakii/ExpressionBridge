"""Localhost TCP server.

Socket I/O runs on worker threads; every `cmds` call is marshalled onto Maya's
main thread through `dispatch.run_on_main`. Maya-side changes are pushed to
every authorized client as JSON-RPC notifications (see `sync.py`).
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import queue
import secrets
import socket
import socketserver
import threading
from pathlib import Path

from . import PROTOCOL_VERSION, adapter, dispatch, scanner, sync
from .protocol import Handler, encode, notification

log = logging.getLogger("expression_bridge")

MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_QUEUED_MESSAGES = 1024
_server = None
_session_file = None


def session_dir():
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "ExpressionBridge"


def build_methods(cmds, on_main=dispatch.run_on_main, watcher=None):
    def on_maya(fn):
        # Close over the params so a client can't set on_main's own keywords (timeout, defer).
        return lambda **kw: on_main(lambda: fn(cmds, **kw))

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
        self.authorized = False
        # Pushes are sent from Maya's main thread, so send() only queues. A client
        # that stops reading then costs its connection, not a frozen Maya.
        self._outbox = queue.Queue(MAX_QUEUED_MESSAGES)
        threading.Thread(target=self._write_loop, name="ExpressionBridgeWrite", daemon=True).start()
        self.server.add_connection(self)

    def send(self, message):
        try:
            self._outbox.put_nowait(encode(message))
        except queue.Full:
            if self.authorized:
                log.warning("Dropping a client that stopped reading")
            self.authorized = False  # no more pushes
            self.close()

    def close(self):
        with contextlib.suppress(OSError):
            self.connection.shutdown(socket.SHUT_RDWR)

    def _write_loop(self):
        while True:
            data = self._outbox.get()
            if data is None:
                return
            try:
                self.wfile.write(data)
            except (OSError, ValueError):  # ValueError: finish() already closed wfile
                self.close()
                return

    def finish(self):
        with contextlib.suppress(queue.Full):  # when full, the next write fails and ends the loop
            self._outbox.put_nowait(None)
        super().finish()

    def handle(self):
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return
        log.info("Client connected")
        try:
            while True:
                line = self.rfile.readline(MAX_LINE_BYTES + 1)
                if not line:
                    break
                if len(line) > MAX_LINE_BYTES:
                    log.warning("Dropping a client that sent an oversized message")
                    break
                if not line.strip():
                    continue
                response, authorized = self.server.handler.handle(line)
                self.authorized = self.authorized or authorized
                self.send(response)
        except OSError:
            pass  # the client vanished, e.g. VS Code closed mid-read
        finally:
            self.server.remove_connection(self)
            log.info("Client disconnected")


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, handler):
        super().__init__(address, _RequestHandler)
        self.handler = handler
        self._connections = set()
        self._connections_lock = threading.Lock()

    def add_connection(self, connection):
        with self._connections_lock:
            self._connections.add(connection)

    def remove_connection(self, connection):
        with self._connections_lock:
            self._connections.discard(connection)

    def connections(self):
        with self._connections_lock:
            return list(self._connections)

    def broadcast(self, method, params):
        for connection in self.connections():
            if connection.authorized:
                connection.send(notification(method, params))


class _Bridge:
    def __init__(self, server, watcher, poller, token):
        self.server, self.watcher, self.poller, self.token = server, watcher, poller, token


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
    _server = _Bridge(server, watcher, poller, token)

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
    tmp.touch(mode=0o600)  # holds the token
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)  # atomic, so the client never reads a half-written file
    return path


def _remove_session(path, token):
    """Delete session.json unless another Maya has since replaced it with its own."""
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if current.get("token") == token:
        path.unlink(missing_ok=True)


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
    # Handler threads outlive the listener, so end them or clients stay connected to a stopped bridge.
    for connection in _server.server.connections():
        connection.close()
    token = _server.token
    _server = None
    if _session_file is not None:
        _remove_session(_session_file, token)
        _session_file = None
