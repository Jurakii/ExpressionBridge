"""Minimal in-memory stand-in for `maya.cmds`, enough for the bridge's calls."""
import contextlib

from expression_bridge import errors


class FakeCmds:
    def __init__(self):
        self.nodes = {}       # name -> nodeType
        self.expressions = {}  # name -> {"string", "unitConversion", "alwaysEvaluate"}
        self.connections = {}  # name -> [destination plugs]
        self.particles = {}    # shape -> {"c": str, "rbd": str, "rad": str}
        self.undo_log = []
        self.selection = []
        self.jobs = {}
        self.collector = None

    # scene setup helpers
    def add_expression(self, name, text, drives=(), uc="all", ae=1):
        self.nodes[name] = "expression"
        self.expressions[name] = {"string": text, "unitConversion": uc, "alwaysEvaluate": ae}
        self.connections[name] = list(drives)
        for plug in drives:
            self.nodes.setdefault(plug.split(".")[0], "transform")

    def add_particle(self, shape, **slots):
        self.nodes[shape] = "particle"
        self.particles[shape] = {"c": "", "rbd": "", "rad": "", **slots}

    # maya.cmds surface
    def ls(self, type=None, selection=False):
        if selection:
            return list(self.selection)
        return [n for n, t in self.nodes.items() if t == type]

    def objExists(self, name):
        return name in self.nodes

    def nodeType(self, name):
        return self.nodes[name]

    def listConnections(self, node, source=True, destination=True, plugs=False, skipConversionNodes=False):
        return list(self.connections.get(node, [])) or None

    def expression(self, name, query=False, edit=False, **flags):
        expr = self.expressions[name]
        if query:
            (flag,) = flags
            return expr[flag]
        if edit:
            # Messages copied from Maya 2026 (line numbers are 0-based there).
            # A syntax error raises and leaves the old text in place.
            lines = flags.get("string", "").splitlines()
            for i, line in enumerate(lines):
                if "SYNTAX" in line:
                    raise RuntimeError(f"{line}\nLine {i}.4: Syntax error\nExpression invalid after edit.\n")
            expr.update(flags)
            # A runtime error doesn't raise: Maya prints it while evaluating the edit.
            for i, line in enumerate(lines):
                if "RUNTIME" in line:
                    self.print_error(f"line {i}: boom" if i else "boom")
                    self.print_error(f"An execution error occured in the expression {name}.")

    def print_error(self, message):
        if self.collector is not None:
            self.collector.add(message)

    @contextlib.contextmanager
    def capture(self, source=None):
        """Stand-in for errors.capture: routes print_error into a real Collector."""
        self.collector = errors.Collector(source)
        try:
            yield self.collector
        except RuntimeError as exc:
            self.collector.add(str(exc))
        finally:
            self.collector = None

    def dynExpression(self, shape, query=False, edit=False, string=None, **slot):
        (flag,) = slot
        if query:
            return self.particles[shape][flag]
        if edit:
            self.particles[shape][flag] = string

    def undoInfo(self, openChunk=False, closeChunk=False, chunkName=None):
        self.undo_log.append("open" if openChunk else "close")

    def select(self, obj, replace=True):
        self.selection = [obj]

    def about(self, version=False):
        return "2026"

    def scriptJob(self, event=None, exists=None, kill=None, force=False):
        if exists is not None:
            return exists in self.jobs
        if kill is not None:
            self.jobs.pop(kill, None)
            return None
        job = len(self.jobs) + 1
        self.jobs[job] = event
        return job
