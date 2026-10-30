import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { MayaClient, RpcError } from "../client";

const TOKEN = "test-token";

type Reply = (req: { id: number; method: string; params: Record<string, unknown>; token: string }) => unknown;

/** A fake bridge server speaking newline-delimited JSON-RPC. */
class FakeBridge {
  server = net.createServer((socket) => this.onSocket(socket));
  sockets: net.Socket[] = [];
  requests: { method: string; token: string }[] = [];
  reply: Reply = (req) => ({ jsonrpc: "2.0", id: req.id, result: { echo: req.method } });

  listen(): Promise<number> {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () =>
      resolve((this.server.address() as net.AddressInfo).port)));
  }

  push(method: string, params: unknown): void {
    this.sockets.forEach((s) => s.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"));
  }

  close(): Promise<void> {
    this.sockets.forEach((s) => s.destroy());
    return new Promise((resolve) => this.server.close(() => resolve()));
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
        this.requests.push(req);
        const response = this.reply(req);
        if (response !== undefined) {
          // Split the write to prove the client reassembles lines.
          const text = JSON.stringify(response) + "\n";
          socket.write(text.slice(0, 5));
          setImmediate(() => socket.write(text.slice(5)));
        }
      }
    });
  }
}

describe("MayaClient", () => {
  let tmp: string;
  let bridge: FakeBridge;
  let client: MayaClient;
  const oldAppData = process.env.LOCALAPPDATA;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maya-expr-"));
    process.env.LOCALAPPDATA = tmp;
  });

  after(() => {
    process.env.LOCALAPPDATA = oldAppData;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writeSession = (port: number, protocol = 1) => {
    fs.mkdirSync(path.join(tmp, "MayaExpressionBridge"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "MayaExpressionBridge", "session.json"),
      JSON.stringify({ port, token: TOKEN, pid: 1, mayaVersion: "2026", protocol }));
  };

  beforeEach(async () => {
    bridge = new FakeBridge();
    writeSession(await bridge.listen());
    client = new MayaClient(200);
  });

  afterEach(async () => {
    client.disconnect();
    await bridge.close();
  });

  it("connects, pings and sends the token on every request", async () => {
    const states: boolean[] = [];
    client.on("state", (s: boolean) => states.push(s));
    await client.connect();
    await client.list();
    assert.deepEqual(bridge.requests.map((r) => r.method), ["ping", "list"]);
    assert.ok(bridge.requests.every((r) => r.token === TOKEN));
    assert.deepEqual(states, [true]);
  });

  it("rejects an unsupported protocol version", async () => {
    writeSession((bridge.server.address() as net.AddressInfo).port, 99);
    await assert.rejects(client.connect(), /protocol 99/);
  });

  it("maps JSON-RPC errors to RpcError with the code", async () => {
    await client.connect();
    bridge.reply = (req) => ({ jsonrpc: "2.0", id: req.id, error: { code: -32009, message: "conflict" } });
    await assert.rejects(client.get("expr1"), (err: unknown) => err instanceof RpcError && err.code === -32009);
  });

  it("emits notifications by method name", async () => {
    await client.connect();
    const got = new Promise((resolve) => client.once("selectionChanged", resolve));
    bridge.push("selectionChanged", { objects: ["pCube1"] });
    assert.deepEqual(await got, { objects: ["pCube1"] });
  });

  it("times out a request Maya never answers", async () => {
    await client.connect();
    bridge.reply = () => undefined;
    await assert.rejects(client.list(), /did not answer "list"/);
  });

  it("rejects pending requests and reports disconnect when the socket closes", async () => {
    await client.connect();
    bridge.reply = () => undefined;
    const states: boolean[] = [];
    client.on("state", (s: boolean) => states.push(s));
    const pending = client.list();
    bridge.sockets.forEach((s) => s.destroy());
    await assert.rejects(pending, /Connection to Maya closed/);
    assert.deepEqual(states, [false]);
    assert.equal(client.connected, false);
  });

  it("waitForConnection resolves when a connection arrives", async () => {
    const waiting = client.waitForConnection(2000);
    await client.connect();
    await waiting;
  });

  it("waitForConnection gives up with a clear message", async () => {
    await assert.rejects(client.waitForConnection(50), /Not connected to Maya/);
    assert.equal(client.listenerCount("state"), 0, "no leaked listener");
  });

  it("refuses requests while disconnected", async () => {
    await assert.rejects(client.list(), /Not connected/);
  });
});
