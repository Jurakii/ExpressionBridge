"""Integration tests against real Maya. Skipped unless run with mayapy:

    "C:/Program Files/Autodesk/Maya2026/bin/mayapy.exe" maya/tests/test_maya_integration.py -v
"""
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "MayaExpressionBridge" / "scripts"))

try:
    import maya.standalone
except ImportError:
    maya = None

cmds = None


def setUpModule():
    global cmds
    if maya is None:
        raise unittest.SkipTest("needs mayapy")
    maya.standalone.initialize(name="python")
    from maya import cmds as maya_cmds
    cmds = maya_cmds


def new_scene():
    cmds.file(new=True, force=True)
    cmds.undoInfo(state=True, infinity=True)
    cube = cmds.polyCube(name="pCube1")[0]
    cmds.polySphere(name="pSphere1")
    cmds.expression(name="expr1", string="pCube1.translateY = time;", object=cube)
    cmds.expression(name="expr2", string="pCube1.rotateX = frame;\npSphere1.rotateY = frame;")
    cmds.expression(name="globalExpr", string="float $unused = 1;")
    shape = cmds.particle(name="particle1")[1]
    cmds.dynExpression(shape, edit=True, string="lifespanPP = 2;", c=True)
    return shape


def inline(fn, *args, **kwargs):
    return fn(*args, **kwargs)


class RealMayaAdapterTests(unittest.TestCase):
    def setUp(self):
        from expression_bridge import adapter, scanner
        self.adapter, self.scanner = adapter, scanner
        self.shape = new_scene()

    def test_scanner_groups_real_scene(self):
        tree = self.scanner.scan(cmds)
        self.assertEqual([e["id"] for e in tree["pCube1"]], ["expr1", "expr2"])
        self.assertEqual([e["id"] for e in tree["pSphere1"]], ["expr2"])
        self.assertEqual([e["id"] for e in tree[self.scanner.SCENE_GROUP]], ["globalExpr"])
        self.assertEqual([e["id"] for e in tree[self.shape]], [f"{self.shape}:creation"])

    def test_settings_round_trip(self):
        result = self.adapter.set_(cmds, "expr1", settings={"unitConversion": "angularOnly", "alwaysEvaluate": False})
        self.assertEqual(result["settings"], {"unitConversion": "angularOnly", "alwaysEvaluate": False})
        self.assertEqual(result["errors"], [])
        self.assertEqual(cmds.expression("expr1", q=True, unitConversion=True), "angularOnly")

    def test_edit_is_one_undo_step(self):
        before = cmds.expression("expr1", q=True, string=True)
        self.adapter.set_(cmds, "expr1", text="pCube1.translateY = 2 * time;")
        cmds.undo()
        self.assertEqual(cmds.expression("expr1", q=True, string=True), before)

    def test_syntax_error_reports_correct_line_and_keeps_text(self):
        before = cmds.expression("expr1", q=True, string=True)
        result = self.adapter.set_(cmds, "expr1", text="float $a = 1;\nfloat $b = 2;\npCube1.ty = ;")
        self.assertEqual(result["errors"], [{"line": 3, "message": "Syntax error"}])
        self.assertEqual(result["text"], before)

    def test_runtime_error_reports_correct_line(self):
        result = self.adapter.set_(cmds, "expr1", text='float $a = 1;\nfloat $b = 2;\nerror "boom";')
        self.assertEqual(result["errors"], [{"line": 3, "message": "boom"}])

    def test_particle_slots(self):
        result = self.adapter.set_(cmds, f"{self.shape}:runtimeAfterDynamics", text="position = position;")
        self.assertEqual(result["errors"], [])
        # Maya stores particle expressions with the shape name prefixed to attributes.
        self.assertIn("position", result["text"])
        self.assertTrue(cmds.dynExpression(self.shape, q=True, string=True, rad=True))
        self.assertFalse(cmds.dynExpression(self.shape, q=True, string=True, rbd=True))

    def test_hash_is_stable_between_reads(self):
        self.assertEqual(self.adapter.get(cmds, "expr1")["hash"], self.adapter.get(cmds, "expr1")["hash"])


class RealMayaSyncTests(unittest.TestCase):
    def setUp(self):
        from expression_bridge import adapter, sync
        self.adapter = adapter
        new_scene()
        self.sent = []
        self.watcher = sync.Watcher(cmds, lambda m, p: self.sent.append((m, p)))
        self.watcher.install()

    def tearDown(self):
        self.watcher.uninstall()

    def test_detects_edit_made_in_maya(self):
        cmds.expression("expr2", e=True, string="pCube1.rotateX = 2 * frame;")
        self.assertEqual(list(self.watcher.poll()["changed"]), ["expr2"])

    def test_detects_new_expression(self):
        cmds.expression(name="expr3", string="pSphere1.tx = 1;")
        msg = self.watcher.poll()
        self.assertTrue(msg["treeChanged"])
        self.assertIn("expr3", msg["changed"])

    def test_own_write_not_echoed(self):
        result = self.adapter.set_(cmds, "expr1", text="pCube1.translateY = 3;")
        self.watcher.note_written("expr1", result["hash"])
        self.assertIsNone(self.watcher.poll())

    def test_selection(self):
        cmds.select("pSphere1")
        self.watcher.on_selection()
        self.assertEqual(self.sent[-1], ("selectionChanged", {"objects": ["pSphere1"]}))


class RealMayaServerTests(unittest.TestCase):
    def setUp(self):
        from expression_bridge import server
        self.server = server
        new_scene()
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("LOCALAPPDATA")
        os.environ["LOCALAPPDATA"] = self.tmp.name
        lock = threading.Lock()

        def on_main(fn, *args, **kwargs):  # serialize like Maya's main thread
            with lock:
                return fn(*args, **kwargs)

        self.port = server.start(cmds=cmds, on_main=on_main, poll_interval=None)

    def tearDown(self):
        self.server.stop()
        if self.old is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = self.old
        self.tmp.cleanup()

    def test_list_get_set_over_socket(self):
        session = json.loads((Path(self.tmp.name) / "MayaExpressionBridge" / "session.json").read_text())
        self.assertEqual(session["mayaVersion"], "2026")
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as sock:
            stream = sock.makefile("rwb")

            def call(method, **params):
                req = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params, "token": session["token"]}
                stream.write((json.dumps(req) + "\n").encode())
                stream.flush()
                return json.loads(stream.readline())

            self.assertIn("pCube1", call("list")["result"])
            got = call("get", id="expr1")["result"]
            result = call("set", id="expr1", text="pCube1.translateY = 5;", expectedHash=got["hash"])["result"]
            self.assertEqual(result["text"], "pCube1.translateY = 5;")
            stale = call("set", id="expr1", text="x", expectedHash=got["hash"])
            self.assertEqual(stale["error"]["code"], -32009)
            self.assertEqual(call("select", object="pSphere1")["result"], {"selected": "pSphere1"})
            self.assertEqual(cmds.ls(selection=True), ["pSphere1"])


class RealMayaSpikeTests(unittest.TestCase):
    def test_spike_runs(self):
        from expression_bridge import spike
        new_scene()
        self.assertIn("pCube1", spike.run())


if __name__ == "__main__":
    result = unittest.main(exit=False).result
    if cmds is not None:
        maya.standalone.uninitialize()
    # Skip Python's own exit teardown, which can crash after Maya has shut down.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if result.wasSuccessful() else 1)
