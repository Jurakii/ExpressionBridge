import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, IGrammar, Registry, StateStack, parseRawGrammar } from "vscode-textmate";

const root = path.join(__dirname, "..", "..");
let grammar: IGrammar;

before(async () => {
  const wasm = fs.readFileSync(path.join(root, "node_modules", "vscode-oniguruma", "release", "onig.wasm"));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope) => {
      if (scope !== "source.mel") {
        return null;
      }
      const file = path.join(root, "syntaxes", "mel.tmLanguage.json");
      return parseRawGrammar(fs.readFileSync(file, "utf8"), file);
    },
  });
  grammar = (await registry.loadGrammar("source.mel"))!;
});

/** Tokenize `source` (may span lines) and return the scopes at the first occurrence of `needle`. */
function scopesOf(source: string, needle: string, occurrence = 0): string[] {
  let stack: StateStack = INITIAL;
  let seen = 0;
  for (const line of source.split("\n")) {
    const { tokens, ruleStack } = grammar.tokenizeLine(line, stack);
    stack = ruleStack;
    let from = 0;
    let at: number;
    while ((at = line.indexOf(needle, from)) >= 0) {
      if (seen++ === occurrence) {
        const token = tokens.find((t) => t.startIndex <= at && at < t.endIndex)!;
        return token.scopes;
      }
      from = at + 1;
    }
  }
  throw new Error(`"${needle}" not found`);
}

function hasScope(source: string, needle: string, scope: string, occurrence = 0): void {
  const scopes = scopesOf(source, needle, occurrence);
  assert.ok(scopes.some((s) => s.startsWith(scope)), `"${needle}" scopes ${JSON.stringify(scopes)} lack ${scope}`);
}

function lacksScope(source: string, needle: string, scope: string, occurrence = 0): void {
  const scopes = scopesOf(source, needle, occurrence);
  assert.ok(!scopes.some((s) => s.startsWith(scope)), `"${needle}" unexpectedly has ${scope}`);
}

describe("MEL grammar", () => {
  it("highlights a typical expression", () => {
    const src = "pCube1.translateY = sin(time) * 2.5; // bounce";
    hasScope(src, "pCube1", "entity.name.type.node");
    hasScope(src, ".translateY", "variable.other.member.attribute");
    hasScope(src, "sin", "entity.name.function.call");
    hasScope(src, "time", "variable.language");
    hasScope(src, "2.5", "constant.numeric.decimal");
    hasScope(src, "bounce", "comment.line.double-slash");
  });

  it("handles DAG paths, namespaces and indexed attributes", () => {
    hasScope("|grp|rig:ctrl.rotateX = 0;", "|grp|rig:ctrl", "entity.name.type.node");
    hasScope("obj.pnts[0].x = 1;", ".pnts[0].x", "variable.other.member.attribute");
  });

  it("highlights declarations, variables and control flow", () => {
    const src = "global proc float[] getVals(string $node) { if ($node == \"\") return {}; }";
    hasScope(src, "global", "storage.modifier");
    hasScope(src, "proc", "storage.type.function");
    hasScope(src, "float", "storage.type");
    hasScope(src, "getVals", "entity.name.function");
    hasScope(src, "$node", "variable.other");
    hasScope(src, "if", "keyword.control");
    hasScope(src, "==", "keyword.operator.comparison");
  });

  it("treats flags as flags but subtraction as an operator", () => {
    hasScope("setAttr -type \"string\" $a $b;", "-type", "variable.parameter.flag");
    lacksScope("$x = $a - $b;", "-", "variable.parameter.flag");
    hasScope("$x = $a - $b;", "-", "keyword.operator.arithmetic");
    lacksScope("$x = $a-$b;", "-", "variable.parameter.flag");
  });

  it("does not highlight inside strings, and handles escapes", () => {
    const src = 'print "time is \\"now\\" for pCube1.tx";';
    hasScope(src, "time", "string.quoted.double");
    lacksScope(src, "time", "variable.language");
    hasScope(src, '\\"', "constant.character.escape");
    lacksScope(src, "pCube1", "entity.name.type.node");
  });

  it("keeps block comments open across lines", () => {
    const src = "/* first\n$notAVar = 1;\n*/ $real = 2;";
    hasScope(src, "$notAVar", "comment.block");
    hasScope(src, "$real", "variable.other");
    lacksScope(src, "$real", "comment.block");
  });

  it("highlights vectors and command substitution", () => {
    const src = "vector $v = <<1, 2.0, -3>>; string $sel[] = `ls -sl`;";
    hasScope(src, "<<", "punctuation.definition.vector.begin");
    hasScope(src, "2.0", "meta.vector");
    hasScope(src, "-sl", "variable.parameter.flag");
    hasScope(src, "-sl", "meta.embedded.command");
  });

  it("does not treat `time` as the builtin when called as a function", () => {
    lacksScope("time();", "time", "variable.language");
  });

  it("does not mark numbers inside identifiers", () => {
    lacksScope("$a1 = pCube1.tx;", "1", "constant.numeric");
  });
});
