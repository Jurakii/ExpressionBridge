import { Expression, ExpressionSettings, MayaClient, RpcError } from "../client";

/** In-memory MayaClient: same surface, no socket. */
export class FakeClient {
  connected = true;
  exprs = new Map<string, Expression>();
  sets: { id: string; change: unknown }[] = [];
  failNextSet?: RpcError;
  errorsOnSet: Expression["errors"] = [];
  delayGet = new Map<string, Promise<void>>();

  add(id: string, text = "x;", settings: ExpressionSettings = { unitConversion: "all", alwaysEvaluate: true }) {
    this.exprs.set(id, { id, kind: "expression", language: "mel", text, settings, hash: `h-${text}` });
    return this;
  }

  connectWaits = 0;

  async waitForConnection(): Promise<void> {
    this.connectWaits++;
    if (!this.connected) {
      throw new Error("Not connected to Maya.");
    }
  }

  async get(id: string): Promise<Expression> {
    await this.delayGet.get(id);
    const expr = this.exprs.get(id);
    if (!expr) {
      throw new RpcError(-32004, `No such expression: ${id}`);
    }
    return { ...expr, settings: { ...expr.settings } };
  }

  async set(id: string, change: { text?: string; settings?: ExpressionSettings; expectedHash?: string }) {
    this.sets.push({ id, change });
    if (this.failNextSet) {
      const err = this.failNextSet;
      this.failNextSet = undefined;
      throw err;
    }
    const expr = this.exprs.get(id)!;
    if (change.expectedHash && change.expectedHash !== expr.hash) {
      throw new RpcError(-32009, "conflict");
    }
    if (change.text !== undefined) {
      expr.text = change.text;
      expr.hash = `h-${change.text}`;
    }
    Object.assign(expr.settings, change.settings);
    return { ...expr, errors: this.errorsOnSet };
  }

  asClient(): MayaClient {
    return this as unknown as MayaClient;
  }
}
