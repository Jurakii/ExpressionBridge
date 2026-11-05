import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";

export const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 30_000;

export interface Session {
  port: number;
  token: string;
  pid: number;
  mayaVersion: string | null;
  protocol: number;
}

export interface ExpressionSummary {
  id: string;
  kind: "expression" | "particle";
  slot?: string;
  drives: string[];
}

export interface ExpressionSettings {
  unitConversion?: "all" | "none" | "angularOnly";
  alwaysEvaluate?: boolean;
  slot?: string;
}

export interface Expression {
  id: string;
  kind: "expression" | "particle";
  language: "mel";
  text: string;
  settings: ExpressionSettings;
  hash: string;
  /** Present on `set` results: what Maya reported while applying the write. */
  errors?: MayaDiagnostic[];
}

export interface MayaDiagnostic {
  line: number | null; // 1-based; null when Maya gave no line
  message: string;
}

export type SceneTree = Record<string, ExpressionSummary[]>;

/** Pushed by Maya as the "expressionsChanged" notification. */
export interface ExpressionsChanged {
  treeChanged: boolean;
  changed: Record<string, string>; // id -> new hash
  removed: string[];
}

/** Pushed by Maya as the "selectionChanged" notification. */
export interface SelectionChanged {
  objects: string[];
}

export class RpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export function sessionFilePath(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "ExpressionBridge", "session.json");
}

/**
 * Newline-delimited JSON-RPC 2.0 client for the Maya bridge.
 * Emits "state" (connected: boolean) and one event per Maya notification method.
 */
export class MayaClient extends EventEmitter {
  private socket?: net.Socket;
  private session?: Session;
  private ready = false; // the ping succeeded, so "state" true has been emitted
  private buffer = "";
  private nextId = 1;
  private connectAttempt = 0;
  private pending = new Map<number, Pending>();

  constructor(private readonly timeoutMs = REQUEST_TIMEOUT_MS) {
    super();
  }

  get connected(): boolean {
    return this.ready;
  }

  /**
   * Resolve once connected, or reject after `timeoutMs`. Lets editors that VS Code
   * restores at startup wait for the first connection instead of failing.
   */
  waitForConnection(timeoutMs: number): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onState = (connected: boolean) => {
        if (connected) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Not connected to Maya. Is Maya open with the Expression Bridge running?"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("state", onState);
      };
      this.on("state", onState);
    });
  }

  async connect(): Promise<Session> {
    const attempt = ++this.connectAttempt;
    this.disconnect();
    const file = sessionFilePath();
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      throw new Error(`Maya's bridge isn't running (no ${file}). Start it from Maya's Expression Bridge menu.`);
    }
    const session = JSON.parse(raw) as Session;
    if (session.protocol !== PROTOCOL_VERSION) {
      throw new Error(`Maya bridge protocol ${session.protocol} is not supported (expected ${PROTOCOL_VERSION})`);
    }
    if (attempt !== this.connectAttempt) {
      throw new Error("Connection to Maya closed"); // a newer connect() took over during the read
    }

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: session.port }, () => resolve(socket));
      socket.setEncoding("utf8");
      socket.on("error", reject); // Node closes the socket after an error, so "close" cleans up
      socket.on("data", (chunk: string) => this.onData(socket, chunk));
      socket.on("close", () => {
        reject(new Error("Connection to Maya closed")); // a newer connect() replaced this one
        this.onClose(socket);
      });
      this.socket = socket;
    });
    this.session = session;
    try {
      await this.request("ping");
    } catch (err) {
      this.onClose(socket);
      socket.destroy();
      throw err;
    }
    this.ready = true;
    this.emit("state", true);
    return session;
  }

  disconnect(): void {
    const socket = this.socket;
    if (socket) {
      this.onClose(socket);
      socket.destroy();
    }
  }

  list(): Promise<SceneTree> {
    return this.request("list") as Promise<SceneTree>;
  }

  get(id: string): Promise<Expression> {
    return this.request("get", { id }) as Promise<Expression>;
  }

  set(id: string, change: { text?: string; settings?: ExpressionSettings; expectedHash?: string }): Promise<Expression> {
    return this.request("set", { id, ...change }) as Promise<Expression>;
  }

  select(object: string): Promise<void> {
    return this.request("select", { object }) as Promise<void>;
  }

  private request(method: string, params: object = {}): Promise<unknown> {
    if (!this.socket || !this.session) {
      return Promise.reject(new Error("Not connected to Maya"));
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params, token: this.session.token };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Maya did not answer "${method}" in time (is it busy?)`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify(message) + "\n");
    });
  }

  private onData(socket: net.Socket, chunk: string): void {
    if (socket !== this.socket) {
      return;
    }
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        this.onMessage(line);
      }
    }
  }

  private onMessage(line: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined && message.method) {
      this.emit(message.method, message.params);
      return;
    }
    const pending = message.id !== undefined ? this.pending.get(message.id) : undefined;
    if (!pending) {
      return;
    }
    this.pending.delete(message.id!);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new RpcError(message.error.code, message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  /** Runs once per socket. A replaced socket's late "close" must not touch the new one. */
  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) {
      return;
    }
    this.socket = undefined;
    this.session = undefined;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Connection to Maya closed"));
    }
    this.pending.clear();
    this.buffer = "";
    if (this.ready) {
      this.ready = false;
      this.emit("state", false);
    }
  }
}
