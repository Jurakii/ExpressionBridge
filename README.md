# Maya ↔ VS Code Expression Bridge

Edit Maya expressions in VS Code. Saving updates Maya, edits in Maya appear in VS Code, and Maya's errors show
in the Problems panel.

**End users:** see [INSTALL.md](INSTALL.md), which ships in the release zip. Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

## Release
```
python tools/build_release.py      # -> dist/ExpressionBridge-<version>.zip (+ .sha256)
```
The script refuses to build if `expression_bridge/__init__.py` and `vscode/package.json` have different
versions. Bump both together. The zip contains `Install.bat` / `Uninstall.bat` (they wrap `installer/install.ps1`),
`maya/drag_and_drop_install.py`, the Maya module, the VSIX and INSTALL.md. Installing copies everything into place,
so the unzipped folder can be deleted afterwards.

To publish, add the version to CHANGELOG.md and push a tag `v<version>`.
[release.yml](.github/workflows/release.yml) runs the tests, builds the zip and creates the GitHub release.

## Layout
- `installer/`: `install.ps1` (install, upgrade, `-Uninstall`) and the `.bat` wrappers copied into the release.
- `tools/build_release.py`: builds the release zip.
- `maya/install.py`: developer install. Writes a `.mod` that points at this checkout (or `--copy`).
- `maya/drag_and_drop_install.py`: drop into a Maya viewport to install and start without a restart.
- `maya/ExpressionBridge/`: Maya module (`scripts/expression_bridge`, `userSetup.py`)
  - `scanner.py` finds expressions, `adapter.py` gets/sets them (undoable, hash-checked),
    `protocol.py` handles JSON-RPC (no Maya imports), `dispatch.py` runs work on the main thread,
    `server.py` is the 127.0.0.1 TCP server and writes `session.json`, `sync.py` pushes changes,
    `errors.py` captures Maya errors, `ui.py` adds the Expression Bridge menu.
- `maya/tests/`: unit and socket tests against an in-memory fake `cmds`, plus `test_maya_integration.py`
  (real Maya via mayapy), `maya_bridge_host.py` (runs the bridge in mayapy for end-to-end checks) and
  `demo_scene.py` (a small scene for trying the bridge by hand).
- `vscode/`: the extension (tree view, `expr-bridge:` file system, status bar, auto-reconnect).
- `vscode/src/test/`: extension unit tests (Node's built-in runner, no VS Code needed).
- `vscode/src/integration/`: tests that run inside a real VS Code (`@vscode/test-electron`).

## Run
```
python -m unittest discover -s maya/tests          # Maya-side unit tests (no Maya needed)
"C:/Program Files/Autodesk/Maya2026/bin/mayapy.exe" maya/tests/test_maya_integration.py -v   # real Maya
cd vscode && npm test                              # extension unit tests (no VS Code needed)
cd vscode && npm run test:integration              # inside real VS Code (uses the installed one)
python maya/install.py [--copy | --uninstall]     # developer install of the Maya module, then restart Maya
cd vscode && npm install && npm run package        # builds expression-bridge-<version>.vsix
code --install-extension vscode/expression-bridge-<version>.vsix
```
The unit tests and the extension's type check run on every push ([ci.yml](.github/workflows/ci.yml)). The real-Maya
and real-VS Code suites need those applications, so run them by hand before a release.

`python maya/install.py` (link mode) and the release installer write the same `.mod` file. The last one run wins:
run `install.py` again to go back to editing this checkout live.
Maya only reads `.mod` files at the top level of a modules folder, so copying the package folder
into `modules/` on its own does nothing. `install.py` writes the `.mod` file
(it honors `MAYA_APP_DIR`). By default the `.mod` points at this checkout. `--copy` makes a standalone copy.
`userSetup.py` adds an **Expression Bridge** menu (Start / Stop / Status) and starts the bridge.
It skips batch sessions (mayapy, render farm).

## Architecture
Maya runs a TCP server on `127.0.0.1` and writes `{port, token, pid, mayaVersion, protocol}` to
`%LOCALAPPDATA%\ExpressionBridge\session.json`. VS Code reads that file, connects, and sends the token with every
request. Socket I/O runs on worker threads and every `cmds` call is marshalled onto Maya's main thread. Outgoing
messages go through a bounded per-client queue, so a client that stops reading is dropped instead of blocking Maya.

Editing uses a `FileSystemProvider` on the `expr-bridge:` scheme. Maya expressions are MEL only, so the language is
always `mel`. Particle expressions are read with the `dynExpression` command on particle shapes, not a node type.

## Protocol
One JSON-RPC 2.0 object per line. Every request carries `token` from session.json.
Methods: `ping`, `list`, `get {id}`, `set {id, text?, settings?, expectedHash?}`, `select {object}`.
Error codes: -32001 unauthorized, -32004 not found, -32009 conflict (changed in Maya).

Maya pushes notifications (no `id`) to every client that has sent a valid token:
- `expressionsChanged {treeChanged, changed: {id: hash}, removed: [id]}`
- `selectionChanged {objects}`

## Live sync
`sync.py` hashes every expression and compares against the last snapshot. It runs on
scriptJobs (`SceneOpened`, `NewSceneOpened`, `NameChanged`, `Undo`, `Redo`) and on a 1 s timer,
because editing in the Expression Editor fires no event. Selection uses the `SelectionChanged` scriptJob.
Echo suppression: a write from VS Code records its new hash, so the next poll does not push it back.
In VS Code, clean editors reload. A dirty editor keeps its old hash, so its next save is refused
instead of overwriting Maya's edit. The tree highlights Maya's selection
(setting `expressionBridge.followMayaSelection`).

## Errors
`set` returns `errors: [{line, message}]`. While the write runs, `errors.py` listens to Maya's
command output (`MCommandMessage` errors) and records any RuntimeError. Maya evaluates the
expression during the edit, so runtime errors arrive the same way and no extra evaluation is
needed. Maya's line numbers start at 0 (`Line 2.13: Syntax error` means the third line). The bridge
converts them to 1-based and drops Maya's echo of the source and its trailer lines. VS Code shows the
result in Problems (source "Maya"), or on line 1 when Maya gives no line. On a syntax error Maya keeps the old text.
The save still succeeds in VS Code, but the stored hash is the one Maya actually holds.

## Settings panel
A **Settings** webview sits under the tree ([settingsView.ts](vscode/src/settingsView.ts)). It follows the
expression selected in the tree or open in the editor. It shows Convert Units, Always Evaluate,
and the plugs the expression drives. For particle expressions it shows the slot, read-only. A change
writes to Maya at once and the panel reloads when Maya pushes a change. The webview has a strict CSP
(nonce scripts, no remote content) and renders data with `textContent` only. The extension
validates every message before sending it to Maya. The right-click commands still work.

## MEL highlighting
[mel.tmLanguage.json](vscode/syntaxes/mel.tmLanguage.json) is a TextMate grammar written for this project.
It highlights comments, strings with escapes, `$variables`, keywords and types, `proc` declarations, command flags
(`-query`, but not subtraction), vectors `<<…>>`, backtick command substitution, function calls,
and the expression builtins `time`/`frame`. It also highlights attribute access such as
`|grp|ns:obj.pnts[0].x`, with the node and attribute colored differently.
[language-configuration.json](vscode/language-configuration.json) adds comment toggling, bracket matching,
auto-closing and indentation.

## Test coverage
- **Maya side (43 unit + 12 in real Maya):** the scanner, adapter, protocol, socket server, sync, error
  parsing and install script. The fake `cmds` reproduces error text captured from Maya 2026. The real-Maya suite
  builds scenes with mayapy and checks scanning, settings, undo, syntax and runtime error lines, particle slots,
  sync and the socket server.
- **Extension (56 unit + 9 in real VS Code):** the grammar is tokenized with `vscode-textmate` + Oniguruma (VS Code's
  own engine). The client runs against a real TCP fake bridge (split packets, push notifications, error codes, timeout,
  disconnect, reconnect). Also covered: the file system (hash-checked saves, conflicts, diagnostics, remote reload and
  delete), the tree (stable nodes, unique ids), and the settings panel (CSP, message validation, failed writes,
  out-of-order loads). `require("vscode")` goes to a small stub (`src/test/setup.ts`). Tests are left out of the VSIX.
  The real VS Code run uses a fake bridge, a throwaway profile and no other extensions. It checks activation, connecting,
  opening as MEL, saving, diagnostics, reloading on a Maya push, refusing a conflicting save, and the commands.
- **Not covered by automation:** the settings panel's in-page script (its host side is unit-tested), and the Maya *UI*:
  scriptJobs, `executeDeferred`, the menu and `userSetup.py` only run in an interactive Maya, not mayapy.

**For 1.0.0**, all of the suites above pass, with the real-Maya suite run on Maya 2024 and 2025. The earlier
0.x code was run on Maya 2026 with VS Code 1.143 (2026-10-29), including by hand in the interactive UI with
`maya/tests/demo_scene.py`: the menu, tree, editor, settings panel, a Maya edit reloading the open editor within about
a second, and Maya's selection following into the tree. Those Maya 2026 and interactive checks have not been repeated
on 1.0.0.

## Maya behavior worth knowing
- Expressions that drive rotations connect through hidden `unitConversion` nodes, so the scanner
  uses `skipConversionNodes=True`.
- `dgeval` after an edit only repeats errors Maya has already printed, so the bridge doesn't call it.
- `scriptJob` returns `None` in batch mode, so `Watcher` ignores it.
- `unitConversion` values other than `all`/`none`/`angularOnly` are silently stored as `all`. The bridge rejects them.
- Maya rewrites particle expression text to prefix attributes with the shape
  (`lifespanPP` becomes `particle1Shape.lifespanPP`). After saving, the editor reloads with Maya's version.
- `stat()` in the file system must return an `mtime` that changes only when Maya's content does, so VS Code's own
  "file changed on disk" check works.

## Known limits
- Each running Maya overwrites `session.json`, so with **two Mayas open, VS Code connects to whichever started
  (or ran Expression Bridge > Start) last**. To switch, use Expression Bridge > Stop then Start in the one you want.
- The poll hashes every expression each second, which is fine for hundreds. It hasn't been profiled on large scenes.

## Possible next steps
- Several Mayas at once (one session file per Maya, plus a picker in VS Code).
- A "connected" indicator inside Maya (viewport HUD, menu label).
- Installing into a running Maya from VS Code, with no restart.
