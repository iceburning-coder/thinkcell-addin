"""tccore —— think-cell 风格图表引擎：一次画图，输出 SVG / HTML / PNG / PPTX（+ XLSX）。"""
from .figure import Figure, html_page
from .style import theme, THEMES
from .numfmt import fmt
from .axes import same_scale, years_between_30_360
from .charts_bar import column, butterfly, waterfall
from .charts_line import line, area, combo, pareto, candlestick, football
from .charts_round import pie, pie_of_pie, concentric, gauge
from .charts_xy import scatter
from .charts_mekko import mekko
from .charts_gantt import gantt
from .table import table, harvey, checkbox
from .annotations import (diff_arrow, cagr_arrow, series_cagr, cagr_column, value_line,
                          series_connectors, connector, callout)
