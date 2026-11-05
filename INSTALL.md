# Expression Bridge: install and use

Edit Maya expressions in VS Code. Saving in VS Code updates Maya, edits in Maya appear in VS Code,
and Maya's errors show in VS Code's Problems panel.

## Requirements
- Windows 10 or 11
- Maya 2024, 2025 or 2026
- VS Code 1.90 or newer

## Install

1. Unzip `ExpressionBridge-<version>.zip` anywhere.
2. Double-click **`Install.bat`**. It:
   - copies the Maya module into `Documents\maya\modules` and writes `ExpressionBridge.mod`
   - installs the **Expression Bridge** extension into VS Code
3. Start Maya, or restart it if it was open. An **Expression Bridge** menu appears in the main menu bar.
4. In VS Code, click **Restart Extensions** if prompted, then click the **Expression Bridge** icon in the activity bar.

`Install.bat` shows the Maya modules folder it will use. Press Enter to keep it. If your Maya prefs are somewhere else,
such as a synced drive, enter that folder instead (for example `X:\Sync\maya\2025\prefs`). The module goes into the
`modules` folder beside it, which only that Maya version reads. Run `Install.bat` once for each version.
`Uninstall.bat` asks the same way.

You can delete the unzipped folder afterwards; everything is copied into place.

**Other ways to install:**
- **From VS Code alone:** install the VSIX (below), then run **Maya: Install Bridge into Maya** from the Command
  Palette and restart Maya. Click **Choose Folder...** to pick your prefs folder if it isn't the one shown.
  **Maya: Uninstall Bridge from Maya** removes it again.
- **Maya only, without a restart:** drag `maya\drag_and_drop_install.py` into a Maya viewport.
  It installs and starts the bridge right away, and finds the folder by asking Maya.
- **VS Code only:** in VS Code, open Extensions, click **...** (top right), choose **Install from VSIX...**, and pick
  `vscode\expression-bridge-<version>.vsix`.
- **From PowerShell, with options:**
  `installer\install.ps1 [-SkipMaya] [-SkipVSCode] [-ModulesDir <folder>] [-CodeCli <path to code.cmd>]`.
  If you set `MAYA_APP_DIR`, the module goes into `%MAYA_APP_DIR%\modules`.

## Use

| To | Do this |
|---|---|
| See expressions | VS Code **Expression Bridge** icon → **Objects** lists every object that has expressions |
| Edit | Click an expression, edit, **Ctrl+S**. Maya updates. **Ctrl+Z in Maya** undoes the whole save |
| See errors | Maya's errors appear in **Problems** on the right line; Maya keeps the last working version |
| Change settings | **Settings** panel under the tree: Convert units, Always evaluate (applies at once) |
| Select in Maya | Hover an object in the tree → target icon |
| Follow Maya's selection | Automatic; turn off with the setting `expressionBridge.followMayaSelection` |
| Start / stop the bridge | Maya → **Expression Bridge** → Start / Stop / Status |

Edits made in Maya (for example in the Expression Editor) appear in VS Code within about a second. If you
have unsaved changes to the same expression, your next save is refused so it can't overwrite Maya's edit. Revert the
file in VS Code to load Maya's version.

Particle expressions (creation, runtime before dynamics, runtime after dynamics) show as separate entries
under the particle shape. Maya rewrites their text when saved (`lifespanPP` becomes `particleShape1.lifespanPP`).

## Update
Unzip the new version and run `Install.bat` again, then restart Maya and click **Restart Extensions** in VS Code.

## Uninstall
Double-click **`Uninstall.bat`**, or run `installer\install.ps1 -Uninstall`. This removes the module and the `.mod` file
from Maya's modules folder, and the extension from VS Code.

## Troubleshooting

| Problem | Fix |
|---|---|
| VS Code status bar shows **Maya** with a broken plug | Make sure Maya is open, then choose **Expression Bridge → Start** in Maya. VS Code retries every 3 s; click the status bar item to retry now and see the error |
| No **Expression Bridge** menu in Maya | Check that `ExpressionBridge.mod` exists in your modules folder (normally `Documents\maya\modules`), then restart Maya. If your prefs are on another drive, install again and enter that folder. In Maya's Script Editor, `cmds.moduleInfo(listModules=True)` should include `ExpressionBridge` |
| Two copies of Maya open | VS Code talks to the one that started its bridge last. In the one you want, choose **Expression Bridge → Stop**, then **Start** |
| `Install.bat` says the `code` command wasn't found | Install the extension from the VSIX by hand (see *Other ways to install* above) |
| Your company blocks PowerShell scripts | Use the drag-and-drop installer for Maya and **Install from VSIX** for VS Code |

**Security:** the bridge listens only on `127.0.0.1` (this computer), so no firewall rule is needed. Every
request must carry a random token that Maya writes to `%LOCALAPPDATA%\ExpressionBridge\session.json`
each time the bridge starts.
