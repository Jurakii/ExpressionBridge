# Easy Install and Maya "Connected" Indicator: Plan

## 1. What exists today

| Path | Steps for the user | Friction |
|---|---|---|
| `installer\Install.bat` (in the release zip) | Unzip, double-click | Needs the whole release folder; PowerShell can be blocked by policy |
| `maya\drag_and_drop_install.py` | Drag the file into a Maya viewport | Needs the unzipped release next to it; a separate VSIX step is still needed for VS Code |
| **Install from VSIX** in VS Code | Extensions → ... → Install from VSIX | Two installers to remember; the Maya module is not included |
| `python maya\install.py` | Developer only | Links to the checkout |

Three copies of the install logic exist (PowerShell, Python in `install.py`, Python in the drag-and-drop file), and each writes the `.mod` file. They can drift.

## 2. Can VS Code "drag into Maya"?

Not directly. VS Code can't drop a file into another application. It can do the same job in two ways:

- **A. "Maya: Install Bridge" command in VS Code (recommended, works with Maya closed).** The VSIX bundles the Maya module as a folder. The command copies it into Maya's modules folder and writes `ExpressionBridge.mod`, all from TypeScript with Node's `fs`. No PowerShell and no `.bat`. It finds the modules folder the same way Maya does:
  1. `MAYA_APP_DIR` if set, else
  2. the Documents folder from `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" /v Personal` (this follows OneDrive redirection).
- **B. Hot install into a running Maya.** Once the bridge is connected, VS Code sends a new RPC `installModule {path}`. Maya runs the same logic as `drag_and_drop_install.py` (stop the old server, copy, restart) with no restart. Only useful after A has run once, so it is a second step.

The "drag into Maya" feel stays with `drag_and_drop_install.py` for people who don't use VS Code. Keep it, but make it a thin wrapper around the shared Python install code.

## 3. Target experience

1. Download **one file**: `expression-bridge-<version>.vsix`.
2. In VS Code: **Install from VSIX** (or double-click it if VS Code is set as the handler).
3. A notification appears: **"Install the bridge into Maya?"** → **Install**. The module is copied and the `.mod` written.
4. Restart Maya (or click **Install & Start Now** if Maya is already open and the bridge is connected, which uses B).

Nothing else to run. Uninstall is a VS Code command: **Maya: Uninstall Bridge**.

## 4. Build changes

- `tools/build_release.py`: copy `maya/ExpressionBridge` into `vscode/resources/maya-module/` before `npm run package`. The `.vscodeignore` must not drop it. The zip then only needs the VSIX plus `INSTALL.md`.
- `vscode/src/install.ts` (new): `installModule(source, modulesDir)`, `writeMod(...)`, `findModulesDir()`, and `uninstallModule(...)`. Register `expressionBridge.installBridge` and `expressionBridge.uninstallBridge`.
- Keep `installer/install.ps1` and `Install.bat` for scripted and pipeline installs. They become optional.
- Tests: extend `maya/tests/test_install.py` with the same cases, and add `vscode/src/test/install.test.ts` for `.mod` text, modules-dir resolution (env var, registry, default) and copy/replace. Run the mod-loads check with mayapy as before.

## 5. "Connected" mod indicator

Goal: at a glance in Maya, see whether a VS Code window is connected. Also see it in VS Code.

### 5.1 Maya side (the mod)

- **Viewport HUD** (`cmds.headsUpDisplay`): a block in the top-left corner reading `Expression Bridge: ● VS Code connected` (green) or `○ Waiting for VS Code` (grey), or `Stopped` when the server is off. It uses a real HUD block, so it survives Maya layouts. Turn it off with a menu item.
- **Menu** (already exists): show the same state in the **Status** item and in the menu label, e.g. `Expression Bridge (connected)`.
- **Shelf button** (optional): icon color follows state. Ship the icon as a small PNG pair.
- **Events**: on connect and disconnect, show a short `inViewMessage` ("VS Code connected").

Implementation hooks already in the code: `server.py` has `add_client` / `remove_client`. Add a `_notify_state()` call there and a `state()` function returning `stopped | listening | connected` with the client count and VS Code extension version (sent in `ping`).

### 5.2 Protocol

- `ping` (already exists) gains `{extensionVersion}` from the client.
- New push `bridgeState {state, clients, vscodeVersion}` sent to all clients whenever the count changes.
- The VS Code status bar already shows connected or not. Add `state` and the Maya version to its tooltip.

### 5.3 Edge cases

- Two Mayas open: the HUD shows only in the one whose server wrote `session.json` last. The other shows `Listening (not the active session)`. This also fixes the existing "two Mayas" limit in part.
- Stale client: send a heartbeat `ping` every 10 s from VS Code. Maya drops clients that miss 3 pings.
- Batch mode: no HUD and no menu (already skipped).

## 6. Milestones

| # | Milestone | Done when | Est. |
|---|---|---|---|
| I0 | Bundle the module inside the VSIX; build still produces a release | `vsix` contains `resources/maya-module/` | 0.5 day |
| I1 | VS Code **Install Bridge** / **Uninstall Bridge** commands | Fresh Windows user: one command, Maya loads the bridge after restart | 1–2 days |
| I2 | Shared Python install code for drag-and-drop and `install.py` | One implementation; tests cover both | 0.5 day |
| I3 | Hot install via `installModule` RPC | Install from VS Code while Maya runs; no restart | 1 day |
| S1 | `bridgeState` push, `ping` heartbeat, status bar tooltip | VS Code closing → Maya shows waiting within 10 s | 1 day |
| S2 | Maya HUD block + menu label + inViewMessage | HUD changes on connect and disconnect in interactive Maya | 1–2 days |
| S3 | Optional shelf button | Shelf icon color matches state | 0.5–1 day |
| T | Manual check in interactive Maya 2026 and VS Code | Checklist in `INSTALL.md` passes on a clean profile | 0.5 day |

Total: about **1 week** for I0–I2 and S1–S2. I3 and S3 can wait.

## 7. Risks and decisions

| Risk | Mitigation |
|---|---|
| Windows SmartScreen and execution policy warn on `.bat` and `.ps1` | The VSIX path needs neither; ship code-signing later |
| OneDrive-redirected Documents | Use the registry lookup in §2A; also check Maya's `internalVar(userAppDir=True)` in the drag-and-drop path |
| Hot install replaces code that is still running | Stop the server, delete `sys.modules` entries, then restart, as `drag_and_drop_install.py` already does; test with a scene open |
| Maya versions differ in HUD API | HUD code is version-tolerant; verify on 2026 first, add 2024/2025 only if needed |
| Heartbeat load on big scenes | Heartbeat is a 10 s ping; no scene work |

### Decisions needed from you

1. **Single entry point:** is the VSIX the only thing you want users to download? (Recommended: yes. Keep the zip only for scripted installs.)
2. **Hot install (I3):** needed now, or after the first release?
3. **Indicator style:** viewport HUD (recommended), shelf button, or both?
4. **Heartbeat:** OK to add a 10 s ping from VS Code?

## 8. Recommended first step

Do **I0 + I1** first. It removes the most friction (one file, one command) and reuses the existing `.mod` logic. Then **S1 + S2** for the connected indicator.
