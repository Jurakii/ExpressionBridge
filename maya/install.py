"""Install the Maya module.

Maya only reads `.mod` files at the top level of each MAYA_MODULE_PATH folder,
so this writes `MayaExpressionBridge.mod` there.

    python install.py            # link: .mod points at this checkout (for development)
    python install.py --copy     # copy the package into the modules folder
    python install.py --uninstall
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

NAME = "MayaExpressionBridge"
SOURCE = Path(__file__).resolve().parent / NAME


def _read_version():
    init = SOURCE / "scripts" / "expression_bridge" / "__init__.py"
    for line in init.read_text(encoding="utf-8").splitlines():
        if line.startswith("__version__"):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError(f"No __version__ in {init}")


VERSION = _read_version()


def default_modules_dir():
    app_dir = os.environ.get("MAYA_APP_DIR")
    if app_dir:
        return Path(app_dir) / "modules"
    return _documents_dir() / "maya" / "modules"


def _documents_dir():
    """The real Documents folder, which may be redirected (e.g. to OneDrive), as Maya uses it."""
    if sys.platform != "win32":
        return Path.home()
    import ctypes
    buf = ctypes.create_unicode_buffer(260)
    if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0:  # CSIDL_PERSONAL
        return Path(buf.value)
    return Path.home() / "Documents"


def mod_text(package_path):
    # Relative paths in a .mod file resolve against the .mod file's folder.
    return f"+ {NAME} {VERSION} {package_path}\nscripts: scripts\n"


def install(modules_dir, copy):
    modules_dir.mkdir(parents=True, exist_ok=True)
    target = modules_dir / NAME
    if copy:
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(SOURCE, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        package_path = f"./{NAME}"
    else:
        package_path = str(SOURCE)
    mod_file = modules_dir / f"{NAME}.mod"
    mod_file.write_text(mod_text(package_path), encoding="utf-8")
    return mod_file


def uninstall(modules_dir):
    (modules_dir / f"{NAME}.mod").unlink(missing_ok=True)
    shutil.rmtree(modules_dir / NAME, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--modules-dir", type=Path, default=default_modules_dir())
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--copy", action="store_true", help="copy the package instead of linking")
    group.add_argument("--uninstall", action="store_true")
    args = parser.parse_args(argv)

    if args.uninstall:
        uninstall(args.modules_dir)
        print(f"Removed {NAME} from {args.modules_dir}")
    else:
        mod_file = install(args.modules_dir, args.copy)
        print(f"Wrote {mod_file}. Restart Maya to load the bridge.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
