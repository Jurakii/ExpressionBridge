# Changelog

## Unreleased

### Added
- The Maya module can be installed outside Documents, for example to prefs on a synced drive. `Install.bat`,
  `Uninstall.bat` and **Maya: Install Bridge into Maya** now show the folder and let you change it. The default is
  unchanged.

### Changed
- New Expression Bridge icon in the activity bar, replacing the **M**.

## 1.0.0 - 2026-11-05

First stable release: browse and edit Maya expressions from VS Code, with live two-way sync, Maya's errors in the
Problems panel, a settings panel, MEL highlighting, and a Windows installer or one-click install from VS Code.

### Fixed
- **Stop now disconnects VS Code.** Clients stayed connected to a stopped bridge and could still read and write, so
  switching between two Mayas with Stop and Start did not work.
- A VS Code window that stops reading can no longer freeze Maya. Pushes are queued per client, and a stalled client is
  dropped.
- Running **Maya: Connect** while connected no longer causes a reconnect every 3 seconds.
- Stopping one Maya no longer deletes the session file of another Maya.
- An expression in a namespace named after a particle slot (`ns:creation`) no longer breaks the scan and stops the
  bridge from starting.
- Closing VS Code no longer prints a connection traceback in Maya's Script Editor.
- A busy Maya now gives a clear message instead of an empty error, and no longer fills the log during long operations.
- The extension no longer reconnects after shutting down, and no longer refreshes the tree every 3 seconds while Maya
  is unreachable.
- Overlapping connection attempts no longer leak a socket or hang.
- `Install Bridge` now follows a Documents folder that the registry defines through any environment variable, not only
  `%USERPROFILE%`.
- The settings panel opens on the active editor after connecting, and no longer shows the wrong expression if the
  selection changes during a write.
- **Select in Maya** is no longer offered on the `<Scene>` group.

### Security
- Malformed tokens and deeply nested JSON sent before authentication are rejected cleanly instead of killing the
  connection thread.
- Oversized messages now drop the connection instead of being parsed in pieces.
- Request parameters can no longer reach the dispatcher's own options.
- `session.json` is created readable only by the current user.

### Changed
- The real-Maya test suite now passes on Maya 2024 and 2025, so both are listed as supported.
- Commands that need a tree item are hidden from the Command Palette.
- The `.bat` and `.ps1` files always have CRLF line endings.
- Added CI and a tag-driven release workflow.

### Removed
- The `spike.py` development script and the planning documents.
