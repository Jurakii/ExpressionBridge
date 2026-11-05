"""Maya menu: Expression Bridge > Start / Stop / Status."""
from maya import cmds

from . import server

MENU = "expressionBridgeMenu"


def _status(*_):
    w = server.watcher()
    message = "Expression Bridge is running." if w else "Expression Bridge is stopped."
    cmds.inViewMessage(amg=message, pos="topCenter", fade=True)


def _start(*_):
    server.start()
    _status()


def _stop(*_):
    server.stop()
    _status()


def install_menu():
    if cmds.about(batch=True):
        return
    if cmds.menu(MENU, exists=True):
        cmds.deleteUI(MENU)
    cmds.menu(MENU, label="Expression Bridge", parent="MayaWindow", tearOff=False)
    cmds.menuItem(label="Start", command=_start)
    cmds.menuItem(label="Stop", command=_stop)
    cmds.menuItem(divider=True)
    cmds.menuItem(label="Status", command=_status)
