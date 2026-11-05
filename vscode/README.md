# Expression Bridge

Browse and edit Maya expressions from VS Code. This needs the Expression Bridge module
running in Maya. Run **Maya: Install Bridge into Maya** from the Command Palette, then restart Maya.

- The **Expression Bridge** view lists objects that have expressions. Click one to open it.
- When you save, the expression is sent to Maya. Errors Maya reports show in the Problems panel.
- Changes made in Maya reload here. Maya's selection is highlighted in the tree.
- Right-click an expression to set Convert Units or Always Evaluate.

Settings: `expressionBridge.followMayaSelection` (default on) and `expressionBridge.mayaModulesDir`, the folder the
Install command uses (default: Maya's own).
