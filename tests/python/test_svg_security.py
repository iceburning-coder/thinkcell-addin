import json
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py"))

from addin_api import render
from tccore.canvas import Canvas
from tccore.style import DEFAULT


class SvgSecurityTest(unittest.TestCase):
    def test_rejects_paint_that_can_create_an_event_attribute(self):
        canvas = Canvas(200, 100, dict(DEFAULT))
        canvas.rect(0, 0, 10, 10, fill='#123456" onload="alert(1)')

        with self.assertRaisesRegex(ValueError, "color"):
            canvas.to_svg(False)

    def test_rejects_font_that_can_break_out_of_the_root_attribute(self):
        theme = dict(DEFAULT, FONT="Arial' onerror='alert(1)")
        canvas = Canvas(200, 100, theme)

        with self.assertRaisesRegex(ValueError, "font"):
            canvas.to_svg(False)

    def test_addin_render_returns_a_structured_error_for_malicious_series_color(self):
        result = json.loads(render(json.dumps({
            "type": "column",
            "cats": ["A"],
            "series": {"Revenue": [1]},
            "series_colors": {"Revenue": '#123456" onload="alert(1)'},
        })))

        self.assertEqual(result["error"]["code"], "TC_ENGINE_INVALID_INPUT")
        self.assertNotIn("Traceback", result["error"]["message"])

    def test_valid_svg_contains_no_executable_or_non_finite_tokens(self):
        result = json.loads(render(json.dumps({
            "type": "column",
            "cats": ["A", "B"],
            "series": {"Revenue": [1, 2]},
        })))

        svg = result["svg"]
        for token in ("onload=", "onerror=", "javascript:", "NaN", "Infinity"):
            self.assertNotIn(token, svg)

    def test_open_polylines_serialize_as_well_formed_xml(self):
        canvas = Canvas(200, 100, dict(DEFAULT))
        canvas.poly([(0, 0), (20, 10), (40, 0)], stroke="#123456", sw=1.5, closed=False)

        svg = canvas.to_svg(False)

        ET.fromstring(svg)
        self.assertEqual(svg.count('fill="none"'), 1)


if __name__ == "__main__":
    unittest.main()
