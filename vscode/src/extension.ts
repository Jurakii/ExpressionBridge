import * as vscode from "vscode";
import { ExpressionSettings, ExpressionsChanged, MayaClient, SelectionChanged } from "./client";
import { ExpressionFileSystem, parseUri, SCHEME, uriFor } from "./expressionFs";
import { SettingsViewProvider } from "./settingsView";
import { ExpressionTreeProvider, Node } from "./tree";

const RECONNECT_MS = 3_000;

export function activate(context: vscode.ExtensionContext): void {
  const client = new MayaClient();
  const diagnostics = vscode.languages.createDiagnosticCollection("maya");
  const fsProvider = new ExpressionFileSystem(client, diagnostics);
  const tree = new ExpressionTreeProvider(client);
  const treeView = vscode.window.createTreeView("mayaExpressions.tree", { treeDataProvider: tree });
  const settingsView = new SettingsViewProvider(client, ({ object, id }) =>
    fsProvider.notifyChanged(uriFor(object, id)),
  );
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  let reconnectTimer: NodeJS.Timeout | undefined;

  const setStatus = (connected: boolean) => {
    status.text = connected ? "$(plug) Maya" : "$(debug-disconnect) Maya";
    status.tooltip = connected ? "Connected to Maya" : "Not connected. Click to connect.";
    status.command = connected ? "mayaExpressions.refresh" : "mayaExpressions.connect";
    status.show();
  };

  const connect = async (quiet: boolean) => {
    try {
      const session = await client.connect();
      await tree.refresh();
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
    reconnectTimer = setTimeout(() => void connect(true), RECONNECT_MS);
  };

  client.on("state", (connected: boolean) => {
    setStatus(connected);
    void settingsView.reload();
    if (!connected) {
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
      void tree.refresh();
    }
  });

  client.on("selectionChanged", ({ objects }: SelectionChanged) => {
    if (!vscode.workspace.getConfiguration("mayaExpressions").get<boolean>("followMayaSelection", true)) {
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
    { dispose: () => { clearTimeout(reconnectTimer); client.disconnect(); } },
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    treeView,
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewId, settingsView),
    treeView.onDidChangeSelection(({ selection: [node] }) => {
      if (node?.type === "expression") {
        showSettingsFor(node.object, node.expr.id);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    vscode.commands.registerCommand("mayaExpressions.connect", () => connect(false)),
    vscode.commands.registerCommand("mayaExpressions.refresh", run(() => tree.refresh())),
    vscode.commands.registerCommand("mayaExpressions.selectInMaya", run(async (node?: Node) => {
      if (node?.type === "object") {
        await client.select(node.name);
      }
    })),
    vscode.commands.registerCommand("mayaExpressions.setUnitConversion", run(async (node?: Node) => {
      const pick = await vscode.window.showQuickPick(["all", "none", "angularOnly"], { title: "Convert Units" });
      if (pick) {
        await updateSettings(node, { unitConversion: pick as ExpressionSettings["unitConversion"] });
      }
    })),
    vscode.commands.registerCommand("mayaExpressions.toggleAlwaysEvaluate", run(async (node?: Node) => {
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

export function deactivate(): void {}
