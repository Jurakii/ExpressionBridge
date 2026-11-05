import * as vscode from "vscode";
import { ExpressionsChanged, MayaClient, MayaDiagnostic, RpcError } from "./client";

export const SCHEME = "expr-bridge";
const CONFLICT = -32009;
const CONNECT_WAIT_MS = 10_000;
const NOT_FOUND = -32004;

/** `expr-bridge:/<object>/<expressionId>.mel` <-> expression id. */
export function uriFor(object: string, id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(object)}/${encodeURIComponent(id)}.mel` });
}

function idFrom(uri: vscode.Uri): string {
  return parseUri(uri).id;
}

export function parseUri(uri: vscode.Uri): { object: string; id: string } {
  const [, object = "", file = ""] = uri.path.split("/");
  return { object: decodeURIComponent(object), id: decodeURIComponent(file.replace(/\.mel$/, "")) };
}

/**
 * Exposes each Maya expression as an editable virtual file. Saving writes to
 * Maya with the hash read at open time, so a concurrent Maya edit is not
 * silently overwritten.
 */
export class ExpressionFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly hashes = new Map<string, string>(); // hash each open editor is based on
  private readonly versions = new Map<string, { hash: string; mtime: number }>();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly client: MayaClient,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const expr = await this.fetch(uri);
    const mtime = this.mtimeFor(uri, expr.hash);
    return { type: vscode.FileType.File, ctime: 0, mtime, size: this.encoder.encode(expr.text).length };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const expr = await this.fetch(uri);
    this.hashes.set(uri.toString(), expr.hash);
    this.mtimeFor(uri, expr.hash);
    return this.encoder.encode(expr.text);
  }

  /**
   * A modification time that changes only when Maya's content does. VS Code
   * compares it on save to detect edits made elsewhere, so it must be stable.
   */
  private mtimeFor(uri: vscode.Uri, hash: string): number {
    const key = uri.toString();
    const known = this.versions.get(key);
    if (known?.hash === hash) {
      return known.mtime;
    }
    const mtime = Math.max(Date.now(), (known?.mtime ?? 0) + 1);
    this.versions.set(key, { hash, mtime });
    return mtime;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(content);
    try {
      const updated = await this.client.set(idFrom(uri), { text, expectedHash: this.hashes.get(uri.toString()) });
      this.hashes.set(uri.toString(), updated.hash);
      this.mtimeFor(uri, updated.hash);
      this.reportErrors(uri, updated.errors ?? []);
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (err) {
      if (err instanceof RpcError && err.code === CONFLICT) {
        throw vscode.FileSystemError.Unavailable("Changed in Maya since opened. Revert the file to reload it.");
      }
      throw err;
    }
  }

  /**
   * Show Maya's errors on the saved file. The save itself still succeeds: on a
   * syntax error Maya keeps the old text, and the stored hash reflects that.
   */
  private reportErrors(uri: vscode.Uri, errors: MayaDiagnostic[]): void {
    this.diagnostics.set(
      uri,
      errors.map(({ line, message }) => {
        const row = Math.max((line ?? 1) - 1, 0);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(row, 0, row, Number.MAX_SAFE_INTEGER),
          line === null ? `${message} (Maya gave no line number)` : message,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "Maya";
        return diagnostic;
      }),
    );
    if (errors.length) {
      void vscode.window.setStatusBarMessage("$(error) Maya reported an error. The expression may be unchanged.", 5000);
    }
  }

  /** Called after a settings change so open editors pick up the new hash. */
  notifyChanged(uri: vscode.Uri): void {
    this.hashes.delete(uri.toString());
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  /**
   * Apply a Maya push. Open files whose hash differs are reported changed, so
   * VS Code reloads clean editors. A dirty editor keeps its old hash, and its
   * next save is rejected as a conflict instead of overwriting Maya's edit.
   */
  applyRemoteChanges(change: ExpressionsChanged): void {
    const events: vscode.FileChangeEvent[] = [];
    for (const key of this.hashes.keys()) {
      const uri = vscode.Uri.parse(key);
      const id = idFrom(uri);
      if (change.removed.includes(id)) {
        this.hashes.delete(key);
        this.diagnostics.delete(uri);
        events.push({ type: vscode.FileChangeType.Deleted, uri });
      } else if (id in change.changed && change.changed[id] !== this.hashes.get(key)) {
        events.push({ type: vscode.FileChangeType.Changed, uri });
      }
    }
    if (events.length) {
      this.emitter.fire(events);
    }
  }

  private async fetch(uri: vscode.Uri) {
    // Tabs restored at startup are read before the extension has connected.
    await this.client.waitForConnection(CONNECT_WAIT_MS);
    try {
      return await this.client.get(idFrom(uri));
    } catch (err) {
      if (err instanceof RpcError && err.code === NOT_FOUND) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw err;
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("Not supported");
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions("Delete expressions in Maya");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Rename expressions in Maya");
  }
}
