"""Start the expression bridge once Maya's UI is idle."""
import maya.utils


def _start():
    from maya import cmds
    from expression_bridge import server, ui

    if cmds.about(batch=True):
        return  # no bridge for mayapy / render farm sessions
    ui.install_menu()
    server.start()


maya.utils.executeDeferred(_start)
