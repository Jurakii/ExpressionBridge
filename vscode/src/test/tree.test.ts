import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MayaClient, SceneTree } from "../client";
import { ExpressionTreeProvider } from "../tree";

const scene: SceneTree = {
  pCube1: [{ id: "expr1", kind: "expression", drives: ["pCube1.translateY"] }],
  pSphere1: [{ id: "expr1", kind: "expression", drives: [] }],
  particleShape1: [{ id: "particleShape1:creation", kind: "particle", slot: "creation", drives: [] }],
};

async function loaded() {
  const client = { connected: true, list: async () => scene } as unknown as MayaClient;
  const tree = new ExpressionTreeProvider(client);
  await tree.refresh();
  return tree;
}

describe("ExpressionTreeProvider", () => {
  it("lists objects, then their expressions with a parent link", async () => {
    const tree = await loaded();
    const roots = tree.getChildren();
    assert.deepEqual(roots.map((n) => n.type === "object" && n.name), ["pCube1", "pSphere1", "particleShape1"]);
    const [child] = tree.getChildren(roots[0]);
    assert.equal(tree.getParent(child), roots[0]);
  });

  it("returns the same object node every time, so reveal works", async () => {
    const tree = await loaded();
    assert.equal(tree.objectNode("pCube1"), tree.getChildren()[0]);
  });

  it("gives an expression shared by two objects a unique item id per object", async () => {
    const tree = await loaded();
    const ids = tree.getChildren().slice(0, 2).map((obj) => tree.getTreeItem(tree.getChildren(obj)[0]).id);
    assert.deepEqual(ids, ["expr:pCube1/expr1", "expr:pSphere1/expr1"]);
  });

  it("labels particle expressions by slot and opens them on click", async () => {
    const tree = await loaded();
    const item = tree.getTreeItem(tree.getChildren(tree.objectNode("particleShape1"))[0]);
    assert.equal(item.label, "creation");
    assert.equal(item.contextValue, "particle");
    assert.equal(item.command?.command, "vscode.open");
  });

  it("is empty while disconnected", async () => {
    const tree = new ExpressionTreeProvider({ connected: false } as unknown as MayaClient);
    await tree.refresh();
    assert.deepEqual(tree.getChildren(), []);
  });
});
