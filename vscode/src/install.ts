import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MODULE_NAME = "MayaExpressionBridge";

/** Reads `__version__ = "x.y.z"` from the bundled Maya package. */
export function readModuleVersion(moduleSource: string): string {
  const init = path.join(moduleSource, "scripts", "expression_bridge", "__init__.py");
  const match = /^__version__\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(init, "utf-8"));
  if (!match) {
    throw new Error(`No __version__ in ${init}`);
  }
  return match[1];
}

/** Text of `MayaExpressionBridge.mod`. Relative paths resolve against the .mod file's folder. */
export function modText(version: string): string {
  return `+ ${MODULE_NAME} ${version} ./${MODULE_NAME}\r\nscripts: scripts\r\n`;
}

/** Documents folder as the Windows registry knows it, so OneDrive redirection is followed. */
export function documentsFromRegistry(): string | undefined {
  try {
    const out = cp.execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders", "/v", "Personal"],
      { encoding: "utf-8", windowsHide: true },
    );
    const match = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(out);
    return match ? match[1].trim().replace(/%USERPROFILE%/i, os.homedir()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maya's modules folder, chosen as Maya chooses it: MAYA_APP_DIR, else Documents\maya\modules.
 * `documents` is injected so tests don't touch the registry.
 */
export function findModulesDir(
  env: NodeJS.ProcessEnv = process.env,
  documents: () => string | undefined = documentsFromRegistry,
): string {
  if (env.MAYA_APP_DIR) {
    return path.join(env.MAYA_APP_DIR, "modules");
  }
  const docs = process.platform === "win32" ? documents() : undefined;
  return path.join(docs ?? path.join(os.homedir(), "Documents"), "maya", "modules");
}

/** Copies the bundled module into `modulesDir` and writes its .mod file, replacing any older copy. */
export function installModule(moduleSource: string, modulesDir: string): { target: string; modFile: string; version: string } {
  const version = readModuleVersion(moduleSource);
  const target = path.join(modulesDir, MODULE_NAME);
  fs.mkdirSync(modulesDir, { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(moduleSource, target, {
    recursive: true,
    filter: (src) => !src.includes("__pycache__") && !src.endsWith(".pyc"),
  });
  const modFile = path.join(modulesDir, `${MODULE_NAME}.mod`);
  fs.writeFileSync(modFile, modText(version), "utf-8");
  return { target, modFile, version };
}

/** Removes the module folder and .mod file. Returns false if nothing was installed. */
export function uninstallModule(modulesDir: string): boolean {
  const paths = [path.join(modulesDir, `${MODULE_NAME}.mod`), path.join(modulesDir, MODULE_NAME)];
  const present = paths.filter((p) => fs.existsSync(p));
  for (const p of present) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  return present.length > 0;
}
