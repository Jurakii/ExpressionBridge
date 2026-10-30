/**
 * Launch a real VS Code with this extension and run `suite.ts` inside it.
 *
 * Uses an installed VS Code when VSCODE_EXECUTABLE (or the default per-user
 * Windows install) exists, otherwise test-electron downloads one. The profile,
 * extensions folder and LOCALAPPDATA are throwaway temp folders, so the user's
 * own VS Code and any running Maya session are untouched.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

function installedVsCode(): string | undefined {
  const candidates = [
    process.env.VSCODE_EXECUTABLE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
  ];
  return candidates.find((p): p is string => !!p && fs.existsSync(p));
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maya-expr-it-"));
  try {
    await runTests({
      vscodeExecutablePath: installedVsCode(),
      extensionDevelopmentPath: path.resolve(__dirname, "..", ".."),
      extensionTestsPath: path.resolve(__dirname, "suite"),
      launchArgs: [
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        `--user-data-dir=${path.join(tmp, "user")}`,
        `--extensions-dir=${path.join(tmp, "extensions")}`,
      ],
      extensionTestsEnv: { LOCALAPPDATA: path.join(tmp, "appdata"), MAYA_EXPR_TEST: "1" },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
