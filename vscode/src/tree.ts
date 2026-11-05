import * as vscode from "vscode";
import { ExpressionSummary, MayaClient, SceneTree } from "./client";
import { uriFor } from "./expressionFs";

/** The group for expressions that drive nothing; see SCENE_GROUP in scanner.py. It isn't a Maya object. */
const SCENE_GROUP = "<Scene>";

export type Node =
  | { type: "object"; name: string }
  | { type: "expression"; object: string; expr: ExpressionSummary };

/** Outliner-style tree: objects that have expressions, then their expressions. */
export class ExpressionTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private scene: SceneTree = {};
  // Stable node objects, so TreeView.reveal can find them by identity.
  private objects = new Map<string, Node>();

  constructor(private readonly client: MayaClient) {}

  async refresh(): Promise<void> {
    this.scene = this.client.connected ? await this.client.list() : {};
    this.objects = new Map(Object.keys(this.scene).map((name) => [name, { type: "object", name } as Node]));
    this.emitter.fire(undefined);
  }

  findExpression(object: string, id: string): ExpressionSummary | undefined {
    return this.scene[object]?.find((e) => e.id === id);
  }

  objectNode(name: string): Node | undefined {
    return this.objects.get(name);
  }

  getParent(node: Node): Node | undefined {
    return node.type === "expression" ? this.objects.get(node.object) : undefined;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return [...this.objects.values()];
    }
    if (node.type === "object") {
      return (this.scene[node.name] ?? []).map((expr) => ({ type: "expression", object: node.name, expr }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "object") {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `object:${node.name}`;
      item.contextValue = node.name === SCENE_GROUP ? "scene" : "object";
      item.iconPath = new vscode.ThemeIcon("symbol-class");
      return item;
    }
    const { expr, object } = node;
    const item = new vscode.TreeItem(expr.kind === "particle" ? expr.slot! : expr.id);
    item.id = `expr:${object}/${expr.id}`;
    item.contextValue = expr.kind;
    item.description = expr.kind === "particle" ? "particle" : undefined;
    item.tooltip = expr.drives.length ? `Drives:\n${expr.drives.join("\n")}` : undefined;
    item.iconPath = new vscode.ThemeIcon("symbol-event");
    item.resourceUri = uriFor(object, expr.id);
    item.command = { command: "vscode.open", title: "Open", arguments: [item.resourceUri] };
    return item;
  }
}
