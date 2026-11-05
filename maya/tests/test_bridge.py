import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ExpressionBridge" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from expression_bridge import adapter, dispatch, scanner, server, sync  # noqa: E402
from expression_bridge.protocol import Handler  # noqa: E402
from fake_cmds import FakeCmds  # noqa: E402


def make_scene():
    cmds = FakeCmds()
    cmds.add_expression("expr1", "pCube1.ty = time;", drives=["pCube1.translateY"])
    cmds.add_expression("expr2", "pCube1.rx = frame;", drives=["pCube1.rotateX", "pSphere1.rotateY"],
                        uc="none", ae=0)
    cmds.add_expression("globalExpr", "print 1;")
    cmds.add_particle("particleShape1", c="lifespanPP = 2;", rad="")
    return cmds


def run_inline(fn, *args, **kwargs):
    return dispatch.run_on_main(fn, *args, defer=lambda task: task(), **kwargs)


class ScannerTests(unittest.TestCase):
    def test_groups_by_driven_object(self):
        tree = scanner.scan(make_scene())
        self.assertEqual([e["id"] for e in tree["pCube1"]], ["expr1", "expr2"])
        self.assertEqual([e["id"] for e in tree["pSphere1"]], ["expr2"])
        self.assertEqual([e["id"] for e in tree[scanner.SCENE_GROUP]], ["globalExpr"])
        self.assertEqual([e["id"] for e in tree["particleShape1"]], ["particleShape1:creation"])


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.cmds = make_scene()

    def test_get_reads_settings(self):
        data = adapter.get(self.cmds, "expr2")
        self.assertEqual(data["settings"], {"unitConversion": "none", "alwaysEvaluate": False})

    def test_set_is_undoable_and_returns_new_hash(self):
        before = adapter.get(self.cmds, "expr1")
        after = adapter.set_(self.cmds, "expr1", text="pCube1.ty = 2;",
                             settings={"alwaysEvaluate": False}, expected_hash=before["hash"])
        self.assertEqual(after["text"], "pCube1.ty = 2;")
        self.assertFalse(after["settings"]["alwaysEvaluate"])
        self.assertNotEqual(before["hash"], after["hash"])
        self.assertEqual(self.cmds.undo_log, ["open", "close"])

    def test_stale_hash_is_rejected(self):
        with self.assertRaises(adapter.BridgeError) as ctx:
            adapter.set_(self.cmds, "expr1", text="x", expected_hash="stale")
        self.assertEqual(ctx.exception.code, adapter.CONFLICT)
        self.assertEqual(self.cmds.expressions["expr1"]["string"], "pCube1.ty = time;")

    def test_invalid_unit_conversion(self):
        with self.assertRaises(adapter.BridgeError):
            adapter.set_(self.cmds, "expr1", settings={"unitConversion": "bogus"})

    def test_particle_slot_round_trip(self):
        adapter.set_(self.cmds, "particleShape1:runtimeAfterDynamics", text="position += 1;")
        self.assertEqual(self.cmds.particles["particleShape1"]["rad"], "position += 1;")

    def test_syntax_error_is_reported_and_old_text_kept(self):
        result = adapter.set_(self.cmds, "expr1", text="a;\nSYNTAX", capture=self.cmds.capture)
        # Maya says "Line 1.4" (0-based); the echoed source and trailer are dropped.
        self.assertEqual(result["errors"], [{"line": 2, "message": "Syntax error"}])
        self.assertEqual(result["text"], "pCube1.ty = time;")
        self.assertEqual(self.cmds.undo_log, ["open", "close"])

    def test_runtime_error_gets_its_line(self):
        result = adapter.set_(self.cmds, "expr1", text="a;\nb;\nRUNTIME;", capture=self.cmds.capture)
        self.assertEqual(result["text"], "a;\nb;\nRUNTIME;")
        self.assertEqual(result["errors"], [{"line": 3, "message": "boom"}])

    def test_runtime_error_on_first_line_has_no_line_number(self):
        result = adapter.set_(self.cmds, "expr1", text="RUNTIME;", capture=self.cmds.capture)
        self.assertEqual(result["errors"], [{"line": None, "message": "boom"}])

    def test_clean_write_has_no_errors(self):
        self.assertEqual(adapter.set_(self.cmds, "expr1", text="ok;", capture=self.cmds.capture)["errors"], [])

    def test_expression_in_a_namespace_named_like_a_slot(self):
        self.cmds.add_expression("ns:creation", "x;", drives=["pCube1.tx"])
        self.assertEqual(adapter.get(self.cmds, "ns:creation")["kind"], "expression")

    def test_missing_expression(self):
        with self.assertRaises(adapter.BridgeError) as ctx:
            adapter.get(self.cmds, "nope")
        self.assertEqual(ctx.exception.code, adapter.NOT_FOUND)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.handler = Handler("secret", server.build_methods(make_scene(), run_inline))

    def call(self, method, params=None, token="secret"):
        return self.handler.handle(json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}, "token": token}))[0]

    def test_rejects_bad_token(self):
        self.assertEqual(self.call("list", token="wrong")["error"]["code"], -32001)

    def test_rejects_non_ascii_and_non_string_tokens(self):
        for token in ("t\u00f6ken", "\ud800", 5, None):
            self.assertEqual(self.call("list", token=token)["error"]["code"], -32001)

    def test_parse_error(self):
        self.assertEqual(self.handler.handle(b"{nope")[0]["error"]["code"], -32700)

    def test_deeply_nested_json_is_a_parse_error(self):
        self.assertEqual(self.handler.handle(b"[" * 200000)[0]["error"]["code"], -32700)

    def test_unknown_method(self):
        self.assertEqual(self.call("explode")["error"]["code"], -32601)

    def test_bad_params(self):
        self.assertEqual(self.call("get", {"wrong": 1})["error"]["code"], -32602)

    def test_params_cannot_reach_the_dispatcher(self):
        self.assertEqual(self.call("get", {"id": "expr1", "timeout": 0})["error"]["code"], -32602)

    def test_get(self):
        self.assertEqual(self.call("get", {"id": "expr1"})["result"]["text"], "pCube1.ty = time;")


class DispatchTests(unittest.TestCase):
    def test_timeout_is_a_builtin_timeout_with_a_message(self):
        with self.assertRaisesRegex(TimeoutError, "busy"):
            dispatch.run_on_main(lambda: None, timeout=0.01, defer=lambda task: None)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._old = os.environ.get("LOCALAPPDATA")
        os.environ["LOCALAPPDATA"] = self.tmp.name
        self.cmds = make_scene()
        self.port = server.start(cmds=self.cmds, on_main=run_inline, poll_interval=None)

    def tearDown(self):
        server.stop()
        if self._old is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = self._old
        self.tmp.cleanup()

    def session_path(self):
        return Path(self.tmp.name) / "ExpressionBridge" / "session.json"

    def connect_authorized(self):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.addCleanup(sock.close)
        session = json.loads(self.session_path().read_text())
        stream = sock.makefile("rwb")
        self.addCleanup(stream.close)
        request = {"jsonrpc": "2.0", "id": 1, "method": "ping", "token": session["token"]}
        stream.write((json.dumps(request) + "\n").encode())
        stream.flush()
        self.assertIn("result", json.loads(stream.readline()))
        return sock

    def test_stop_disconnects_clients(self):
        sock = self.connect_authorized()
        server.stop()
        self.assertEqual(sock.recv(1), b"")

    def test_stop_leaves_another_mayas_session_file(self):
        path = self.session_path()
        path.write_text(json.dumps({"token": "another Maya"}))
        server.stop()
        self.assertTrue(path.exists())

    def test_oversized_message_drops_the_connection(self):
        with mock.patch.object(server, "MAX_LINE_BYTES", 16):
            sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            self.addCleanup(sock.close)
            sock.sendall(b"x" * 64 + b"\n")
            self.assertEqual(sock.recv(1), b"")

    def test_client_that_stops_reading_cannot_block_a_push(self):
        with mock.patch.object(server, "MAX_QUEUED_MESSAGES", 2):
            sock = self.connect_authorized()
        blob = "x" * (1 << 20)
        pushes = threading.Thread(target=lambda: [
            server._server.server.broadcast("big", {"blob": blob}) for _ in range(64)], daemon=True)
        pushes.start()
        pushes.join(10)
        self.assertFalse(pushes.is_alive(), "broadcast blocked on a stalled client")
        while sock.recv(1 << 20):  # and the client was dropped: this reaches EOF
            pass

    def test_end_to_end_over_socket(self):
        session_path = self.session_path()
        session = json.loads(session_path.read_text())
        self.assertEqual(session["port"], self.port)

        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            stream = sock.makefile("rwb")
            for i, method in enumerate(["ping", "list"]):
                req = {"jsonrpc": "2.0", "id": i, "method": method, "token": session["token"]}
                stream.write((json.dumps(req) + "\n").encode())
                stream.flush()
                resp = json.loads(stream.readline())
                self.assertEqual(resp["id"], i)
                self.assertIn("result", resp)
            self.assertIn("pCube1", resp["result"])

        server.stop()
        self.assertFalse(session_path.exists())

    def test_pushes_maya_edits_but_not_own_writes(self):
        session = json.loads((Path(self.tmp.name) / "ExpressionBridge" / "session.json").read_text())
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            stream = sock.makefile("rwb")

            def call(method, **params):
                req = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
                       "token": session["token"]}
                stream.write((json.dumps(req) + "\n").encode())
                stream.flush()
                return json.loads(stream.readline())

            call("set", id="expr1", text="pCube1.ty = 9;")  # bridge write: no echo
            self.cmds.expressions["expr2"]["string"] = "edited in Maya;"
            server.watcher().poll()
            push = json.loads(stream.readline())
            self.assertEqual(push["method"], "expressionsChanged")
            self.assertEqual(list(push["params"]["changed"]), ["expr2"])

            self.cmds.selection = ["pCube1"]
            server.watcher().on_selection()
            push = json.loads(stream.readline())
            self.assertEqual(push, {"jsonrpc": "2.0", "method": "selectionChanged",
                                    "params": {"objects": ["pCube1"]}})


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.cmds = make_scene()
        self.sent = []
        self.watcher = sync.Watcher(self.cmds, lambda m, p: self.sent.append((m, p)))
        self.watcher.install()

    def test_first_poll_is_silent_and_no_change_is_silent(self):
        self.assertEqual(self.sent, [])
        self.assertIsNone(self.watcher.poll())

    def test_detects_text_change(self):
        self.cmds.expressions["expr1"]["string"] = "new;"
        msg = self.watcher.poll()
        self.assertEqual(list(msg["changed"]), ["expr1"])
        self.assertFalse(msg["treeChanged"])

    def test_detects_added_and_removed(self):
        self.cmds.add_expression("expr3", "x;", drives=["pCone1.tx"])
        del self.cmds.nodes["globalExpr"]
        msg = self.watcher.poll()
        self.assertTrue(msg["treeChanged"])
        self.assertIn("expr3", msg["changed"])
        self.assertEqual(msg["removed"], ["globalExpr"])

    def test_own_write_is_not_echoed(self):
        result = adapter.set_(self.cmds, "expr1", text="mine;")
        self.watcher.note_written("expr1", result["hash"])
        self.assertIsNone(self.watcher.poll())

    def test_selection_pushed_only_on_change(self):
        self.cmds.selection = ["pCube1"]
        self.watcher.on_selection()
        self.watcher.on_selection()
        self.assertEqual(self.sent, [("selectionChanged", {"objects": ["pCube1"]})])

    def test_uninstall_kills_jobs(self):
        self.assertEqual(len(self.cmds.jobs), 1 + len(sync.SCENE_EVENTS))
        self.watcher.uninstall()
        self.assertEqual(self.cmds.jobs, {})


if __name__ == "__main__":
    unittest.main()
