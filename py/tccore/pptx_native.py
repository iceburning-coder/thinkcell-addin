"""
PPT 原生图表（客户可在 PowerPoint 里"编辑数据"）：column/bar(stacked/clustered/100)、line、area、pie、
doughnut、scatter、bubble。已套用 think-cell 风格（无网格、数据标签、主题色、系列名直接标注）。
需要 CAGR/差异箭头等注释时：用 Figure.pptx()（形状模式，外观与 SVG 完全一致）。
"""
from __future__ import annotations

from pptx.chart.data import BubbleChartData, CategoryChartData, XyChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.util import Inches, Pt

from .style import series_colors, theme as _theme

TYPES = {
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED, "column_stacked": XL_CHART_TYPE.COLUMN_STACKED,
    "column_100": XL_CHART_TYPE.COLUMN_STACKED_100, "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "bar_stacked": XL_CHART_TYPE.BAR_STACKED, "bar_100": XL_CHART_TYPE.BAR_STACKED_100,
    "line": XL_CHART_TYPE.LINE_MARKERS, "area": XL_CHART_TYPE.AREA, "area_stacked": XL_CHART_TYPE.AREA_STACKED,
    "area_100": XL_CHART_TYPE.AREA_STACKED_100, "pie": XL_CHART_TYPE.PIE, "doughnut": XL_CHART_TYPE.DOUGHNUT,
    "scatter": XL_CHART_TYPE.XY_SCATTER, "bubble": XL_CHART_TYPE.BUBBLE,
}


def _rgb(h):
    h = h.lstrip("#")
    return RGBColor(int(h[:2], 16), int(h[2:4], 16), int(h[4:], 16))


def native_chart(slide, kind, cats=None, series=None, points=None, x=0.6, y=1.2, w=12.0, h=5.6, theme=None,
                 number_format='#,##0.0', labels=True, legend=None, font="Arial"):
    """
    cats/series：类目图；points：[(x, y[, size])] 散点/气泡
    返回 chart 对象（可继续自定义）。
    """
    t = _theme(theme) if not isinstance(theme, dict) else theme
    ct = TYPES[kind]
    if kind in ("scatter", "bubble"):
        cd = BubbleChartData() if kind == "bubble" else XyChartData()
        s = cd.add_series("数据")
        for p in points:
            s.add_data_point(*p)
    else:
        cd = CategoryChartData()
        cd.categories = list(cats)
        for nm, vals in series.items():
            cd.add_series(nm, list(vals), number_format=number_format)
    gf = slide.shapes.add_chart(ct, Inches(x), Inches(y), Inches(w), Inches(h), cd)
    ch = gf.chart
    ch.font.size = Pt(10)
    ch.font.name = font
    n = len(series) if series else 1
    cols = series_colors(t, n)
    if kind in ("pie", "doughnut"):
        pc = series_colors(t, len(cats))
        for i, pt in enumerate(ch.plots[0].series[0].points):
            pt.format.fill.solid()
            pt.format.fill.fore_color.rgb = _rgb(pc[i])
            pt.format.line.color.rgb = _rgb(t["BG"])
    else:
        for i, s in enumerate(ch.plots[0].series):
            if kind.startswith("line"):
                s.format.line.color.rgb = _rgb(cols[i])
                s.format.line.width = Pt(2.25)
                s.smooth = False
            else:
                s.format.fill.solid()
                s.format.fill.fore_color.rgb = _rgb(cols[i])
    try:
        ch.plots[0].gap_width = 60
        if kind.endswith(("stacked", "100")):
            ch.plots[0].overlap = 100
    except Exception:
        pass
    if kind not in ("pie", "doughnut"):
        va = ch.value_axis
        va.has_major_gridlines = False
        va.visible = kind in ("line", "scatter", "bubble")
        va.format.line.fill.background()
        ca = ch.category_axis
        ca.format.line.color.rgb = _rgb(t["AXIS"])
        ca.tick_labels.font.size = Pt(10)
    if labels:
        pl = ch.plots[0]
        pl.has_data_labels = True
        dl = pl.data_labels
        dl.number_format = number_format if kind not in ("pie", "doughnut") else "0%"
        dl.number_format_is_linked = False
        dl.font.size = Pt(9)
        dl.show_value = kind not in ("pie", "doughnut")
        if kind in ("pie", "doughnut"):
            dl.show_percentage, dl.show_value = True, False
        elif kind.startswith(("column", "bar")) and n > 1:
            dl.position = XL_LABEL_POSITION.CENTER
            for i, s in enumerate(ch.plots[0].series):
                from .style import luminance
                s.data_labels.show_value = True
                s.data_labels.position = XL_LABEL_POSITION.CENTER
                s.data_labels.font.color.rgb = _rgb("#FFFFFF" if luminance(cols[i]) < .55 else "#1A1A1A")
                s.data_labels.font.size = Pt(9)
                s.data_labels.number_format = number_format
                s.data_labels.number_format_is_linked = False
    show_leg = legend if legend is not None else (n > 1 or kind in ("pie", "doughnut"))
    ch.has_legend = show_leg
    if show_leg:
        ch.legend.position = XL_LEGEND_POSITION.RIGHT if kind in ("pie", "doughnut") else XL_LEGEND_POSITION.TOP
        ch.legend.include_in_layout = False
        ch.legend.font.size = Pt(9)
    return ch
