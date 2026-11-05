import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { expandEnv, findModulesDir, installModule, modText, readModuleVersion, uninstallModule } from "../install";

let root: string;
let source: string;

/** A fake bundled module with the same layout as maya/ExpressionBridge. */
function makeSource(dir: string, version: string): void {
  const pkg = path.join(dir, "scripts", "expression_bridge");
  fs.mkdirSync(path.join(pkg, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "__init__.py"), `__version__ = "${version}"\n`);
  fs.writeFileSync(path.join(dir, "scripts", "userSetup.py"), "# setup\n");
  fs.writeFileSync(path.join(pkg, "__pycache__", "x.pyc"), "");
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mayaexpr-install-"));
  source = path.join(root, "bundle");
  makeSource(source, "1.2.3");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("module version and .mod text", () => {
  it("reads __version__ from the bundled package", () => {
    assert.equal(readModuleVersion(source), "1.2.3");
  });

  it("writes a .mod that points at the folder next to it", () => {
    assert.equal(modText("1.2.3"), "+ ExpressionBridge 1.2.3 ./ExpressionBridge\r\nscripts: scripts\r\n");
  });
});

describe("findModulesDir", () => {
  it("honors MAYA_APP_DIR", () => {
    assert.equal(findModulesDir({ MAYA_APP_DIR: "D:\\maya" }, () => "X:\\unused"), path.join("D:\\maya", "modules"));
  });

  it("uses the registry Documents folder on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }
    assert.equal(findModulesDir({}, () => "D:\\OneDrive\\Documents"), path.join("D:\\OneDrive\\Documents", "maya", "modules"));
  });
});

describe("expandEnv", () => {
  it("expands every known variable and leaves unknown ones", () => {
    const env = { USERPROFILE: "C:\\Users\\a", OneDrive: "D:\\OD" };
    assert.equal(expandEnv("%USERPROFILE%\\Documents", env), "C:\\Users\\a\\Documents");
    assert.equal(expandEnv("%OneDrive%\\Docs", env), "D:\\OD\\Docs");
    assert.equal(expandEnv("%NOPE%\\Docs", env), "%NOPE%\\Docs");
  });
});

describe("installModule / uninstallModule", () => {
  it("copies the module without caches and writes the .mod file", () => {
    const modules = path.join(root, "install-1", "modules");
    const { target, modFile, version } = installModule(source, modules);

    assert.equal(version, "1.2.3");
    assert.ok(fs.existsSync(path.join(target, "scripts", "userSetup.py")));
    assert.ok(!fs.existsSync(path.join(target, "scripts", "expression_bridge", "__pycache__")));
    assert.equal(fs.readFileSync(modFile, "utf-8"), modText("1.2.3"));
  });

  it("replaces an older copy instead of merging with it", () => {
    const modules = path.join(root, "install-2", "modules");
    installModule(source, modules);
    fs.writeFileSync(path.join(modules, "ExpressionBridge", "stale.py"), "old");

    installModule(source, modules);
    assert.ok(!fs.existsSync(path.join(modules, "ExpressionBridge", "stale.py")));
  });

  it("uninstall removes both parts and reports what it found", () => {
    const modules = path.join(root, "install-3", "modules");
    assert.equal(uninstallModule(modules), false);

    installModule(source, modules);
    assert.equal(uninstallModule(modules), true);
    assert.deepEqual(fs.readdirSync(modules), []);
  });
});
