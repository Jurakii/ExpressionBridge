import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import install  # noqa: E402


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.modules = Path(self.tmp.name) / "modules"

    def tearDown(self):
        self.tmp.cleanup()

    def test_link_points_at_checkout(self):
        mod = install.install(self.modules, copy=False)
        self.assertEqual(mod.parent, self.modules)
        self.assertIn(str(install.SOURCE), mod.read_text())
        self.assertFalse((self.modules / install.NAME).exists())

    def test_copy_is_self_contained(self):
        mod = install.install(self.modules, copy=True)
        self.assertIn(f"./{install.NAME}", mod.read_text())
        pkg = self.modules / install.NAME / "scripts" / "expression_bridge"
        self.assertTrue((pkg / "server.py").exists())
        self.assertFalse(list(pkg.rglob("__pycache__")))
        self.assertTrue((self.modules / install.NAME / "scripts" / "userSetup.py").exists())

    def test_uninstall(self):
        install.install(self.modules, copy=True)
        install.uninstall(self.modules)
        self.assertEqual(list(self.modules.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
