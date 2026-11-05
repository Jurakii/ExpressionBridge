"""Read and write a single expression and its settings.

Expression ids are either an `expression` node name, or `<particleShape>:<slot>`
for particle runtime expressions.
"""
from __future__ import annotations

import contextlib
import hashlib
import json

from . import errors
from .scanner import PARTICLE_SLOTS, particle_text

UNIT_CONVERSIONS = ("all", "none", "angularOnly")

NOT_FOUND = -32004
CONFLICT = -32009
INVALID_PARAMS = -32602


class BridgeError(Exception):
    """An error whose message is safe to send back to the client."""

    def __init__(self, message, code=-32000):
        super().__init__(message)
        self.code = code


def content_hash(data):
    payload = json.dumps({"text": data["text"], "settings": data["settings"]}, sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


@contextlib.contextmanager
def undo_chunk(cmds, name):
    cmds.undoInfo(openChunk=True, chunkName=name)
    try:
        yield
    finally:
        cmds.undoInfo(closeChunk=True)


def _split_particle(expr_id):
    shape, _, slot = expr_id.rpartition(":")
    return (shape, slot) if shape and slot in PARTICLE_SLOTS else None


def get(cmds, expr_id):
    particle = _split_particle(expr_id)
    if particle:
        shape, slot = particle
        if not cmds.objExists(shape):
            raise BridgeError(f"No such particle shape: {shape}", NOT_FOUND)
        data = {"id": expr_id, "kind": "particle", "language": "mel",
                "text": particle_text(cmds, shape, slot), "settings": {"slot": slot}}
    else:
        if not cmds.objExists(expr_id) or cmds.nodeType(expr_id) != "expression":
            raise BridgeError(f"No such expression: {expr_id}", NOT_FOUND)
        data = {
            "id": expr_id,
            "kind": "expression",
            "language": "mel",  # Maya expressions are MEL-only.
            "text": cmds.expression(expr_id, query=True, string=True) or "",
            "settings": {
                "unitConversion": cmds.expression(expr_id, query=True, unitConversion=True),
                "alwaysEvaluate": bool(cmds.expression(expr_id, query=True, alwaysEvaluate=True)),
            },
        }
    data["hash"] = content_hash(data)
    return data


def _validate_settings(settings):
    if "unitConversion" in settings and settings["unitConversion"] not in UNIT_CONVERSIONS:
        raise BridgeError(f"Invalid unitConversion: {settings['unitConversion']}", INVALID_PARAMS)
    unknown = set(settings) - {"unitConversion", "alwaysEvaluate"}
    if unknown:
        raise BridgeError(f"Unknown settings: {sorted(unknown)}", INVALID_PARAMS)


def set_(cmds, expr_id, text=None, settings=None, expected_hash=None, capture=errors.capture):
    """Update text and/or settings. Rejects stale writes when `expected_hash` is given.

    The result is the expression as Maya now has it, plus `errors`: diagnostics
    Maya reported while applying the write. With errors, Maya may have kept the
    old text, so the returned `text`/`hash` are what the client should trust.
    """
    settings = settings or {}
    current = get(cmds, expr_id)
    if expected_hash and expected_hash != current["hash"]:
        raise BridgeError("Expression changed in Maya since it was opened", CONFLICT)

    if current["kind"] == "particle":
        if settings:
            raise BridgeError("Particle expressions have no editable settings", INVALID_PARAMS)
        diagnostics = []
        if text is not None:
            shape, slot = _split_particle(expr_id)
            with undo_chunk(cmds, f"VS Code: edit {expr_id}"), capture(text) as collected:
                cmds.dynExpression(shape, edit=True, string=text, **{PARTICLE_SLOTS[slot]: True})
            diagnostics = collected.diagnostics()
        return {**get(cmds, expr_id), "errors": diagnostics}

    _validate_settings(settings)
    kwargs = {}
    if text is not None:
        kwargs["string"] = text
    if "unitConversion" in settings:
        kwargs["unitConversion"] = settings["unitConversion"]
    if "alwaysEvaluate" in settings:
        kwargs["alwaysEvaluate"] = int(bool(settings["alwaysEvaluate"]))
    diagnostics = []
    if kwargs:
        # Maya parses and evaluates the expression during the edit, so both parse
        # and runtime errors surface here (see errors.py).
        with undo_chunk(cmds, f"VS Code: edit {expr_id}"), capture(text) as collected:
            cmds.expression(expr_id, edit=True, **kwargs)
        diagnostics = collected.diagnostics()
    return {**get(cmds, expr_id), "errors": diagnostics}


def select(cmds, obj):
    if not cmds.objExists(obj):
        raise BridgeError(f"No such object: {obj}", NOT_FOUND)
    cmds.select(obj, replace=True)
    return {"selected": obj}
