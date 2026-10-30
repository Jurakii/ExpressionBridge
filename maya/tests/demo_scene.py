"""Build a small scene for trying the bridge by hand.

In Maya's Script Editor (Python tab):
    exec(open(r"<project>/maya/tests/demo_scene.py").read())
"""
from maya import cmds

cmds.file(new=True, force=True)
cube = cmds.polyCube(name="pCube1")[0]
sphere = cmds.polySphere(name="pSphere1")[0]
cmds.move(3, 0, 0, sphere)
cmds.expression(name="bounce", object=cube,
                string="pCube1.translateY = abs(sin(time * 3)) * 2;")
cmds.expression(name="spin",
                string="pCube1.rotateY = frame * 4;\npSphere1.rotateX = frame * 2;")
cmds.playbackOptions(minTime=1, maxTime=120)
print("Demo scene ready: bounce, spin")
