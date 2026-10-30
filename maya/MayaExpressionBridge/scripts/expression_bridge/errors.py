"""Capture errors Maya reports while a command runs.

Verified against Maya 2026:

* Parse errors are raised by `expression -e` as a RuntimeError whose text is
  several lines: the offending source line (or "}" for line 0), then
  "Line <line>.<col>: <message>", then "Expression invalid after edit.".
  Maya keeps the previous expression text.
* Runtime errors don't raise. They are printed while the edited expression
  first evaluates, as "line <line>: <message>" (just "<message>" on line 0),
  followed by "An execution error occured in the expression <name>.".
* Maya's line numbers start at 0. Diagnostics here use 1-based lines.
"""
from __future__ import annotations

import contextlib
import re

# "Line 2.13: Syntax error" (parse) or "line 2: boom" (runtime). Both 0-based.
_LOCATION_RE = re.compile(r"^\s*line\s+(\d+)(?:\.\d+)?\s*:\s*(.*)$", re.IGNORECASE)
_PREFIX_RE = re.compile(r"^\s*(?://\s*)?#?\s*Error\s*:\s*", re.IGNORECASE)
_NOISE = re.compile(r"^(\}|Expression invalid after edit\.|An execution error occured in the expression .*)$")


def to_diagnostic(message):
    """Turn one Maya message line into {line, message}. `line` is 1-based or None."""
    text = _PREFIX_RE.sub("", message.strip()).rstrip("/ ").strip()
    match = _LOCATION_RE.match(text)
    if match:
        return {"line": int(match.group(1)) + 1, "message": match.group(2).strip()}
    return {"line": None, "message": text}


class Collector:
    def __init__(self, source=None):
        self.messages: list[str] = []
        self._source_lines = {line.strip() for line in (source or "").splitlines() if line.strip()}

    def add(self, message):
        message = message.strip()
        if message and message not in self.messages:
            self.messages.append(message)

    def diagnostics(self):
        """Useful diagnostics, without Maya's echo of the source and its trailer lines."""
        lines = [line.strip() for m in self.messages for line in m.splitlines() if line.strip()]
        useful = [l for l in lines if not _NOISE.match(l) and l not in self._source_lines]
        if not useful and lines:
            # Only noise: still say something went wrong.
            useful = [lines[-1]]
        result = []
        for line in useful:
            diagnostic = to_diagnostic(line)
            if diagnostic not in result:
                result.append(diagnostic)
        return result


@contextlib.contextmanager
def capture(source=None):
    """Collect Maya error output for the duration of the block.

    A RuntimeError raised inside the block is recorded and swallowed, because
    Maya's own message for it is the useful part. `source` is the text being
    applied, so Maya's echo of it can be dropped.
    """
    collector = Collector(source)
    callback_id = _add_output_callback(collector)
    try:
        yield collector
    except RuntimeError as exc:
        collector.add(str(exc))
    finally:
        if callback_id is not None:
            _remove_output_callback(callback_id)


def _add_output_callback(collector):
    try:
        import maya.api.OpenMaya as om
    except ImportError:  # outside Maya (tests)
        return None

    def on_output(message, message_type, *_):
        if message_type == om.MCommandMessage.kError:
            collector.add(message)

    return om.MCommandMessage.addCommandOutputCallback(on_output)


def _remove_output_callback(callback_id):
    import maya.api.OpenMaya as om
    om.MMessage.removeCallback(callback_id)
