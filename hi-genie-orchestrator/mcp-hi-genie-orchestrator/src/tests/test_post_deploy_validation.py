"""
Widget Initialization Test — post_deploy_validation.py

post_deploy_validation.py is a Databricks notebook: importing it directly
would execute top-level network/auth side effects (SPN OAuth token
acquisition, app URL lookup) that don't run outside a real Databricks
workspace. This test instead extracts the actual `_widget` function
definition via AST (so it tests the real source, not a copy) and execs it
against fake `dbutils` objects shaped like the real Databricks runtime API,
to prove the widget-resolution logic is correct without needing a live
workspace.

Background: dbutils.widgets.getAll() returns a dict[str, str] of widget
name -> value (Scala: Map[String, String]) — NOT an iterable of objects
with a `.name` attribute. The pre-fix code did
`[w.name for w in dbutils.widgets.getAll()]`, which iterates the dict's
*keys* (already strings) and then reads `.name` on each string, raising
AttributeError before any validation could run. This test proves the fixed
`_widget()` (using `dbutils.widgets.getArgument(name, default)`) works
against the real API shape, using a fake dbutils.widgets whose `getAll()`
returns a plain dict and whose `get()` raises for undefined widgets
(matching the real runtime's InputWidgetNotDefined behavior) — so a
regression back to the old getAll()-iteration pattern would be caught by
this test raising AttributeError/TypeError.

Run directly: python3 src/tests/test_post_deploy_validation.py
"""

import ast
import pathlib
import unittest


NOTEBOOK_PATH = pathlib.Path(__file__).parent / "post_deploy_validation.py"


def _extract_widget_setup() -> str:
    """Extract every top-level statement from the start of the notebook up
    to and including the `_widget` function definition, via AST — so this
    test execs the actual notebook source (including any module-level
    setup the function depends on, like the old buggy `_widget_names`
    list-comprehension) rather than a hand-copied duplicate that could
    silently drift out of sync with it or omit the exact statement that
    caused the original bug."""
    source = NOTEBOOK_PATH.read_text()
    tree = ast.parse(source)
    end_line = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_widget":
            end_line = node.end_lineno
            break
    if end_line is None:
        raise AssertionError(f"_widget() function not found in {NOTEBOOK_PATH}")
    lines = source.splitlines()
    return "\n".join(lines[:end_line])


class FakeWidgetNotDefined(Exception):
    """Mirrors the real dbutils.widgets.InputWidgetNotDefined exception raised
    by dbutils.widgets.get() when a widget was never created."""


class FakeWidgets:
    """Models the real Databricks notebook widgets API shape closely enough
    to catch the getAll()-iteration bug: getAll() returns dict[str, str];
    get() raises for undefined widgets; getArgument() returns a default
    instead of raising."""

    def __init__(self, values: dict):
        self._values = dict(values)

    def getAll(self) -> dict:
        return dict(self._values)

    def get(self, name: str) -> str:
        if name not in self._values:
            raise FakeWidgetNotDefined(f"No input widget named {name!r} is defined")
        return self._values[name]

    def getArgument(self, name: str, default: str = None) -> str:
        return self._values.get(name, default)


class FakeDbutils:
    def __init__(self, widget_values: dict):
        self.widgets = FakeWidgets(widget_values)


class WidgetResolutionTest(unittest.TestCase):
    def _run_widget(self, widget_values: dict, name: str, default: str) -> str:
        """Exec the real notebook source (from the top through the end of
        the _widget function def) with a fake dbutils injected as a
        module-level global — exactly how the Databricks runtime injects
        dbutils as an implicit global — then call the resulting _widget()."""
        namespace = {"dbutils": FakeDbutils(widget_values)}
        exec(_extract_widget_setup(), namespace)  # noqa: S102 - intentional, testing extracted source
        return namespace["_widget"](name, default)

    def test_returns_the_job_provided_value_when_the_widget_exists(self):
        # Simulates resources/post_deploy_tests.job.yml's notebook_task
        # base_parameters, which Databricks Jobs auto-creates as widgets.
        result = self._run_widget(
            {"app_name": "mcp-hi-genie-orchestrator-dev"},
            "app_name",
            "some-default",
        )
        self.assertEqual(result, "mcp-hi-genie-orchestrator-dev")

    def test_returns_the_default_when_the_widget_does_not_exist(self):
        # Simulates an interactive/ad-hoc notebook run with no job
        # base_parameters at all — no widgets exist.
        result = self._run_widget({}, "app_name", "mcp-hi-genie-orchestrator-dev")
        self.assertEqual(result, "mcp-hi-genie-orchestrator-dev")

    def test_returns_the_default_for_one_missing_widget_while_others_are_present(self):
        # The exact regression scenario: only some base_parameters keys are
        # set (e.g. only app_name from an older job definition), others must
        # still safely fall back to their defaults rather than raising.
        result = self._run_widget(
            {"app_name": "mcp-hi-genie-orchestrator-dev"},
            "secret_scope_name",
            "hi_genie_credentials",
        )
        self.assertEqual(result, "hi_genie_credentials")

    def test_does_not_call_dbutils_widgets_get_or_getAll_in_a_way_that_can_raise(self):
        # Regression guard for the exact bug: the old implementation called
        # dbutils.widgets.getAll() and iterated it expecting objects with a
        # `.name` attribute. A getAll() that returns a bare dict (the real
        # shape) must not cause _widget() to raise AttributeError.
        try:
            result = self._run_widget({"x": "y"}, "x", "fallback")
        except AttributeError as e:
            self.fail(
                f"_widget() raised AttributeError against a real-shaped (dict) "
                f"dbutils.widgets.getAll() — this is exactly the pre-fix bug: {e}"
            )
        self.assertEqual(result, "y")


if __name__ == "__main__":
    unittest.main()
