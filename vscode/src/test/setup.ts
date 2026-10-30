/** Loaded with `node --require`: make `require("vscode")` resolve to the stub. */
import Module = require("module");
import * as path from "path";

const stub = path.join(__dirname, "vscodeStub.js");
const resolve = (Module as unknown as { _resolveFilename: (...args: unknown[]) => string })._resolveFilename;

(Module as unknown as { _resolveFilename: (...args: unknown[]) => string })._resolveFilename = function (
  request: unknown,
  ...rest: unknown[]
) {
  return request === "vscode" ? stub : resolve.call(this, request, ...rest);
};
