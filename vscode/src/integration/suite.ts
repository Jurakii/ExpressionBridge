/**
 * Runs inside the VS Code extension host. A fake bridge stands in for Maya
 * (real-Maya coverage lives in maya/tests/test_maya_integration.py).
 */
import * as assert from "assert";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";

const TOKEN = "it-token";

interface Expr {
  text: string;
  settings: { unitConversion: string; alwaysEvaluate: boolean };
  rev: number;
}

/** Minimal bridge: list/get/set/select with Maya-like errors and hashes. */
class FakeBridge {
  readonly exprs = new Map<string, Expr>([
    ["expr1", { text: "pCube1.translateY = time;", settings: { unitConversion: "all", alwaysEvaluate: true }, rev: 0 }],
  ]);
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  private sockets: net.Socket[] = [];
  private server = net.createServer((s) => this.onSocket(s));

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const dir = path.join(process.env.LOCALAPPDATA!, "MayaExpressionBridge");
    fs.mkdirSync(dir, { recursive: true });
    const port = (this.server.address() as net.AddressInfo).port;
    fs.writeFileSync(path.join(dir, "session.json"),
      JSON.stringify({ port, token: TOKEN, pid: process.pid, mayaVersion: "fake", protocol: 1 }));
  }

  push(method: string, params: unknown): void {
    this.sockets.forEach((s) => s.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"));
  }

  hash(id: string): string {
    return `${id}@${this.exprs.get(id)!.rev}`;
  }

  view(id: string) {
    const e = this.exprs.get(id)!;
    return { id, kind: "expression", language: "mel", text: e.text, settings: { ...e.settings }, hash: this.hash(id) };
  }

  private handle(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "ping":
        return { protocol: 1 };
      case "list":
        return { pCube1: [{ id: "expr1", kind: "expression", drives: ["pCube1.translateY"] }] };
      case "get":
        return this.view(p.id as string);
      case "select":
        return { selected: p.object };
      case "set": {
        const id = p.id as string;
        const e = this.exprs.get(id)!;
        if (p.expectedHash && p.expectedHash !== this.hash(id)) {
          throw { code: -32009, message: "Expression changed in Maya since it was opened" };
        }
        const text = p.text as string | undefined;
        if (text !== undefined && text.includes("SYNTAX")) {
          return { ...this.view(id), errors: [{ line: 2, message: "Syntax error" }] };
        }
        if (text !== undefined) {
          e.text = text;
        }
        Object.assign(e.settings, p.settings ?? {});
        e.rev++;
        return { ...this.view(id), errors: [] };
      }
    }
    throw { code: -32601, message: `Unknown method: ${method}` };
  }

  private onSocket(socket: net.Socket): void {
    this.sockets.push(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const req = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        this.calls.push({ method: req.method, params: req.params ?? {} });
        let reply: object;
        try {
          assert.equal(req.token, TOKEN);
          reply = { jsonrpc: "2.0", id: req.id, result: this.handle(req.method, req.params ?? {}) };
        } catch (err) {
          reply = { jsonrpc: "2.0", id: req.id, error: err };
        }
        socket.write(JSON.stringify(reply) + "\n");
      }
    });
  }
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const uri = vscode.Uri.from({ scheme: "maya-expr", path: "/pCube1/expr1.mel" });

const tests: [string, (bridge: FakeBridge) => Promise<void>][] = [
  ["activates and contributes the MEL language and commands", async () => {
    const ext = vscode.extensions.getExtension("local.maya-expressions");
    assert.ok(ext, "extension is installed");
    await ext.activate();
    assert.ok((await vscode.languages.getLanguages()).includes("mel"));
    const commands = await vscode.commands.getCommands(true);
    for (const c of ["connect", "refresh", "selectInMaya", "setUnitConversion", "toggleAlwaysEvaluate"]) {
      assert.ok(commands.includes(`mayaExpressions.${c}`), c);
    }
  }],

  ["connects to the bridge from session.json", async (bridge) => {
    await vscode.commands.executeCommand("mayaExpressions.connect");
    await waitFor("ping", () => bridge.calls.some((c) => c.method === "ping"));
    await waitFor("list", () => bridge.calls.some((c) => c.method === "list"));
  }],

  ["opens an expression as a MEL document", async () => {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    assert.equal(doc.getText(), "pCube1.translateY = time;");
    assert.equal(doc.languageId, "mel");
  }],

  ["saving sends the text to Maya with the hash it was opened with", async (bridge) => {
    const editor = vscode.window.activeTextEditor!;
    await editor.edit((e) => e.replace(new vscode.Range(0, 0, 1, 0), "pCube1.translateY = 2 * time;"));
    assert.ok(await editor.document.save());
    const set = bridge.calls.filter((c) => c.method === "set").at(-1)!;
    assert.equal(set.params.text, "pCube1.translateY = 2 * time;");
    assert.equal(set.params.expectedHash, "expr1@0");
    assert.equal(bridge.exprs.get("expr1")!.text, "pCube1.translateY = 2 * time;");
  }],

  ["Maya errors on save show up as diagnostics", async () => {
    const editor = vscode.window.activeTextEditor!;
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), "float $a = 1;\nSYNTAX\n"));
    await editor.document.save();
    const diags = await waitFor("diagnostics", () => {
      const d = vscode.languages.getDiagnostics(uri);
      return d.length ? d : undefined;
    });
    assert.equal(diags[0].message, "Syntax error");
    assert.equal(diags[0].range.start.line, 1);
    assert.equal(diags[0].source, "Maya");
  }],

  ["a Maya-side edit reloads a clean editor", async (bridge) => {
    await vscode.commands.executeCommand("workbench.action.files.revert");
    const expr = bridge.exprs.get("expr1")!;
    expr.text = "pCube1.translateY = 42;";
    expr.rev++;
    bridge.push("expressionsChanged", { treeChanged: false, changed: { expr1: bridge.hash("expr1") }, removed: [] });
    const doc = vscode.window.activeTextEditor!.document;
    await waitFor("reload", () => doc.getText() === "pCube1.translateY = 42;");
    assert.equal(doc.isDirty, false);
  }],

  ["a save that would overwrite a Maya-side edit is refused", async (bridge) => {
    const editor = vscode.window.activeTextEditor!;
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), "// mine\n"));
    const expr = bridge.exprs.get("expr1")!;
    expr.text = "pCube1.translateY = 7;";
    expr.rev++; // changed in Maya, but no push: the editor is dirty anyway
    // VS Code sees the newer mtime and refuses; the bridge's hash check is the
    // backstop if the user picks "Overwrite" (covered by the unit tests).
    const saved = await editor.document.save();
    assert.equal(saved, false);
    assert.equal(bridge.exprs.get("expr1")!.text, "pCube1.translateY = 7;");
    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.equal(editor.document.getText(), "pCube1.translateY = 7;");
  }],

  ["right-click settings commands write to Maya", async (bridge) => {
    const node = { type: "expression", object: "pCube1", expr: { id: "expr1", kind: "expression", drives: [] } };
    await vscode.commands.executeCommand("mayaExpressions.toggleAlwaysEvaluate", node);
    await waitFor("toggle", () => bridge.exprs.get("expr1")!.settings.alwaysEvaluate === false);
  }],

  ["select in Maya sends the object", async (bridge) => {
    await vscode.commands.executeCommand("mayaExpressions.selectInMaya", { type: "object", name: "pCube1" });
    await waitFor("select", () => bridge.calls.some((c) => c.method === "select" && c.params.object === "pCube1"));
  }],
];

/** Entry point called by VS Code's test runner. */
export async function run(): Promise<void> {
  const bridge = new FakeBridge();
  await bridge.start();
  const failures: string[] = [];
  for (const [name, test] of tests) {
    try {
      await test(bridge);
      console.log(`  ✔ ${name}`);
    } catch (err) {
      console.log(`  ✖ ${name}\n    ${(err as Error).stack ?? err}`);
      failures.push(name);
    }
  }
  console.log(`${tests.length - failures.length}/${tests.length} integration tests passed`);
  if (failures.length) {
    throw new Error(`${failures.length} integration test(s) failed`);
  }
}
