import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { RpcError } from "../client";
import { SettingsViewProvider, Target, validate } from "../settingsView";
import { FakeClient } from "./fakes";
import { EventEmitter } from "./vscodeStub";

interface State {
  type: "state";
  target: Target | null;
  expr: { id: string; settings: Record<string, unknown> } | null;
  error: string | null;
}

/** A WebviewView double: records posted messages, lets tests send messages in. */
function fakeView() {
  const posted: State[] = [];
  const inbound = new EventEmitter<unknown>();
  const view = {
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      postMessage: async (m: State) => posted.push(m),
      onDidReceiveMessage: inbound.event,
    },
    onDidChangeVisibility: () => undefined,
    onDidDispose: () => undefined,
  };
  return { view: view as unknown as vscode.WebviewView, posted, send: (m: unknown) => inbound.fire(m), raw: view };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("validate", () => {
  it("accepts known settings with valid values", () => {
    assert.deepEqual(validate({ unitConversion: "none" }), { unitConversion: "none" });
    assert.deepEqual(validate({ alwaysEvaluate: false }), { alwaysEvaluate: false });
  });

  it("rejects bad values, wrong types and empty input", () => {
    for (const bad of [null, "x", {}, { unitConversion: "metric" }, { alwaysEvaluate: "yes" }, { other: 1 }]) {
      assert.equal(validate(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("SettingsViewProvider", () => {
  let client: FakeClient;
  let written: Target[];
  let provider: SettingsViewProvider;
  let ui: ReturnType<typeof fakeView>;
  const target: Target = { object: "pCube1", id: "expr1", drives: ["pCube1.ty"] };

  beforeEach(() => {
    client = new FakeClient().add("expr1").add("expr2");
    written = [];
    provider = new SettingsViewProvider(client.asClient(), (t) => written.push(t));
    ui = fakeView();
    provider.resolveWebviewView(ui.view);
  });

  it("locks the webview down with a nonce CSP and no remote content", () => {
    const html = ui.raw.webview.html;
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    assert.match(csp, /default-src 'none'/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce);
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /innerHTML/);
  });

  it("loads the target and posts its settings", async () => {
    provider.setTarget(target);
    await flush();
    const last = ui.posted.at(-1)!;
    assert.equal(last.expr?.id, "expr1");
    assert.deepEqual(last.target, target);
  });

  it("writes a valid update and notifies the editor", async () => {
    provider.setTarget(target);
    await flush();
    ui.send({ type: "update", id: "expr1", settings: { unitConversion: "none" } });
    await flush();
    assert.deepEqual(client.sets, [{ id: "expr1", change: { settings: { unitConversion: "none" } } }]);
    assert.deepEqual(written, [target]);
    assert.equal(ui.posted.at(-1)!.expr?.settings.unitConversion, "none");
  });

  it("ignores updates for another expression or with invalid values", async () => {
    provider.setTarget(target);
    await flush();
    ui.send({ type: "update", id: "expr2", settings: { unitConversion: "none" } });
    ui.send({ type: "update", id: "expr1", settings: { unitConversion: "metric" } });
    ui.send({ type: "delete", id: "expr1" });
    await flush();
    assert.deepEqual(client.sets, []);
  });

  it("keeps the error visible after a failed write and shows Maya's real values", async () => {
    provider.setTarget(target);
    await flush();
    client.failNextSet = new RpcError(-32000, "Maya is busy");
    ui.send({ type: "update", id: "expr1", settings: { alwaysEvaluate: false } });
    await flush();
    await flush();
    const last = ui.posted.at(-1)!;
    assert.equal(last.error, "Maya is busy");
    assert.equal(last.expr?.settings.alwaysEvaluate, true);
  });

  it("shows the latest selection even if an older load finishes last", async () => {
    let release!: () => void;
    client.delayGet.set("expr1", new Promise<void>((r) => (release = r)));
    provider.setTarget(target);
    provider.setTarget({ object: "pCube1", id: "expr2", drives: [] });
    await flush();
    release();
    await flush();
    assert.equal(ui.posted.at(-1)!.expr?.id, "expr2");
    assert.ok(ui.posted.every((m) => m.expr?.id !== "expr1"));
  });

  it("shows a load error for an expression that no longer exists", async () => {
    provider.setTarget({ object: "pCube1", id: "gone", drives: [] });
    await flush();
    const last = ui.posted.at(-1)!;
    assert.equal(last.expr, null);
    assert.match(last.error ?? "", /No such expression/);
  });
});
