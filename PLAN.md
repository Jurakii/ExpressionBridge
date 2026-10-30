# Maya ↔ VS Code Expression Bridge — Project Plan

## 1. Goal

Edit Maya expressions in VS Code instead of Maya's Expression Editor.

- **Outliner-style tree in VS Code:** every Maya object that has expressions is listed.
- **Select an object** in the tree → all of its expressions are shown and editable.
- **Per-expression settings** exposed in VS Code: Convert Units, Always Evaluate (Eval), and Particle slot (Creation / Runtime Before Dynamics / Runtime After Dynamics).
- **Save in VS Code** → the expression is updated live in Maya.
- Optional: selecting an object in Maya highlights it in the VS Code tree.

## 2. Architecture

```
┌──────────── Maya (Python) ────────────┐        ┌──────── VS Code (TypeScript) ────────┐
│ expression_bridge package             │        │ maya-expressions extension           │
│  - scanner: finds expression nodes    │ JSON   │  - TreeView: objects → expressions   │
│  - adapter: get/set expr + settings   │◄──────►│  - TextDocument provider (maya-expr:)│
│  - server: localhost TCP, JSON-RPC    │  TCP   │  - Settings panel (webview)          │
│  - scriptJobs: push changes to VS Code│ 127.0.0.1 │  - Diagnostics (Maya errors)      │
│  - runs on Maya main thread only      │ + token│  - Status bar: connected/disconnected│
└───────────────────────────────────────┘        └──────────────────────────────────────┘
```

### Why a localhost socket (and not just files)

- Live two-way updates (Maya selection → VS Code tree, Maya edits → VS Code refresh).
- Errors from Maya can come back as VS Code diagnostics on save.
- Files are kept only as a fallback (see §7).

### Discovery and security

- Maya writes `%LOCALAPPDATA%\MayaExpressionBridge\session.json` containing `{port, token, mayaVersion, pid}` on start.
- VS Code reads that file, connects to `127.0.0.1:<port>`, and sends the token with every request.
- Bind to `127.0.0.1` only. Never accept non-local connections.

## 3. Maya-side details

### 3.1 What counts as an "expression" in Maya

| Kind | Node type | Where it's stored | Notes |
|---|---|---|---|
| Standard expression | `expression` | `.expression` string on the node | Output connections show which attributes it drives |
| Particle expressions | `dynExpression` (per particle shape) | `.creationExpression`, `.runtimeBeforeDynamics`, `.runtimeAfterDynamics` (verify attr names in target version) | Three slots per particle shape |

Verify the exact attribute names and expression flags in the target Maya version before coding against them. Use `cmds.listAttr` on a test scene.

### 3.2 Scanner

- `cmds.ls(type="expression")` and `cmds.ls(type="dynExpression")`.
- For each node, find the driven plugs: `cmds.listConnections(node, destination=True, plugs=True)`.
- Map plug → owning object (`node.split(".")[0]`) to group by object.
- Object with no direct owner (e.g., a global expression) goes under a "Scene" group.

### 3.3 Adapter: settings to read and write

| VS Code setting | Maya source | Set via |
|---|---|---|
| Expression text | `expression -q -string` | `expression -e -string` |
| Language (MEL / Python) | `expression -q -language` | `expression -e -language` |
| Convert Units | `expression -q -unitConversion` (none / all / angular / linear / time) | `expression -e -unitConversion` |
| Always Evaluate (Eval) | `expression -q -alwaysEvaluate` | `expression -e -alwaysEvaluate` |
| Particle slot | `dynExpression` attribute name | `setAttr` / `cmds.dynExpression -e` |

Run every write inside `cmds.undoInfo(openChunk=True)` … `closeChunk()` so Ctrl+Z works in Maya.

### 3.4 Threading

- All `maya.cmds` calls must run on the main thread.
- The socket server runs in a background thread and queues requests; the main thread executes them via `maya.utils.executeDeferred` (or a `QTimer` in Maya's event loop) and returns the result through a `queue.Queue` / `concurrent.futures.Future`.

### 3.5 Live push from Maya

- `cmds.scriptJob(event=["NameChanged", ...])` and `SelectionChanged` to push updates.
- Hash each expression's text + settings. Push only changed entries.
- Ignore Maya-side changes that VS Code itself caused (echo suppression by request ID).

### 3.6 Error reporting

- Maya does not return expression syntax errors from `expression -e` directly.
- Approach: after a write, force one evaluation (`cmds.dgdirty(allPlugs=True)` or `cmds.currentTime(cmds.currentTime(q=True))`) inside a try block, and capture the error from the Script Editor history / `sys.stderr` redirect.
- Send captured errors back as diagnostics on the edited line when possible, otherwise on line 1.
- This is the riskiest part; see §8.

## 4. VS Code extension details

- **Language:** TypeScript, built with `yo code` (VS Code extension generator).
- **Tree view:** `contributes.views` in a "Maya Expressions" side panel. Children are expressions; parent is object. Refresh on push events from Maya.
- **Editing:** a `TextDocumentContentProvider` on the custom scheme `maya-expr:`, e.g. `maya-expr:/pCube1/expr1.mel`. Save hook (`onDidSaveTextDocument`) sends `setExpression` to Maya.
- **Language modes:** `mel` and `python`. Use an existing MEL grammar for highlighting, or ship a small TextMate grammar. Python uses built-in highlighting.
- **Settings panel:** a webview with dropdowns/checkboxes for Convert Units, Always Evaluate, and Particle slot. Changes call the same `setExpression` RPC.
- **Connection state:** status bar item. Auto-reconnect when Maya restarts (re-read `session.json`).
- **Commands:** `Maya: Connect`, `Maya: Refresh`, `Maya: Select object in Maya`, `Maya: Create expression on selected object` (optional, later).

## 5. Maya plugin packaging

- Folder layout:
  ```
  MayaExpressionBridge/
    MayaExpressionBridge.mod      # tells Maya where the package lives
    scripts/
      userSetup.py                # starts the server on Maya launch
      expression_bridge/
        __init__.py
        scanner.py
        adapter.py
        server.py
        dispatch.py               # main-thread queue
        ui.py                     # optional: Maya shelf button, status
  ```
- Install: copy the folder to `Documents/maya/modules/` (or any `MAYA_MODULE_PATH`). Maya finds it via the `.mod` file.
- Shelf button or menu item to start/stop the bridge and show connection status.
- Target: Maya 2026 first (Python 3.11 and PySide6; confirm the interpreter version in your install with `import sys; print(sys.version)`). Keep Qt imports behind `try: PySide6 except: PySide2` so older versions still load. Add 2024/2025 later only if needed.

## 6. Milestones

| # | Milestone | Done when | Est. |
|---|---|---|---|
| M0 | Spike: dump expression settings from a test scene | Script prints every expression, its target plug, and its flags; attribute names for particles confirmed | 1–2 days |
| M1 | Maya bridge server | VS Code (or a test client) can `list`, `get`, `set` expressions; writes are undoable; main-thread safe | 3–5 days |
| M2 | VS Code tree + editor | Tree shows objects → expressions; open one, edit, save → Maya updates | 4–6 days |
| M3 | Settings: Convert Units, Always Evaluate | Changing a dropdown updates Maya and survives save | 2–3 days |
| M4 | Particle expressions | All three particle slots readable/writable | 2–3 days |
| M5 | Live sync | Maya edits and selection sync to VS Code; no echo loops | 3–4 days |
| M6 | Errors + packaging | Syntax errors show as diagnostics; `.mod` install works; VSIX built | 3–5 days |

Total rough estimate: **3–5 weeks** for one developer with Maya and TypeScript experience.

## 7. Fallback: file-based sync (if the socket path stalls)

- Maya exports each expression to `<scene>_expressions/<object>/<node>.mel` (or `.py`) plus a `manifest.json` with settings.
- VS Code edits the files directly; a Maya-side file watcher (`QFileSystemWatcher` or a timer) reloads on change.
- Lower risk, no networking, but no live selection sync and weaker error reporting.

## 8. Risks and open questions

| Risk | Mitigation |
|---|---|
| Expression error capture is unreliable in Maya | Spike it early in M0; fall back to "saved, but Maya reports error in Script Editor" |
| Particle attribute names differ across Maya versions | Verify per version in M0; keep a mapping table |
| Maya blocks or crashes if commands run off the main thread | Enforce the dispatch queue; never call `cmds` from the socket thread |
| Echo loops (VS Code save → Maya change → push back → VS Code reload) | Request IDs and a "last written" hash |
| Expressions evaluated during playback are slow | Only write on save, never on keystroke |
| Scenes with thousands of expressions | Lazy-load children in the tree; cache by hash |

### Questions to answer before coding

1. Which Maya versions do you need? (Affects Python version and PySide.)
2. Do you mainly write **MEL** or **Python** expressions? (Affects language modes and highlighting.)
3. Is this for solo use or a studio tool? (Affects auth, packaging, and whether a shared server is needed.)
4. Do you want **live** two-way sync (socket) or is **file-based** (§7) acceptable to start?

## 9. Recommended first step

Do M0 now: a 50-line Maya script that lists every `expression` and `dynExpression` in a test scene, with its driven plugs and all flags. Once the output looks right, M1 (the server) is straightforward.
