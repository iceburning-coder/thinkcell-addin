"""
统一图例（think-cell Legends）。

legend 取值：
  auto   每种图的默认（堆积柱/面积/Mekko → label，簇状/组合/散点分组 → top，折线 → label）
  label  系列名直接标在图上（堆积柱最后一根右侧、折线末端、面积右端）—— think-cell 默认风格
  top    顶部横排色块图例（放不下自动换行）
  bottom 底部横排色块图例
  side   右侧竖排色块图例
  none   不显示
legend_reverse=True：图例顺序反转（例如让堆积柱图例自上而下与柱段顺序一致）
"""
from __future__ import annotations

from .canvas import text_w

VALID = ("auto", "label", "top", "bottom", "side", "none")


def norm(legend, default="label"):
    if legend in (None, True):
        legend = "auto"
    if legend is False:
        return "none"
    if legend == "right":          # 兼容旧参数：right = 标在图上
        return "label" if default == "label" else "side"
    if legend not in VALID:
        return default
    return default if legend == "auto" else legend


def _item_w(t, name, size):
    return 11 + text_w(str(name), size) + 14


def reserve(fig, where, names):
    """在绘图前为图例预留空间（修改 fig.box），返回位置信息。"""
    if where not in ("top", "bottom", "side") or not names:
        return None
    t = fig.t
    size = t["SIZE_SMALL"] + 0.5
    x0, y0, w, h = fig.box
    if where in ("top", "bottom"):
        rows, cur = 1, 0.0
        for nm in names:
            iw = _item_w(t, nm, size)
            if cur + iw > w and cur > 0:
                rows += 1
                cur = 0.0
            cur += iw
        hh = rows * size * 1.7 + 6
        if where == "top":
            fig.box = (x0, y0 + hh, w, h - hh)
            return dict(where=where, x=x0, y=y0, w=w)
        fig.box = (x0, y0, w, h - hh)
        return dict(where=where, x=x0, y=y0 + h - hh + 6, w=w)
    ww = max(text_w(str(n), size) for n in names) + 26
    fig.box = (x0, y0, w - ww, h)
    return dict(where=where, x=x0 + w - ww + 12, y=y0 + 8, w=ww)


def draw(fig, spot, names, cols, markers=None, reverse=False):
    """markers: 每项的标记样式 rect | line | circle | diamond | square | triangle"""
    if not spot:
        return
    t, c = fig.t, fig.c
    size = t["SIZE_SMALL"] + 0.5
    items = list(zip(names, cols, markers or ["rect"] * len(names)))
    if reverse:
        items = items[::-1]
    x, y = spot["x"], spot["y"]
    for nm, col, mk in items:
        iw = _item_w(t, nm, size)
        if spot["where"] in ("top", "bottom") and x + iw > spot["x"] + spot["w"] and x > spot["x"]:
            x = spot["x"]
            y += size * 1.7
        cy = y + size * 0.6
        _marker(c, mk, x + 4, cy, col)
        c.text(x + 11, cy, str(nm), size, t["FG"], "start", "middle")
        if spot["where"] == "side":
            y += size * 1.8
        else:
            x += iw


def _marker(c, mk, x, y, col):
    if mk == "line":
        c.line(x - 4, y, x + 5, y, col, 2)
    elif mk == "circle":
        c.circle(x, y, 3.6, fill=col)
    elif mk == "diamond":
        c.poly([(x, y - 4.5), (x + 4.5, y), (x, y + 4.5), (x - 4.5, y)], fill=col)
    elif mk == "triangle":
        c.poly([(x, y - 4.3), (x + 4.3, y + 3.3), (x - 4.3, y + 3.3)], fill=col)
    else:
        c.rect(x - 4, y - 4, 8, 8, fill=col)
