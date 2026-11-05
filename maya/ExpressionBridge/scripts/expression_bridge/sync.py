"""Detect Maya-side changes and push them to clients.

The Expression Editor and attribute edits fire no reliable event, so the watcher
compares content hashes. It runs on scene events (via scriptJobs) and on a slow
timer. Writes made by the bridge itself are recorded with `note_written`, so
they are never echoed back to the client that made them.
"""
from __future__ import annotations

import logging
import threading

from . import adapter, scanner

log = logging.getLogger("expression_bridge")

SCENE_EVENTS = ("SceneOpened", "NewSceneOpened", "NameChanged", "Undo", "Redo")
POLL_SECONDS = 1.0


class Watcher:
    def __init__(self, cmds, broadcast):
        self._cmds = cmds
        self._broadcast = broadcast
        self._lock = threading.Lock()
        self._tree = None
        self._hashes: dict[str, str] = {}
        self._selection: list[str] = []
        self._jobs: list[int] = []

    # --- main-thread only -------------------------------------------------
    def snapshot(self):
        tree = scanner.scan(self._cmds)
        ids = {e["id"] for items in tree.values() for e in items}
        hashes = {i: adapter.get(self._cmds, i)["hash"] for i in sorted(ids)}
        return tree, hashes

    def poll(self):
        """Diff the scene against the last snapshot and broadcast what changed."""
        tree, hashes = self.snapshot()
        with self._lock:
            first = self._tree is None
            tree_changed = tree != self._tree
            changed = {i: h for i, h in hashes.items() if self._hashes.get(i) != h}
            removed = sorted(set(self._hashes) - set(hashes))
            self._tree, self._hashes = tree, hashes
        if first:
            return None
        if tree_changed or changed or removed:
            message = {"treeChanged": tree_changed, "changed": changed, "removed": removed}
            self._broadcast("expressionsChanged", message)
            return message
        return None

    def on_selection(self):
        selection = self._cmds.ls(selection=True) or []
        if selection != self._selection:
            self._selection = selection
            self._broadcast("selectionChanged", {"objects": selection})

    def install(self):
        """Register scriptJobs. Call once, on the main thread."""
        self.poll()
        jobs = [self._cmds.scriptJob(event=["SelectionChanged", self.on_selection])]
        jobs += [self._cmds.scriptJob(event=[event, self.poll]) for event in SCENE_EVENTS]
        # In batch mode (mayapy) scriptJob returns None; only the poller runs there.
        self._jobs = [job for job in jobs if job is not None]

    def uninstall(self):
        for job in self._jobs:
            if self._cmds.scriptJob(exists=job):
                self._cmds.scriptJob(kill=job, force=True)
        self._jobs.clear()

    # --- any thread -------------------------------------------------------
    def note_written(self, expr_id, new_hash):
        """Record a bridge write so the next poll does not push it back."""
        with self._lock:
            self._hashes[expr_id] = new_hash


class Poller:
    """Background timer that runs `Watcher.poll` on the main thread."""

    def __init__(self, watcher, on_main, interval=POLL_SECONDS):
        self._watcher = watcher
        self._on_main = on_main
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="ExpressionBridgePoll", daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(self._interval):
            try:
                self._on_main(self._watcher.poll)
            except Exception:
                log.exception("Expression poll failed")
