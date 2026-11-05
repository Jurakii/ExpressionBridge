"""Drag this file into a Maya viewport to install the Expression Bridge.

It copies the ExpressionBridge folder next to this file into Maya's modules
folder, writes ExpressionBridge.mod, and starts the bridge right away, so no
restart is needed. Maya loads it automatically from then on.
"""
import os
import shutil
import sys

NAME = "ExpressionBridge"


def _modules_dir(cmds):
    app_dir = os.environ.get("MAYA_APP_DIR") or cmds.internalVar(userAppDir=True)
    return os.path.join(app_dir, "modules")


def _version(package):
    init = os.path.join(package, "scripts", "expression_bridge", "__init__.py")
    with open(init, encoding="utf-8") as f:
        for line in f:
            if line.startswith("__version__"):
                return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("No __version__ in " + init)


def install(modules_dir=None, start=True):
    from maya import cmds

    source = os.path.join(os.path.dirname(os.path.abspath(__file__)), NAME)
    if not os.path.isdir(source):
        raise RuntimeError("Can't find {} next to this file. Unpack the whole release first.".format(NAME))
    modules_dir = modules_dir or _modules_dir(cmds)
    target = os.path.join(modules_dir, NAME)

    # Stop a running bridge from an older copy before replacing its files.
    old = sys.modules.get("expression_bridge.server")
    if old is not None:
        old.stop()

    os.makedirs(modules_dir, exist_ok=True)
    if os.path.isdir(target):
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    with open(os.path.join(modules_dir, NAME + ".mod"), "w", encoding="utf-8", newline="\r\n") as f:
        f.write("+ {} {} ./{}\nscripts: scripts\n".format(NAME, _version(source), NAME))

    if start:
        scripts = os.path.join(target, "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        for mod in [m for m in sys.modules if m == "expression_bridge" or m.startswith("expression_bridge.")]:
            del sys.modules[mod]  # load the newly copied code
        from expression_bridge import server, ui
        ui.install_menu()
        server.start()
    return target


def onMayaDroppedPythonFile(*_):
    from maya import cmds

    try:
        target = install()
    except Exception as exc:
        cmds.confirmDialog(title="Expression Bridge", message="Install failed:\n{}".format(exc), button=["OK"])
        raise
    cmds.confirmDialog(
        title="Expression Bridge",
        message="Installed to\n{}\n\nThe bridge is running. In VS Code, open the Expression Bridge view.".format(target),
        button=["OK"],
    )
