"""Run callables on Maya's main thread and wait for the result from another thread."""
from __future__ import annotations

import concurrent.futures


def _maya_defer(fn):
    import maya.utils
    maya.utils.executeDeferred(fn)


def run_on_main(fn, *args, timeout=30.0, defer=None, **kwargs):
    """Schedule `fn` on the main thread and block until it finishes."""
    future: concurrent.futures.Future = concurrent.futures.Future()

    def task():
        if not future.set_running_or_notify_cancel():
            return
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:  # re-raised in the waiting thread
            future.set_exception(exc)

    (defer or _maya_defer)(task)
    try:
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        future.cancel()
        # The builtin, which concurrent.futures.TimeoutError only became in Python 3.11.
        raise TimeoutError("Maya is busy and did not respond in time") from None
