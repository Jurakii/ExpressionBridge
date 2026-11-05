import * as path from "node:path";
import * as vscode from "vscode";
import { ExpressionSettings, ExpressionsChanged, MayaClient, SelectionChanged } from "./client";
import { ExpressionFileSystem, parseUri, SCHEME, uriFor } from "./expressionFs";
import { findModulesDir, installModule, modulesDirFrom, uninstallModule } from "./install";
import { SettingsViewProvider } from "./settingsView";
import { ExpressionTreeProvider, Node } from "./tree";

const RECONNECT_MS = 3_000;

export function activate(context: vscode.ExtensionContext): void {
  const client = new MayaClient();
  const diagnostics = vscode.languages.createDiagnosticCollection("maya");
  const fsProvider = new ExpressionFileSystem(client, diagnostics);
  const tree = new ExpressionTreeProvider(client);
  const treeView = vscode.window.createTreeView("expressionBridge.tree", { treeDataProvider: tree });
  const settingsView = new SettingsViewProvider(client, ({ object, id }) =>
    fsProvider.notifyChanged(uriFor(object, id)),
  );
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  let reconnectTimer: NodeJS.Timeout | undefined;

  const setStatus = (connected: boolean) => {
    status.text = connected ? "$(plug) Maya" : "$(debug-disconnect) Maya";
    status.tooltip = connected ? "Connected to Maya" : "Not connected. Click to connect.";
    status.command = connected ? "expressionBridge.refresh" : "expressionBridge.connect";
    status.show();
  };

  const connect = async (quiet: boolean) => {
    try {
      const session = await client.connect();
      await tree.refresh();
      followEditor(vscode.window.activeTextEditor);
      if (!quiet) {
        vscode.window.showInformationMessage(`Connected to Maya ${session.mayaVersion ?? ""}`.trim());
      }
    } catch (err) {
      if (!quiet) {
        vscode.window.showErrorMessage(`Could not connect to Maya: ${(err as Error).message}`);
      }
      scheduleReconnect();
    }
  };

  // Maya restarts get a new port and token, so keep re-reading session.json.
  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!client.connected) {
        void connect(true);
      }
    }, RECONNECT_MS);
  };

  client.on("state", (connected: boolean) => {
    setStatus(connected);
    void settingsView.reload();
    if (connected) {
      clearTimeout(reconnectTimer);
    } else {
      void tree.refresh();
      scheduleReconnect();
    }
  });

  client.on("expressionsChanged", (change: ExpressionsChanged) => {
    fsProvider.applyRemoteChanges(change);
    const id = settingsView.currentId;
    if (id && (id in change.changed || change.removed.includes(id))) {
      void settingsView.reload();
    }
    if (change.treeChanged) {
      tree.refresh().catch((err: Error) => console.error(`Expression Bridge: refresh failed: ${err.message}`));
    }
  });

  client.on("selectionChanged", ({ objects }: SelectionChanged) => {
    if (!vscode.workspace.getConfiguration("expressionBridge").get<boolean>("followMayaSelection", true)) {
      return;
    }
    const node = objects.map((name) => tree.objectNode(name)).find((n) => n !== undefined);
    if (node && treeView.visible) {
      void treeView.reveal(node, { select: true, focus: false, expand: true });
    }
  });

  // The settings panel follows the expression picked in the tree or open in the editor.
  const showSettingsFor = (object: string, id: string) => {
    const summary = tree.findExpression(object, id);
    settingsView.setTarget({ object, id, drives: summary?.drives ?? [] });
  };
  const followEditor = (editor: vscode.TextEditor | undefined) => {
    if (editor?.document.uri.scheme === SCHEME) {
      const { object, id } = parseUri(editor.document.uri);
      showSettingsFor(object, id);
    }
  };

  const updateSettings = async (node: Node | undefined, settings: ExpressionSettings) => {
    if (node?.type !== "expression") {
      return;
    }
    await client.set(node.expr.id, { settings });
    fsProvider.notifyChanged(uriFor(node.object, node.expr.id));
    if (settingsView.currentId === node.expr.id) {
      await settingsView.reload();
    }
  };

  const run = (fn: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  };

  context.subscriptions.push(
    status,
    diagnostics,
    { dispose: () => { client.removeAllListeners(); clearTimeout(reconnectTimer); client.disconnect(); } },
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    treeView,
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewId, settingsView),
    treeView.onDidChangeSelection(({ selection: [node] }) => {
      if (node?.type === "expression") {
        showSettingsFor(node.object, node.expr.id);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    vscode.commands.registerCommand("expressionBridge.connect", () => connect(false)),
    vscode.commands.registerCommand("expressionBridge.refresh", run(() => tree.refresh())),
    vscode.commands.registerCommand("expressionBridge.selectInMaya", run(async (node?: Node) => {
      if (node?.type === "object") {
        await client.select(node.name);
      }
    })),
    vscode.commands.registerCommand("expressionBridge.setUnitConversion", run(async (node?: Node) => {
      const pick = await vscode.window.showQuickPick(["all", "none", "angularOnly"], { title: "Convert Units" });
      if (pick) {
        await updateSettings(node, { unitConversion: pick as ExpressionSettings["unitConversion"] });
      }
    })),
    vscode.commands.registerCommand("expressionBridge.installBridge", run(() => installBridge(context))),
    vscode.commands.registerCommand("expressionBridge.uninstallBridge", run(() => uninstallBridge())),
    vscode.commands.registerCommand("expressionBridge.toggleAlwaysEvaluate", run(async (node?: Node) => {
      if (node?.type !== "expression") {
        return;
      }
      const current = await client.get(node.expr.id);
      await updateSettings(node, { alwaysEvaluate: !current.settings.alwaysEvaluate });
      vscode.window.showInformationMessage(`Always Evaluate: ${!current.settings.alwaysEvaluate ? "on" : "off"}`);
    })),
  );

  setStatus(false);
  void connect(true);
}

/** Shows the modules folder and lets the user change it. Returns undefined if they cancel. */
async function confirmModulesDir(
  show: typeof vscode.window.showInformationMessage,
  question: string,
  action: string,
): Promise<string | undefined> {
  const choose = "Choose Folder...";
  let dir = vscode.workspace.getConfiguration("expressionBridge").get<string>("mayaModulesDir") || findModulesDir();
  for (;;) {
    const choice = await show(`${question}\n\n${dir}`, { modal: true }, action, choose);
    if (choice === action) {
      return dir;
    }
    if (choice !== choose) {
      return undefined;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      defaultUri: vscode.Uri.file(dir),
      title: "Choose your Maya prefs or modules folder",
      openLabel: "Use This Folder",
    });
    if (picked) {
      dir = modulesDirFrom(picked[0].fsPath);
    }
  }
}

async function installBridge(context: vscode.ExtensionContext): Promise<void> {
  const modulesDir = await confirmModulesDir(vscode.window.showInformationMessage, "Install the Expression Bridge into Maya?", "Install");
  if (!modulesDir) {
    return;
  }
  const { version } = installModule(context.asAbsolutePath(path.join("resources", "maya-module")), modulesDir);
  // Remembered so upgrades and uninstalling find the same folder.
  await vscode.workspace
    .getConfiguration("expressionBridge")
    .update("mayaModulesDir", modulesDir === findModulesDir() ? undefined : modulesDir, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    `Expression Bridge ${version} installed. Close and reopen Maya to load it, then open the Expression Bridge view.`,
  );
}

async function uninstallBridge(): Promise<void> {
  const modulesDir = await confirmModulesDir(
    vscode.window.showWarningMessage,
    "Remove the Expression Bridge from Maya? Maya will no longer load it after a restart.",
    "Uninstall",
  );
  if (!modulesDir) {
    return;
  }
  const removed = uninstallModule(modulesDir);
  void vscode.window.showInformationMessage(
    removed ? "Expression Bridge removed from Maya. Restart Maya to finish." : "The Expression Bridge was not installed in Maya.",
  );
}

export function deactivate(): void {}
