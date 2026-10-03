import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py"))

from tccore.report import build_figure


class EngineEdgeCaseTest(unittest.TestCase):
    def assert_invalid(self, spec, message):
        with self.assertRaisesRegex(ValueError, message):
            build_figure(spec)

    def test_relative_difference_requires_a_non_zero_base(self):
        self.assert_invalid({
            "type": "column", "cats": ["A", "B"], "series": {"S": [0, 1]},
            "annotations": [{"type": "diff", "a": 0, "b": 1, "mode": "rel"}],
        }, "relative difference")

    def test_cagr_requires_positive_values(self):
        for values in ([0, 2], [2, 0], [-1, 2]):
            with self.subTest(values=values):
                self.assert_invalid({
                    "type": "column", "cats": ["A", "B"], "series": {"S": values},
                    "annotations": [{"type": "cagr", "i0": 0, "i1": 1}],
                }, "CAGR")

    def test_cagr_requires_positive_duration(self):
        self.assert_invalid({
            "type": "column", "cats": ["A", "B"], "series": {"S": [1, 2]},
            "annotations": [{"type": "cagr", "i0": 0, "i1": 1, "years": -1}],
        }, "duration")

    def test_pareto_rejects_an_all_zero_series(self):
        self.assert_invalid({"type": "pareto", "cats": ["A", "B"], "values": [0, 0]}, "Pareto")

    def test_bubble_rejects_zero_or_negative_size_domains(self):
        for sizes in ([0, 0], [-1, 2]):
            with self.subTest(sizes=sizes):
                self.assert_invalid({
                    "type": "bubble",
                    "points": [{"x": 1, "y": 1, "s": sizes[0]}, {"x": 2, "y": 2, "s": sizes[1]}],
                }, "bubble")

    def test_trend_requires_enough_distinct_x_values(self):
        for points in (
            [{"x": 1, "y": 2}],
            [{"x": 1, "y": 2}, {"x": 1, "y": 3}],
        ):
            with self.subTest(points=points):
                self.assert_invalid({"type": "scatter", "points": points, "trend": "linear"}, "trend")

    def test_log_axes_and_trends_require_positive_values(self):
        self.assert_invalid({
            "type": "scatter", "points": [{"x": 0, "y": 1}, {"x": 2, "y": 2}], "log_x": True,
        }, "log")
        self.assert_invalid({
            "type": "scatter", "points": [{"x": -1, "y": 1}, {"x": 2, "y": 2}], "trend": "log",
        }, "log")

    def test_butterfly_renders_missing_sides_as_blank_zero_width_bars(self):
        figure = build_figure({
            "type": "butterfly",
            "cats": ["A", "B"],
            "left": ["Left", [None, 10]],
            "right": ["Right", [5, None]],
        })

        root = ET.fromstring(figure.c.to_svg(False))
        texts = [node.text for node in root.iter() if node.tag.endswith("text")]
        self.assertIn("10", texts)
        self.assertIn("5", texts)
        self.assertNotIn("0", texts)


if __name__ == "__main__":
    unittest.main()
