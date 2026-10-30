# Maya Expressions

Browse and edit Maya expressions from VS Code. This needs the Maya Expression Bridge module
running in Maya. In the project root, run `python maya/install.py`, then restart Maya.

- The **Maya Expressions** view lists objects that have expressions. Click one to open it.
- When you save, the expression is sent to Maya. Errors Maya reports show in the Problems panel.
- Changes made in Maya reload here. Maya's selection is highlighted in the tree.
- Right-click an expression to set Convert Units or Always Evaluate.

Setting: `mayaExpressions.followMayaSelection` (default on).
