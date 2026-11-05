"""Newline-delimited JSON-RPC 2.0 framing and request handling (no Maya imports)."""
from __future__ import annotations

import hmac
import json

from . import PROTOCOL_VERSION
from .adapter import BridgeError

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
UNAUTHORIZED = -32001


def encode(message):
    return (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")


def notification(method, params):
    return {"jsonrpc": "2.0", "method": method, "params": params}


def error_response(req_id, code, message):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


class Handler:
    """Validates a request, checks the token and calls the matching method."""

    def __init__(self, token, methods, logger=None):
        self._token = token.encode("utf-8")
        self._methods = {"ping": lambda: {"protocol": PROTOCOL_VERSION}, **methods}
        self._log = logger

    def handle(self, line):
        """Return (response, authorized). Only authorized peers receive pushes."""
        try:
            request = json.loads(line)
        except (ValueError, RecursionError):  # ValueError includes UnicodeDecodeError
            return error_response(None, PARSE_ERROR, "Parse error"), False
        if not isinstance(request, dict):
            return error_response(None, INVALID_REQUEST, "Invalid request"), False

        req_id = request.get("id")
        if request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
            return error_response(req_id, INVALID_REQUEST, "Invalid request"), False
        # Compare bytes: compare_digest raises on non-ASCII str, and this input is untrusted.
        if not hmac.compare_digest(str(request.get("token", "")).encode("utf-8", "replace"), self._token):
            return error_response(req_id, UNAUTHORIZED, "Unauthorized"), False
        return self._dispatch(request, req_id), True

    def _dispatch(self, request, req_id):
        name = request["method"]
        method = self._methods.get(name)
        if method is None:
            return error_response(req_id, METHOD_NOT_FOUND, f"Unknown method: {name}")

        params = request.get("params") or {}
        if not isinstance(params, dict):
            return error_response(req_id, INVALID_PARAMS, "params must be an object")
        try:
            result = method(**params)
        except BridgeError as exc:
            return error_response(req_id, exc.code, str(exc))
        except TypeError as exc:
            return error_response(req_id, INVALID_PARAMS, f"Invalid params: {exc}")
        except Exception as exc:  # a handler bug must not drop the connection
            if self._log:
                self._log.exception("Bridge method %s failed", name)
            return error_response(req_id, INTERNAL_ERROR, str(exc))
        return {"jsonrpc": "2.0", "id": req_id, "result": result}
