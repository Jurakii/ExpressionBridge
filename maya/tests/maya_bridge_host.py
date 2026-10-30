"""Run the bridge in mayapy with a real main-thread queue, for end-to-end tests.

Socket and poll threads hand work to the main thread through a queue, as
`maya.utils.executeDeferred` does in the Maya UI. Usage:

    mayapy maya/tests/maya_bridge_host.py <seconds>

Prints READY when session.json is written. After 3 s it edits expr2 in "Maya"
so the client can observe a push.
"""
import os
import queue
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "MayaExpressionBridge" / "scripts"))

import maya.standalone  # noqa: E402

maya.standalone.initialize(name="python")
from maya import cmds  # noqa: E402

from expression_bridge import dispatch, server  # noqa: E402

work = queue.Queue()


def on_main(fn, *args, **kwargs):
    return dispatch.run_on_main(fn, *args, defer=work.put, **kwargs)


def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 15
    cmds.polyCube(name="pCube1")
    cmds.expression(name="expr1", string="pCube1.translateY = time;", object="pCube1")
    cmds.expression(name="expr2", string="pCube1.rotateX = frame;")

    server.start(cmds=cmds, on_main=on_main, poll_interval=0.25)
    print("READY", flush=True)
    deadline = time.time() + duration
    edited = False
    while time.time() < deadline:
        if not edited and time.time() > deadline - duration + 3:
            cmds.expression("expr2", e=True, string="pCube1.rotateX = 2 * frame;")
            print("EDITED expr2 in Maya", flush=True)
            edited = True
        try:
            work.get(timeout=0.05)()
        except queue.Empty:
            pass
    server.stop()
    maya.standalone.uninitialize()
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
