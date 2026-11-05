import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { Expression, ExpressionSettings, MayaClient } from "./client";

const UNIT_CONVERSIONS = ["all", "none", "angularOnly"] as const;

export interface Target {
  object: string;
  id: string;
  drives: string[];
}

/** Messages the webview may send. Everything else is ignored. */
type Inbound =
  | { type: "ready" }
  | { type: "update"; id: string; settings: ExpressionSettings };

/**
 * Sidebar panel with the settings of the current expression: Convert Units,
 * Always Evaluate, and (read-only) the particle slot. The webview only renders
 * and posts intents; the extension validates them and talks to Maya.
 */
export class SettingsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "expressionBridge.settings";

  private view?: vscode.WebviewView;
  private target?: Target;
  private expr?: Expression;
  private error?: string;
  private loadSeq = 0;

  constructor(
    private readonly client: MayaClient,
    private readonly onSettingsWritten: (target: Target) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: Inbound) => void this.onMessage(msg));
    view.onDidChangeVisibility(() => view.visible && void this.reload());
    view.onDidDispose(() => (this.view = undefined));
  }

  get currentId(): string | undefined {
    return this.target?.id;
  }

  setTarget(target: Target | undefined): void {
    if (target?.id === this.target?.id && target?.object === this.target?.object) {
      return;
    }
    this.target = target;
    this.expr = undefined;
    void this.reload();
  }

  /** Re-read the current expression from Maya (after a push or reconnect). */
  async reload(): Promise<void> {
    const seq = ++this.loadSeq;
    this.error = undefined;
    if (this.target && this.client.connected) {
      try {
        const expr = await this.client.get(this.target.id);
        if (seq !== this.loadSeq) {
          return; // a newer selection won the race
        }
        this.expr = expr;
      } catch (err) {
        if (seq !== this.loadSeq) {
          return;
        }
        this.expr = undefined;
        this.error = (err as Error).message;
      }
    } else {
      this.expr = undefined;
    }
    this.post();
  }

  private async onMessage(msg: Inbound): Promise<void> {
    if (msg?.type === "ready") {
      this.post();
      return;
    }
    if (msg?.type !== "update" || !this.target || msg.id !== this.target.id || this.expr?.kind !== "expression") {
      return;
    }
    const settings = validate(msg.settings);
    if (!settings) {
      return;
    }
    const target = this.target;
    try {
      const updated = await this.client.set(target.id, { settings });
      this.onSettingsWritten(target);
      if (this.target?.id !== target.id) {
        return; // the selection moved on while Maya was writing
      }
      this.expr = updated;
      this.error = undefined;
    } catch (err) {
      // Reload so the controls snap back to Maya's real values, then show why.
      await this.reload();
      this.error = (err as Error).message;
      this.post();
      return;
    }
    this.post();
  }

  private post(): void {
    void this.view?.webview.postMessage({
      type: "state",
      connected: this.client.connected,
      target: this.target ?? null,
      expr: this.expr ? { id: this.expr.id, kind: this.expr.kind, settings: this.expr.settings } : null,
      error: this.error ?? null,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const options = UNIT_CONVERSIONS.map((u) => `<option value="${u}">${UNIT_LABELS[u]}</option>`).join("");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 8px 12px; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
  h2 { font-size: 1em; margin: 0 0 2px; font-weight: 600; word-break: break-all; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; word-break: break-all; }
  label { display: block; margin: 10px 0 4px; }
  select { width: 100%; padding: 3px; color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
  select:focus, input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .check { display: flex; gap: 6px; align-items: center; margin-top: 12px; }
  .check label { margin: 0; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; }
  .error { color: var(--vscode-errorForeground); margin-top: 12px; }
  .empty { color: var(--vscode-descriptionForeground); }
  ul { margin: 4px 0 0; padding-left: 16px; color: var(--vscode-descriptionForeground); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <p id="empty" class="empty">Select an expression in the tree to see its settings.</p>
  <section id="panel" hidden>
    <h2 id="title"></h2>
    <div id="owner" class="sub"></div>

    <div id="exprSettings">
      <label for="units">Convert units</label>
      <select id="units">${options}</select>
      <div class="check">
        <input type="checkbox" id="always">
        <label for="always">Always evaluate</label>
      </div>
      <div class="hint">Off: evaluates only when an input changes.</div>
    </div>

    <div id="particleSettings" hidden>
      <label>Particle slot</label>
      <div id="slot"></div>
      <div class="hint">Each slot is a separate expression in the tree.</div>
    </div>

    <div id="drivesBlock" hidden>
      <label>Drives</label>
      <ul id="drives"></ul>
    </div>
  </section>
  <p id="error" class="error" role="alert" hidden></p>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const SLOT_LABELS = ${JSON.stringify(SLOT_LABELS)};
  let current = null;

  function send(settings) {
    if (!current) return;
    $("units").disabled = $("always").disabled = true;  // re-enabled by the next state
    vscode.postMessage({ type: "update", id: current.id, settings });
  }
  $("units").addEventListener("change", (e) => send({ unitConversion: e.target.value }));
  $("always").addEventListener("change", (e) => send({ alwaysEvaluate: e.target.checked }));

  window.addEventListener("message", ({ data }) => {
    if (data?.type !== "state") return;
    const { target, expr, connected, error } = data;
    current = expr;
    const ready = !!(target && expr);
    $("empty").hidden = ready || (!!target && !!error);
    $("empty").textContent = !connected ? "Not connected to Maya."
      : target ? "Loading…" : "Select an expression in the tree to see its settings.";
    $("panel").hidden = !ready;
    $("error").hidden = !error;
    $("error").textContent = error || "";
    if (!target || !expr) return;

    const particle = expr.kind === "particle";
    $("title").textContent = particle ? SLOT_LABELS[expr.settings.slot] || expr.settings.slot : expr.id;
    $("owner").textContent = target.object;
    $("exprSettings").hidden = particle;
    $("particleSettings").hidden = !particle;
    if (particle) {
      $("slot").textContent = SLOT_LABELS[expr.settings.slot] || expr.settings.slot;
    } else {
      $("units").value = expr.settings.unitConversion;
      $("always").checked = !!expr.settings.alwaysEvaluate;
      $("units").disabled = $("always").disabled = !connected;
    }
    const list = $("drives");
    list.replaceChildren(...target.drives.map((plug) => {
      const li = document.createElement("li");
      li.textContent = plug;
      return li;
    }));
    $("drivesBlock").hidden = target.drives.length === 0;
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}

const UNIT_LABELS: Record<(typeof UNIT_CONVERSIONS)[number], string> = {
  all: "All",
  none: "None",
  angularOnly: "Angular only",
};

const SLOT_LABELS: Record<string, string> = {
  creation: "Creation",
  runtimeBeforeDynamics: "Runtime before dynamics",
  runtimeAfterDynamics: "Runtime after dynamics",
};

/** Accept only known keys with valid values from the webview. */
export function validate(input: unknown): ExpressionSettings | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const out: ExpressionSettings = {};
  if ("unitConversion" in raw) {
    if (!UNIT_CONVERSIONS.includes(raw.unitConversion as never)) {
      return undefined;
    }
    out.unitConversion = raw.unitConversion as ExpressionSettings["unitConversion"];
  }
  if ("alwaysEvaluate" in raw) {
    if (typeof raw.alwaysEvaluate !== "boolean") {
      return undefined;
    }
    out.alwaysEvaluate = raw.alwaysEvaluate;
  }
  return Object.keys(out).length ? out : undefined;
}
