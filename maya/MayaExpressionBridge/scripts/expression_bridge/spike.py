"""M0 spike: print every expression in the open scene with its plugs and flags.

Run in Maya's Script Editor:
    from expression_bridge import spike; spike.run()
"""
import json


def run():
    from maya import cmds
    from . import adapter, scanner

    tree = scanner.scan(cmds)
    for obj, items in tree.items():
        print(f"== {obj}")
        for item in items:
            print(json.dumps({**item, **adapter.get(cmds, item["id"])}, indent=2))
    return tree
