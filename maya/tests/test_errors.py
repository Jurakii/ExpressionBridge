"""Parsing of error text exactly as Maya 2026 produced it (captured with mayapy)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ExpressionBridge" / "scripts"))

from expression_bridge.errors import Collector, to_diagnostic  # noqa: E402


def parse(raised, source):
    collector = Collector(source)
    collector.add(raised)
    return collector.diagnostics()


class MayaErrorTextTests(unittest.TestCase):
    def test_syntax_error_on_first_line(self):
        raised = "}\nLine 0.14: Syntax error\nExpression invalid after edit.\n"
        self.assertEqual(parse(raised, "pCube1.ty = ;"), [{"line": 1, "message": "Syntax error"}])

    def test_syntax_error_on_third_line_drops_source_echo(self):
        source = "float $a = 1;\nfloat $b = 2;\n   $c = = 3;"
        raised = "   $c = = 3;\nLine 2.9: Syntax error\nExpression invalid after edit.\n"
        self.assertEqual(parse(raised, source), [{"line": 3, "message": "Syntax error"}])

    def test_undeclared_variable(self):
        raised = '}\nLine 0.19: "$nope" is an undeclared variable.\nExpression invalid after edit.\n'
        self.assertEqual(parse(raised, "pCube1.ty = $nope;"),
                         [{"line": 1, "message": '"$nope" is an undeclared variable.'}])

    def test_missing_attribute_has_no_line(self):
        raised = "Attribute not found or variable missing '$':  pCube1.notAnAttr\nExpression invalid after edit.\n"
        self.assertEqual(parse(raised, "pCube1.notAnAttr = 1;"),
                         [{"line": None, "message": "Attribute not found or variable missing '$':  pCube1.notAnAttr"}])

    def test_runtime_error_messages_from_callback(self):
        collector = Collector("a;\nb;\nerror \"boom\";")
        for message in ["line 2: boom", "An execution error occured in the expression expr1.",
                        "line 2: boom", "An execution error occured in the expression expr1."]:
            collector.add(message)
        self.assertEqual(collector.diagnostics(), [{"line": 3, "message": "boom"}])

    def test_only_noise_still_reports_something(self):
        collector = Collector("x;")
        collector.add("Expression invalid after edit.")
        self.assertEqual(collector.diagnostics(), [{"line": None, "message": "Expression invalid after edit."}])

    def test_script_editor_prefix_is_stripped(self):
        self.assertEqual(to_diagnostic("// Error: line 4: boom //"), {"line": 5, "message": "boom"})


if __name__ == "__main__":
    unittest.main()
