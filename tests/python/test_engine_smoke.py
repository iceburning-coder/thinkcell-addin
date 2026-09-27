import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py"))


class EngineSmokeTest(unittest.TestCase):
    def test_tracked_engine_renders_a_minimal_column_chart(self):
        from tccore.report import build_figure

        figure = build_figure({
            "type": "column",
            "cats": ["A"],
            "series": {"Series": [1]},
            "size": [320, 200],
        })

        self.assertTrue(figure.c.to_svg(False).startswith("<svg"))


if __name__ == "__main__":
    unittest.main()
