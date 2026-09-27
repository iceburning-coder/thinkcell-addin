"""风格令牌。所有颜色/字号只从这里取，不在图表代码里硬编码。"""
from __future__ import annotations

import copy

# 默认主题：think-cell / 咨询风 —— 单一深蓝色系按深浅区分系列，一个强调色，不画网格
DEFAULT = {
    "name": "consulting",
    "FG": "#1A1A1A",          # 主文字
    "FG_MUTED": "#8C8C8C",    # 副标题、来源、轴刻度
    "BG": "#FFFFFF",
    "AXIS": "#8C8C8C",        # 基线
    "GRID": "#E6E6E6",        # 网格（默认不画，show_grid=True 时用）
    "GUIDE": "#9A9A9A",       # 差异箭头引导虚线、连接线
    "SERIES": ["#0B2D4F", "#1F5A8C", "#3F86C0", "#7FB2DC", "#B9D5EC"],
    "OTHER": "#D9D9D9",       # "其他"
    "ACCENT": "#E4572E",      # 唯一强调色
    "POS": "#2E8B57",         # 瀑布增加
    "NEG": "#C0392B",         # 瀑布减少
    "TOTAL": "#0B2D4F",       # 合计/小计
    "PART": "#3F86C0",        # 拆解瀑布的组成部分
    "UP": "#C00000",          # K 线涨（中国习惯红涨）
    "DOWN": "#2E8B57",        # K 线跌
    "SHADE": "#F4F4F4",       # 甘特行底纹、象限底色
    "FONT": '"PingFang SC","Microsoft YaHei","Source Han Sans SC","Noto Sans CJK SC",Arial,sans-serif',
    "FONT_PPT_LATIN": "Arial",
    "FONT_PPT_EA": "Microsoft YaHei",
    "SIZE_TITLE": 14,
    "SIZE_SUB": 9.5,
    "SIZE_LABEL": 9,
    "SIZE_SMALL": 8,
}

# 业务主题：半导体设备（本土蓝 / 海外灰 / 本司橙）
SEMI = dict(DEFAULT, name="semi",
            SERIES=["#1F5A8C", "#A6A6A6", "#7FB2DC", "#595959", "#D9D9D9"],
            ACCENT="#ED7D31", TOTAL="#404040", SERIES_ORDERED=True,
            CAT=["#1F5A8C", "#A6A6A6", "#ED7D31", "#595959", "#7FB2DC"])

# 深色主题
DARK = dict(DEFAULT, name="dark", FG="#E8E8E8", FG_MUTED="#9A9A9A", BG="#16181D",
            AXIS="#5A6070", GRID="#2A2F38", GUIDE="#6A7080",
            SERIES=["#5B9BD5", "#3F86C0", "#7FB2DC", "#B9D5EC", "#DDE9F5"],
            OTHER="#3A3F4A", TOTAL="#C8C8C8", SHADE="#1E2128",
            CAT=["#5B9BD5", "#E8E8E8", "#ED7D31", "#9A9A9A", "#B9D5EC"])

THEMES = {"consulting": DEFAULT, "semi": SEMI, "dark": DARK}


def theme(name_or_dict=None, **over) -> dict:
    """主题名，或自定义主题 dict：{"base": "consulting", "SERIES": [...], "ACCENT": ...}（只写要覆盖的项）。"""
    if isinstance(name_or_dict, dict):
        d = dict(name_or_dict)
        t = copy.deepcopy(THEMES.get(d.pop("base", d.get("name", "consulting")), DEFAULT))
        t.update({k: v for k, v in d.items() if v not in (None, "", [])})
    else:
        t = copy.deepcopy(THEMES.get(name_or_dict, DEFAULT))
    t.update(over)
    return t


def cat_colors(t: dict, n: int) -> list[str]:
    """分类色（折线/散点分组）：相邻颜色对比度足够，不用最浅档。"""
    base = t.get("CAT", [t["SERIES"][0], t["SERIES"][2], "#8C8C8C", t["SERIES"][1], "#595959", t["SERIES"][3]])
    return (base * (n // len(base) + 1))[:n]


def series_colors(t: dict, n: int) -> list[str]:
    s = t["SERIES"]
    if t.get("SERIES_ORDERED"):
        return (s * (n // len(s) + 1))[:n]
    if n <= len(s):
        idx = [round(i * (len(s) - 1) / max(n - 1, 1)) for i in range(n)]
        if n == 1:
            idx = [0]
        return [s[i] for i in idx]
    extra = ["#595959", "#A6A6A6", "#D0D0D0", "#ED7D31", "#FFC000"]
    return (s + extra * 3)[:n]


def apply_named(cols, names, custom):
    """按名称覆盖颜色：custom = {系列名: '#RRGGBB'}（think-cell 单独改系列颜色）。"""
    if not custom:
        return list(cols)
    return [custom.get(str(n)) or c for n, c in zip(names, cols)]


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def text_on(fill: str, t: dict) -> str:
    """底色上的文字颜色：深底白字、浅底黑字。"""
    return "#FFFFFF" if luminance(fill) < 0.55 else "#1A1A1A"
