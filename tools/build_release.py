"""Build the release zip: dist/ExpressionBridge-<version>.zip

    python tools/build_release.py [--skip-vsix]

Layout of the zip:
    ExpressionBridge-<version>/
        Install.bat, Uninstall.bat, INSTALL.md, LICENSE
        installer/install.ps1
        maya/ExpressionBridge/...        (the Maya module)
        maya/drag_and_drop_install.py
        vscode/expression-bridge-<version>.vsix
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc")


def maya_version():
    init = ROOT / "maya" / "ExpressionBridge" / "scripts" / "expression_bridge" / "__init__.py"
    for line in init.read_text(encoding="utf-8").splitlines():
        if line.startswith("__version__"):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"No __version__ in {init}")


def extension_version():
    return json.loads((ROOT / "vscode" / "package.json").read_text(encoding="utf-8"))["version"]


def build_vsix():
    # shell=True so Windows finds npm.cmd.
    subprocess.run("npm run package", cwd=ROOT / "vscode", shell=True, check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-vsix", action="store_true", help="reuse the already built VSIX")
    args = parser.parse_args(argv)

    version = maya_version()
    if version != extension_version():
        raise SystemExit(f"Version mismatch: Maya module {version}, VS Code extension {extension_version()}. "
                         "Update maya/.../expression_bridge/__init__.py and vscode/package.json together.")
    if not args.skip_vsix:
        build_vsix()
    vsix = ROOT / "vscode" / f"expression-bridge-{version}.vsix"
    if not vsix.exists():
        raise SystemExit(f"Missing {vsix}")

    name = f"ExpressionBridge-{version}"
    stage = DIST / name
    if stage.exists():
        shutil.rmtree(stage)
    (stage / "installer").mkdir(parents=True)
    (stage / "maya").mkdir()
    (stage / "vscode").mkdir()

    shutil.copy2(ROOT / "installer" / "Install.bat", stage)
    shutil.copy2(ROOT / "installer" / "Uninstall.bat", stage)
    shutil.copy2(ROOT / "installer" / "install.ps1", stage / "installer")
    shutil.copy2(ROOT / "INSTALL.md", stage)
    shutil.copy2(ROOT / "LICENSE", stage)
    shutil.copytree(ROOT / "maya" / "ExpressionBridge", stage / "maya" / "ExpressionBridge", ignore=IGNORE)
    shutil.copy2(ROOT / "maya" / "drag_and_drop_install.py", stage / "maya")
    shutil.copy2(vsix, stage / "vscode")

    archive = DIST / f"{name}.zip"
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(stage.rglob("*")):
            if path.is_file():
                zf.write(path, Path(name) / path.relative_to(stage))

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (DIST / f"{name}.zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    files = sum(1 for p in stage.rglob("*") if p.is_file())
    print(f"Built {archive} ({files} files, {archive.stat().st_size // 1024} KB)\nSHA-256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
