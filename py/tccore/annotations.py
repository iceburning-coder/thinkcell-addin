"""
注释元素（think-cell Chart Decorations）：
  diff_arrow        差异箭头：总计差 / 水平差（段），3 种模式
  cagr_arrow        CAGR 箭头（类目间隔或 30/360 日期）
  series_cagr       系列 CAGR 标签
  value_line        数值线（均值 / 加权均值 / 指定值）
  series_connectors 系列连接线
  connector         通用连接线（直线 / 直角）
  callout           引线说明
"""
from __future__ import annotations

from .axes import years_between_30_360
from .numfmt import fmt


def _ref_value(ctx, ref):
    """ref: 类目序号 → 该列合计顶；(系列, 类目) → 该段顶端；('v', 值) → 指定值"""
    if isinstance(ref, tuple):
        if ref[0] == "v":
            return ref[1]
        si, i = ref
        return ctx.seg[(si, i)][1]
    return ctx.totals[ref] if ctx.totals else ctx.tops[ref]


def _ref_cat(ref):
    if isinstance(ref, tuple) and ref[0] != "v":
        return ref[1]
    return ref if not isinstance(ref, tuple) else None


def diff_arrow(ctx, a, b, mode="rel", dec=1, unit="", x=None, label=None):
    """
    差异箭头。
      a, b: 类目序号（总计差 Total difference）或 (系列序号, 类目序号)（水平差 Level difference）
      mode: rel  单向箭头 + 相对变化 %（默认）
            abs  双向箭头 + 绝对差
            rel_rev 反向箭头 + 相对变化（以 b 为基数，think-cell 第三种模式）
    位置：相邻类目 → 放在两柱之间；否则 → 放在 b 柱外侧，引导虚线横跨。
    """
    c, t = ctx.c, ctx.t
    va, vb = _ref_value(ctx, a), _ref_value(ctx, b)
    ia, ib = _ref_cat(a), _ref_cat(b)
    if x is None:
        if ib is not None and ia is not None and abs(ib - ia) == 1:
            x = ctx.cax.between(min(ia, ib))
        else:
            x = ctx.cax.right(ib) + ctx.cax.slot * 0.22
    ga, gb = ctx.P(ctx.cax.center(ia), va), ctx.P(ctx.cax.center(ib), vb)
    pa, pb = ctx.P(x, va), ctx.P(x, vb)
    # 引导虚线（从柱边缘出发）
    ea = ctx.P(ctx.cax.right(ia) if x > ctx.cax.center(ia) else ctx.cax.left(ia), va)
    eb = ctx.P(ctx.cax.left(ib) if x < ctx.cax.center(ib) else ctx.cax.right(ib), vb)
    c.line(ea[0], ea[1], pa[0], pa[1], t["GUIDE"], 0.6, "2 2")
    c.line(eb[0], eb[1], pb[0], pb[1], t["GUIDE"], 0.6, "2 2")
    if mode == "abs":
        s = label or fmt(vb - va, dec=dec, unit=unit, sign=True, mag=ctx.mag)
        c.arrow(pa[0], pa[1], pb[0], pb[1], t["FG"], 0.9, "both")
    elif mode == "rel_rev":
        if vb == 0:
            raise ValueError("relative difference requires a non-zero comparison value")
        s = label or fmt(va / vb - 1, dec=dec, pct=True, sign=True)
        c.arrow(pb[0], pb[1], pa[0], pa[1], t["FG"], 0.9, "end")
    else:
        if va == 0:
            raise ValueError("relative difference requires a non-zero base value")
        s = label or fmt(vb / va - 1, dec=dec, pct=True, sign=True)
        c.arrow(pa[0], pa[1], pb[0], pb[1], t["FG"], 0.9, "end")
    mx, my = (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2
    span_px = abs(pa[1] - pb[1]) if ctx.orient == "v" else abs(pa[0] - pb[0])
    if span_px < t["SIZE_LABEL"] * 2.2:      # 箭头太短：标签移到旁边
        if ctx.orient == "v":
            c.label_box(mx + 4 + len(s) * 3, my, s, t["SIZE_LABEL"] - 0.5)
        else:
            c.label_box(mx, my - 12, s, t["SIZE_LABEL"] - 0.5)
    else:
        c.label_box(mx, my, s, t["SIZE_LABEL"] - 0.5)
    return s


def cagr_arrow(ctx, i0, i1, v0=None, v1=None, years=None, dates=None, dec=1, label="CAGR",
               level=None):
    """
    CAGR 箭头：两柱上方的折线箭头 + 圆角框。
      years：年数；默认 = 类目间隔
      dates=(d0, d1)：按 30/360 日计数算年数（think-cell 规则，可为非整数）
      level：箭头横线所在的数值高度（默认自动避开中间所有柱和标签）
    返回 CAGR 数值。
    """
    c, t = ctx.c, ctx.t
    v0 = ctx.totals[i0] if v0 is None else v0
    v1 = ctx.totals[i1] if v1 is None else v1
    if dates:
        years = years_between_30_360(*dates)
    years = years or (i1 - i0)
    if v0 <= 0 or v1 <= 0:
        raise ValueError("CAGR requires positive start and end values")
    if years <= 0:
        raise ValueError("CAGR duration must be positive")
    r = (v1 / v0) ** (1 / years) - 1
    tops = ctx.label_top or ctx.tops
    px = t["SIZE_LABEL"] * 1.9
    top_px = min(ctx.vax.pos(tv) for tv in tops[i0:i1 + 1]) if ctx.orient == "v" else None
    y_line = top_px - px if level is None else ctx.vax.pos(level)
    x0, x1 = ctx.cax.center(i0), ctx.cax.center(i1)
    ya = ctx.vax.pos(tops[i0]) - 3
    yb = ctx.vax.pos(tops[i1]) - 3
    c.line(x0, ya, x0, y_line, t["FG"], 0.8)
    c.line(x0, y_line, x1, y_line, t["FG"], 0.8)
    c.arrow(x1, y_line, x1, yb, t["FG"], 0.8, "end", 4.5)
    c.label_box((x0 + x1) / 2, y_line, f"{label} {fmt(r, dec=dec, pct=True, sign=True)}", t["SIZE_LABEL"] - 0.5)
    ctx.extra["cagr_y"] = y_line
    return r


def series_cagr(ctx, si, i0, i1, years=None, dec=1, x=None):
    """系列 CAGR 标签：写在该系列最后一段的右侧（按系列而非合计计算）。"""
    c, t = ctx.c, ctx.t
    a, b = ctx.seg[(si, i0)], ctx.seg[(si, i1)]
    v0, v1 = a[1] - a[0], b[1] - b[0]
    years = years or (i1 - i0)
    if v0 <= 0 or v1 <= 0:
        raise ValueError("series CAGR requires positive start and end values")
    if years <= 0:
        raise ValueError("series CAGR duration must be positive")
    r = (v1 / v0) ** (1 / years) - 1
    xx = x if x is not None else ctx.cax.right(i1) + 6
    y = ctx.vax.pos((b[0] + b[1]) / 2)
    c.text(xx, y, fmt(r, dec=dec, pct=True, sign=True), t["SIZE_LABEL"] - 0.5, t["FG"], "start", "middle",
           bold=True)
    return r


def cagr_column(ctx, i0, i1, x=None, dec=1, title="CAGR"):
    """在图右侧加一列：每个系列各自的 CAGR（think-cell 常见版式）。"""
    c, t = ctx.c, ctx.t
    xx = x if x is not None else ctx.cax.right(i1) + 60
    top = min(ctx.vax.pos(v) for v in ctx.tops) - 6
    c.text(xx, top - 8, f"{title} {ctx.cats[i0]}–{ctx.cats[i1]}", t["SIZE_SMALL"], t["FG_MUTED"], "middle", "bottom")
    out = {}
    if i1 <= i0:
        raise ValueError("CAGR column duration must be positive")
    for si, nm in enumerate(ctx.names):
        a, b = ctx.seg[(si, i0)], ctx.seg[(si, i1)]
        v0, v1 = a[1] - a[0], b[1] - b[0]
        if v0 <= 0 or v1 <= 0:
            continue
        r = (v1 / v0) ** (1 / (i1 - i0)) - 1
        y = ctx.vax.pos((b[0] + b[1]) / 2)
        c.text(xx, y, fmt(r, dec=dec, pct=True, sign=True), t["SIZE_LABEL"] - 0.5, t["FG"], "middle", "middle")
        out[nm] = r
    return out


def value_line(ctx, value=None, kind="mean", label=None, dec=None, color=None, side="right",
               weights=None, dash="4 3"):
    """
    数值线。kind: mean（算术平均，think-cell 默认）| wmean（加权平均，Mekko）| value
    """
    c, t = ctx.c, ctx.t
    if value is None:
        vals = ctx.totals
        if kind == "wmean" and weights:
            value = sum(v * w for v, w in zip(vals, weights)) / sum(weights)
        else:
            value = sum(vals) / len(vals)
    color = color or t["ACCENT"]
    a, b = ctx.P(ctx.cax.p0, value), ctx.P(ctx.cax.p1, value)
    c.line(a[0], a[1], b[0], b[1], color, 0.9, dash)
    s = (label + " " if label else "") + fmt(value, dec=ctx.dec if dec is None else dec, mag=ctx.mag)
    if ctx.orient == "v":
        if side == "right":
            c.text(b[0], b[1] - 2, s, t["SIZE_SMALL"] + 0.5, color, "end", "bottom")
        else:
            c.text(a[0], a[1] - 2, s, t["SIZE_SMALL"] + 0.5, color, "start", "bottom")
    else:
        c.text(a[0] + 2, min(a[1], b[1]) - 2, s, t["SIZE_SMALL"] + 0.5, color, "start", "bottom")
    return value


def series_connectors(ctx, si=None):
    """系列连接线：相邻柱之间连接各段顶端（si=None 连接全部系列 + 合计）。"""
    c, t = ctx.c, ctx.t
    n = len(ctx.cats)
    sis = range(len(ctx.names)) if si is None else [si]
    for s in sis:
        for i in range(n - 1):
            v_a, v_b = ctx.seg[(s, i)][1], ctx.seg[(s, i + 1)][1]
            a = ctx.P(ctx.cax.right(i), v_a)
            b = ctx.P(ctx.cax.left(i + 1), v_b)
            c.line(a[0], a[1], b[0], b[1], t["GUIDE"], 0.6)


def connector(ctx_or_fig, p1, p2, elbow=False, color=None, dash=None, arrow=False):
    """通用连接线：任意两点（pt 坐标），可跨图。elbow=True 走直角。"""
    c = ctx_or_fig.c
    t = ctx_or_fig.t
    color = color or t["GUIDE"]
    if elbow:
        mx = (p1[0] + p2[0]) / 2
        pts = [p1, (mx, p1[1]), (mx, p2[1]), p2]
        if arrow:
            c.polyline_arrow(pts, color, 0.8)
        else:
            c.poly(pts, stroke=color, sw=0.8, closed=False, dash=dash)
    else:
        if arrow:
            c.arrow(p1[0], p1[1], p2[0], p2[1], color, 0.8)
        else:
            c.line(p1[0], p1[1], p2[0], p2[1], color, 0.8, dash)


def callout(ctx, i, v, text, dx=40, dy=-30, color=None):
    c, t = ctx.c, ctx.t
    color = color or t["ACCENT"]
    x, y = ctx.P(ctx.cax.center(i), v)
    c.line(x, y, x + dx, y + dy, color, 0.8)
    c.text(x + dx + 3, y + dy, text, t["SIZE_SMALL"] + 0.5, color, "start", "middle")
