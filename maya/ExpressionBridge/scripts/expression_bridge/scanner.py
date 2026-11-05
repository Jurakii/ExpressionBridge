"""Find expressions in the scene and group them by the object they drive."""
from __future__ import annotations

SCENE_GROUP = "<Scene>"

# Particle runtime slots, mapped to the short flag names of `cmds.dynExpression`.
PARTICLE_SLOTS = {
    "creation": "c",
    "runtimeBeforeDynamics": "rbd",
    "runtimeAfterDynamics": "rad",
}


def _driven(cmds, node):
    # Angular outputs go through hidden unitConversion nodes; look through them.
    plugs = cmds.listConnections(node, source=False, destination=True, plugs=True,
                                 skipConversionNodes=True) or []
    plugs = sorted({p for p in plugs if not p.startswith(node + ".")})
    owners = sorted({p.split(".", 1)[0] for p in plugs})
    return owners, plugs


def particle_text(cmds, shape, slot):
    flag = PARTICLE_SLOTS[slot]
    return cmds.dynExpression(shape, query=True, string=True, **{flag: True}) or ""


def scan(cmds):
    """Return {object: [expression summary, ...]} for every expression in the scene."""
    groups: dict[str, list[dict]] = {}

    for node in cmds.ls(type="expression") or []:
        owners, plugs = _driven(cmds, node)
        entry = {"id": node, "kind": "expression", "drives": plugs}
        for owner in owners or [SCENE_GROUP]:
            groups.setdefault(owner, []).append(entry)

    shapes = (cmds.ls(type="particle") or []) + (cmds.ls(type="nParticle") or [])
    for shape in sorted(set(shapes)):
        for slot in PARTICLE_SLOTS:
            if particle_text(cmds, shape, slot).strip():
                groups.setdefault(shape, []).append(
                    {"id": f"{shape}:{slot}", "kind": "particle", "slot": slot, "drives": []}
                )

    return {obj: sorted(items, key=lambda e: e["id"]) for obj, items in sorted(groups.items())}
