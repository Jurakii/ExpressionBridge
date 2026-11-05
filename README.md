# Maya ↔ VS Code Expression Bridge (prototype)

Implements PLAN.md milestones M0–M6. See PLAN.md for the design.
**End users:** see [INSTALL.md](INSTALL.md), which ships in the release zip.

## Release
```
python tools/build_release.py      # -> dist/ExpressionBridge-<version>.zip (+ .sha256)
```
The script refuses to build if `expression_bridge/__init__.py` and `vscode/package.json` have different
versions. Bump both together. The zip contains `Install.bat` / `Uninstall.bat` (they wrap `installer/install.ps1`),
`maya/drag_and_drop_install.py`, the Maya module, the VSIX and INSTALL.md. Installing copies everything into place,
so the unzipped folder can be deleted afterwards.

## Layout
- `installer/`: `install.ps1` (install, upgrade, `-Uninstall`) and the `.bat` wrappers copied into the release.
- `tools/build_release.py`: builds the release zip.
- `maya/install.py`: developer install. Writes a `.mod` that points at this checkout (or `--copy`).
- `maya/drag_and_drop_install.py`: drop into a Maya viewport to install and start without a restart.
- `maya/ExpressionBridge/`: Maya module (`scripts/expression_bridge`, `userSetup.py`)
  - `scanner.py` finds expressions, `adapter.py` gets/sets them (undoable, hash-checked),
    `protocol.py` handles JSON-RPC (no Maya imports), `dispatch.py` runs work on the main thread,
    `server.py` is the 127.0.0.1 TCP server and writes `session.json`, `sync.py` pushes changes,
    `errors.py` captures Maya errors, `ui.py` adds the Expression Bridge menu, `spike.py` is M0.
- `maya/tests/`: unit and socket tests against an in-memory fake `cmds`, plus `test_maya_integration.py`
  (real Maya via mayapy) and `maya_bridge_host.py` (runs the bridge in mayapy for end-to-end checks).
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
`python maya/install.py` (link mode) and the release installer write the same `.mod` file. The last one run wins:
run `install.py` again to go back to editing this checkout live.
Maya only reads `.mod` files at the top level of a modules folder, so copying the package folder
into `modules/` on its own does nothing. `install.py` writes the `.mod` file
(it honors `MAYA_APP_DIR`). By default the `.mod` points at this checkout. `--copy` makes a standalone copy.
`userSetup.py` adds an **Expression Bridge** menu (Start / Stop / Status) and starts the bridge.
It skips batch sessions (mayapy, render farm). In a scene, run `from expression_bridge import spike; spike.run()` for M0.

## Protocol
One JSON-RPC 2.0 object per line. Every request carries `token` from session.json.
Methods: `ping`, `list`, `get {id}`, `set {id, text?, settings?, expectedHash?}`, `select {object}`.
Error codes: -32001 unauthorized, -32004 not found, -32009 conflict (changed in Maya).

Maya pushes notifications (no `id`) to every client that has sent a valid token:
- `expressionsChanged {treeChanged, changed: {id: hash}, removed: [id]}`
- `selectionChanged {objects}`

## Live sync (M5)
`sync.py` hashes every expression and compares against the last snapshot. It runs on
scriptJobs (`SceneOpened`, `NewSceneOpened`, `NameChanged`, `Undo`, `Redo`) and on a 1 s timer,
because editing in the Expression Editor fires no event. Selection uses the `SelectionChanged` scriptJob.
Echo suppression: a write from VS Code records its new hash, so the next poll does not push it back.
In VS Code, clean editors reload. A dirty editor keeps its old hash, so its next save fails as a
conflict instead of overwriting Maya's edit. The tree highlights Maya's selection
(setting `expressionBridge.followMayaSelection`).

## Errors (M6)
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

## Verified against Maya 2026 and VS Code 1.143 (2026-10-29)
- **Maya side (34 unit + 13 in real Maya):** the scanner, adapter, protocol, socket server, sync, error
  parsing and install script. The fake `cmds` reproduces error text captured from Maya 2026. The real-Maya suite
  builds scenes with mayapy and checks scanning, settings, undo, syntax and runtime error lines, particle slots,
  sync and the socket server.
- **End to end:** the compiled TypeScript client was run against `maya_bridge_host.py` (real `cmds`, main-thread
  queue): list, hash-checked save, syntax error on the right line, settings, and a pushed Maya-side edit with no echo.
- **Install:** with `MAYA_MODULE_PATH` set to a temp folder, Maya loads the module from `install.py` in both
  link and `--copy` mode.
- **Extension (40 unit + 9 in real VS Code):** the grammar is tokenized with `vscode-textmate` + Oniguruma (VS Code's own engine).
  The client runs against a real TCP fake bridge (split packets, push
  notifications, error codes, timeout, disconnect). Also covered: the file system (hash-checked
  saves, conflicts, diagnostics, remote reload and delete), the tree (stable nodes, unique ids), and the
  settings panel (CSP, message validation, failed writes, out-of-order loads). `require("vscode")`
  goes to a small stub (`src/test/setup.ts`). Tests are left out of the VSIX.
  The real VS Code run uses a fake bridge, a throwaway profile and no other extensions. It checks activation, connecting,
  opening as MEL, saving, diagnostics, reloading on a Maya push, refusing a conflicting save, and the commands.
- **Not covered:** the settings panel's in-page script (its host side is unit-tested), and the Maya *UI*:
  scriptJobs, `executeDeferred`, the menu and `userSetup.py` only run in an interactive Maya, not mayapy.

### What real Maya showed (and the fixes)
- Expressions that drive rotations connect through hidden `unitConversion` nodes, so the scanner now
  uses `skipConversionNodes=True`. Without it, `expr` driving `pCube1.rotateX` was listed under `unitConversion1`.
- Error lines are 0-based. Errors were shown one line too high until this was fixed.
- `dgeval` after an edit only repeated errors Maya had already printed, so it was removed.
- `scriptJob` returns `None` in batch mode, so `Watcher` now ignores it.
- `unitConversion` values other than `all`/`none`/`angularOnly` are silently stored as `all`. The bridge rejects them.
- Maya rewrites particle expression text to prefix attributes with the shape
  (`lifespanPP` becomes `particle1Shape.lifespanPP`). After saving, the editor reloads with Maya's version.
- Fixed on the VS Code side: `stat()` returned a fresh `mtime` on every call. It now changes only when Maya's content
  does, so VS Code's own "file changed on disk" check works.

## Changes from the plan
- Editing uses a `FileSystemProvider`, not a `TextDocumentContentProvider`, because the latter is read-only.
- Maya expressions are MEL only, so there is no `-language` flag. Language is always `mel`.
- Particle expressions are read with the `dynExpression` command on particle shapes, not a node type.

## Checked by hand in interactive Maya 2026 + VS Code (2026-10-29)
Using `maya/tests/demo_scene.py`:
- The Expression Bridge menu appears, and Start / Stop / Status work.
- The tree and editor open, with MEL highlighting. The settings panel renders, and its changes reach Maya.
- An edit made in Maya reloads the open editor within about a second, and selecting an object in Maya selects it in the tree.

Known limit: each running Maya overwrites `session.json`, so with **two Mayas open, VS Code connects to whichever
started (or ran Expression Bridge > Start) last**. To switch, use Expression Bridge > Stop then Start in the one you want.

## Not done yet
- Support several Mayas at once (one session file per Maya, plus a picker in VS Code).
- A try in interactive Maya: menu, scriptJobs, live selection highlight, and the 1 s poll during playback.
- Profile the poll on large scenes. It hashes every expression, which is fine for hundreds.
- A real license and repository in package.json (packaging skips both for now).
