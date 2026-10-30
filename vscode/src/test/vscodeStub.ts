/**
 * The small slice of the `vscode` API the extension's modules use, so unit
 * tests run under plain Node. `setup.ts` routes `require("vscode")` here.
 */
export class Uri {
  private constructor(readonly scheme: string, readonly path: string) {}

  static from({ scheme, path }: { scheme: string; path: string }): Uri {
    return new Uri(scheme, path);
  }

  static parse(value: string): Uri {
    const colon = value.indexOf(":");
    return new Uri(value.slice(0, colon), value.slice(colon + 1));
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return new Disposable(() => (this.listeners = this.listeners.filter((l) => l !== listener)));
  };
  fire(e: T): void {
    this.listeners.forEach((l) => l(e));
  }
}

export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn();
  }
}

export class FileSystemError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
  static FileNotFound(uri?: Uri): FileSystemError {
    return new FileSystemError(String(uri), "FileNotFound");
  }
  static Unavailable(message: string): FileSystemError {
    return new FileSystemError(message, "Unavailable");
  }
  static NoPermissions(message: string): FileSystemError {
    return new FileSystemError(message, "NoPermissions");
  }
}

export enum FileType { File = 1 }
export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }
export enum DiagnosticSeverity { Error = 0 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1 }

export class Range {
  constructor(readonly startLine: number, readonly startCharacter: number,
    readonly endLine: number, readonly endCharacter: number) {}
}

export class Diagnostic {
  source?: string;
  constructor(readonly range: Range, readonly message: string, readonly severity: DiagnosticSeverity) {}
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class TreeItem {
  id?: string;
  contextValue?: string;
  description?: string;
  tooltip?: string;
  iconPath?: ThemeIcon;
  resourceUri?: Uri;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(readonly label: string, readonly collapsibleState = TreeItemCollapsibleState.None) {}
}

export const window = {
  statusMessages: [] as string[],
  setStatusBarMessage(text: string) {
    window.statusMessages.push(text);
    return new Disposable(() => undefined);
  },
};

/** In-memory DiagnosticCollection for assertions. */
export class FakeDiagnostics {
  readonly entries = new Map<string, Diagnostic[]>();
  set(uri: Uri, diagnostics: Diagnostic[]): void {
    this.entries.set(uri.toString(), diagnostics);
  }
  delete(uri: Uri): void {
    this.entries.delete(uri.toString());
  }
}
