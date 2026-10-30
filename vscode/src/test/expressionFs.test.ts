import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { RpcError } from "../client";
import { ExpressionFileSystem, parseUri, uriFor } from "../expressionFs";
import { FakeClient } from "./fakes";
import { Diagnostic, FakeDiagnostics, FileChangeType, window } from "./vscodeStub";

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("uri helpers", () => {
  it("round-trips names with special characters", () => {
    const uri = uriFor("|grp|pCube1", "particleShape1:creation");
    assert.deepEqual(parseUri(uri), { object: "|grp|pCube1", id: "particleShape1:creation" });
    assert.ok(uri.path.endsWith(".mel"));
  });
});

describe("ExpressionFileSystem", () => {
  let client: FakeClient;
  let diagnostics: FakeDiagnostics;
  let fsp: ExpressionFileSystem;
  let events: vscode.FileChangeEvent[][];
  const uri = uriFor("pCube1", "expr1");

  beforeEach(() => {
    client = new FakeClient().add("expr1", "a;");
    diagnostics = new FakeDiagnostics();
    fsp = new ExpressionFileSystem(client.asClient(), diagnostics as unknown as vscode.DiagnosticCollection);
    events = [];
    fsp.onDidChangeFile((e) => events.push(e));
  });

  it("reads text and saves with the hash it read", async () => {
    assert.equal(decode(await fsp.readFile(uri)), "a;");
    await fsp.writeFile(uri, encode("b;"));
    assert.deepEqual(client.sets[0], { id: "expr1", change: { text: "b;", expectedHash: "h-a;" } });
    // The next save uses the hash Maya returned, so it doesn't conflict with itself.
    await fsp.writeFile(uri, encode("c;"));
    assert.equal(client.exprs.get("expr1")!.text, "c;");
  });

  it("turns a Maya conflict into a readable file system error", async () => {
    await fsp.readFile(uri);
    client.exprs.get("expr1")!.hash = "changed-in-maya";
    await assert.rejects(fsp.writeFile(uri, encode("b;")), (err: Error & { code?: string }) =>
      err.code === "Unavailable" && /Changed in Maya/.test(err.message));
  });

  it("maps a missing expression to FileNotFound", async () => {
    await assert.rejects(fsp.stat(uriFor("pCube1", "gone")), (err: { code?: string }) => err.code === "FileNotFound");
  });

  it("passes other errors through", async () => {
    await fsp.readFile(uri);
    client.failNextSet = new RpcError(-32603, "boom");
    await assert.rejects(fsp.writeFile(uri, encode("b;")), /boom/);
  });

  it("shows Maya errors as diagnostics and clears them on a clean save", async () => {
    await fsp.readFile(uri);
    client.errorsOnSet = [{ line: 3, message: "Syntax error" }, { line: null, message: "Runtime" }];
    await fsp.writeFile(uri, encode("bad"));
    const shown = diagnostics.entries.get(uri.toString()) as unknown as Diagnostic[];
    assert.equal(shown.length, 2);
    assert.equal((shown[0].range as unknown as { startLine: number }).startLine, 2);
    assert.equal((shown[1].range as unknown as { startLine: number }).startLine, 0);
    assert.match(shown[1].message, /no line number/);
    assert.equal(shown[0].source, "Maya");
    assert.ok(window.statusMessages.some((m) => /Maya reported an error/.test(m)));

    client.errorsOnSet = [];
    await fsp.writeFile(uri, encode("ok;"));
    assert.deepEqual(diagnostics.entries.get(uri.toString()), []);
  });

  it("reloads only open files whose hash changed in Maya", async () => {
    await fsp.readFile(uri);
    events = [];
    fsp.applyRemoteChanges({ treeChanged: false, changed: { expr1: "h-a;" }, removed: [] });
    assert.deepEqual(events, [], "same hash: our own write, no reload");

    fsp.applyRemoteChanges({ treeChanged: false, changed: { expr1: "new", other: "x" }, removed: [] });
    assert.deepEqual(events, [[{ type: FileChangeType.Changed, uri }]]);
  });

  it("reports removed expressions as deleted and drops their diagnostics", async () => {
    await fsp.readFile(uri);
    diagnostics.set(uri, []);
    fsp.applyRemoteChanges({ treeChanged: true, changed: {}, removed: ["expr1"] });
    assert.deepEqual(events.at(-1), [{ type: FileChangeType.Deleted, uri }]);
    assert.equal(diagnostics.entries.has(uri.toString()), false);
  });

  it("keeps mtime stable until Maya's content changes", async () => {
    const first = (await fsp.stat(uri)).mtime;
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await fsp.stat(uri)).mtime, first, "unchanged content: same mtime");
    client.exprs.get("expr1")!.hash = "edited-in-maya";
    assert.ok((await fsp.stat(uri)).mtime > first, "changed content: newer mtime");
  });

  it("waits for the connection before reading (tabs restored at startup)", async () => {
    await fsp.readFile(uri);
    assert.equal(client.connectWaits, 1);
    client.connected = false;
    await assert.rejects(fsp.readFile(uri), /Not connected to Maya/);
  });

  it("refuses delete and rename", () => {
    assert.throws(() => fsp.delete(), /Delete expressions in Maya/);
    assert.throws(() => fsp.rename(), /Rename expressions in Maya/);
  });
});
