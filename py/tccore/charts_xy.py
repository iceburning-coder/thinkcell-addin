"""散点 / 气泡：面积∝值、分组配色+标记、四象限分区/底色、趋势线（线性/多项式/指数/对数/幂）、
标签自动避让、气泡大小图例、对数轴。"""
from __future__ import annotations

import math

from .axes import ValueAxis, nice_range
from .canvas import Canvas, text_w
from .charts_bar import Ctx
from .numfmt import fmt
from . import legend as LG
from .style import apply_named, cat_colors, series_colors as _auto_colors

MARKERS = ["circle", "square", "diamond", "triangle"]


def _marker(c, kind, x, y, r, fill, stroke, opacity=1.0):
    if kind == "square":
        c.rect(x - r, y - r, 2 * r, 2 * r, fill=fill, stroke=stroke, sw=0.8, opacity=opacity)
    elif kind == "diamond":
        c.poly([(x, y - r * 1.25), (x + r * 1.25, y), (x, y + r * 1.25), (x - r * 1.25, y)], fill=fill,
               stroke=stroke, sw=0.8, opacity=opacity)
    elif kind == "triangle":
        c.poly([(x, y - r * 1.2), (x + r * 1.1, y + r * 0.8), (x - r * 1.1, y + r * 0.8)], fill=fill, stroke=stroke,
               sw=0.8, opacity=opacity)
    else:
        c.circle(x, y, r, fill=fill, stroke=stroke, sw=0.8, opacity=opacity)


def _polyfit(X, Y, deg):
    """最小二乘多项式拟合（纯 Python，无需 numpy）。返回系数，高次在前。"""
    n = deg + 1
    A = [[sum(x ** (i + j) for x in X) for j in range(n)] for i in range(n)]
    B = [sum(y * x ** i for x, y in zip(X, Y)) for i in range(n)]
    for c in range(n):                       # 高斯消元
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        A[c], A[p], B[c], B[p] = A[p], A[c], B[p], B[c]
        if abs(A[c][c]) < 1e-12:
            raise ValueError("trend fit requires distinct x values")
        for r in range(c + 1, n):
            f = A[r][c] / A[c][c]
            for k in range(c, n):
                A[r][k] -= f * A[c][k]
            B[r] -= f * B[c]
    coef = [0.0] * n
    for r in range(n - 1, -1, -1):
        coef[r] = (B[r] - sum(A[r][k] * coef[k] for k in range(r + 1, n))) / A[r][r]
    return coef[::-1]


def _polyval(p, x):
    v = 0.0
    for c in p:
        v = v * x + c
    return v


def _fit(xs, ys, kind="linear", deg=2):
    """返回 f(x)。linear | poly | exp | log | power"""
    X, Y = [float(v) for v in xs], [float(v) for v in ys]
    required = (deg + 1) if kind == "poly" else 2
    if len(X) < required or len(set(X)) < required:
        raise ValueError("trend fit requires enough distinct x values")
    if any(not math.isfinite(v) for v in X + Y):
        raise ValueError("trend fit requires finite values")
    if kind == "linear":
        a, b = _polyfit(X, Y, 1)
        return lambda x: a * x + b, f"y = {a:.3g}x + {b:.3g}"
    if kind == "poly":
        p = _polyfit(X, Y, deg)
        return lambda x: _polyval(p, x), f"{deg} 次多项式"
    if kind == "exp":
        if any(y <= 0 for y in Y):
            raise ValueError("log trend requires positive y values")
        a, b = _polyfit(X, [math.log(y) for y in Y], 1)
        return lambda x: math.exp(b) * math.exp(a * x), f"y = {math.exp(b):.3g}e^({a:.3g}x)"
    if kind == "log":
        if any(x <= 0 for x in X):
            raise ValueError("log trend requires positive x values")
        a, b = _polyfit([math.log(x) for x in X], Y, 1)
        return lambda x: a * math.log(x) + b, f"y = {a:.3g}ln(x) + {b:.3g}"
    if kind == "power":
        if any(x <= 0 for x in X) or any(y <= 0 for y in Y):
            raise ValueError("log power trend requires positive x and y values")
        a, b = _polyfit([math.log(x) for x in X], [math.log(y) for y in Y], 1)
        return lambda x: math.exp(b) * x ** a, f"y = {math.exp(b):.3g}x^{a:.3g}"
    raise ValueError(kind)


def scatter(fig, points, x_label="", y_label="", x_fmt=None, y_fmt=None, bubble=False, size_mode="area",
            max_r=26, partitions=None, quadrants=None, quadrant_fill=None, trend=None, log_x=False, log_y=False,
            size_legend=None, size_unit="", label_limit=300, highlight_color=None, xlim=None, ylim=None,
            legend="auto", legend_reverse=False, series_colors=None):
    """
    points: [dict(x, y, s=大小, label=, group=, highlight=bool)]
    bubble=True：气泡图，s 决定大小；size_mode: area（think-cell 默认）| diameter
    partitions=(x分界, y分界)；quadrants=[左上, 右上, 左下, 右下] 文字；quadrant_fill=[4 个底色或 None]
    trend: linear | poly | exp | log | power（或 (kind, deg)）
    size_legend: [数值...] 气泡大小图例
    label_limit: 点数超过此值不自动标注（think-cell 为 300）
    """
    t, c = fig.t, fig.c
    xf, yf = x_fmt or {}, y_fmt or {}
    x0, y0, w, h = fig.box
    groups = []
    for p in points:
        if p.get("group") not in groups:
            groups.append(p.get("group"))
    gcol = dict(zip(groups, apply_named(cat_colors(t, len(groups)) if len(groups) > 1 else [t["SERIES"][1]],
                                        groups, series_colors)))
    gmark = dict(zip(groups, MARKERS * 3)) if (len(groups) > 1 and not bubble) else {g: "circle" for g in groups}
    xs, ys = [p["x"] for p in points], [p["y"] for p in points]
    if not points or any(not math.isfinite(float(v)) for v in xs + ys):
        raise ValueError("scatter points must contain finite x and y values")
    if log_x and any(v <= 0 for v in xs):
        raise ValueError("log x axis requires positive values")
    if log_y and any(v <= 0 for v in ys):
        raise ValueError("log y axis requires positive values")
    smax = max((p.get("s", 1) for p in points), default=1)
    sizes = [float(p.get("s", 1)) for p in points]
    if bubble and (any(not math.isfinite(s) or s < 0 for s in sizes) or smax <= 0):
        raise ValueError("bubble sizes must be finite, non-negative, and include a positive value")

    def rad(s):
        if not bubble:
            return 4.0
        return max_r * (math.sqrt(s / smax) if size_mode == "area" else s / smax)

    has_groups = len(groups) > 1 and groups[0] is not None
    lg = LG.norm(legend, "top") if has_groups else "none"
    if lg == "label":
        lg = "top"
    spot = LG.reserve(fig, lg, [str(g) for g in groups])
    x0, y0, w, h = fig.box
    legend_h = 0
    left, right = x0 + 44, x0 + w - 12 - (70 if size_legend else 0)
    top, bottom = y0 + 8 + legend_h + (14 if y_label else 0), y0 + h - 30

    def axis(vals, lo_px, hi_px, log, lim):
        if lim:
            return ValueAxis(lim[0], lim[1], lo_px, hi_px, log=log)
        if log:
            lo, hi = 10 ** math.floor(math.log10(min(vals))), 10 ** math.ceil(math.log10(max(vals)))
            return ValueAxis(lo, hi, lo_px, hi_px, log=True)
        span = (max(vals) - min(vals)) or 1
        lo, hi, st = nice_range(min(vals) - span * 0.12, max(vals) + span * 0.12, 5, include_zero=False)
        return ValueAxis(lo, hi, lo_px, hi_px, step=st)

    xax = axis(xs, left, right, log_x, xlim)
    yax = axis(ys, bottom, top, log_y, ylim)
    # 分区底色与分界线
    if partitions:
        px, py = xax.pos(partitions[0]), yax.pos(partitions[1])
        if quadrant_fill:
            rects = [(left, top, px - left, py - top), (px, top, right - px, py - top),
                     (left, py, px - left, bottom - py), (px, py, right - px, bottom - py)]
            for rc, fl in zip(rects, quadrant_fill):
                if fl:
                    c.rect(*rc, fill=fl)
        c.line(px, top, px, bottom, t["FG_MUTED"], 0.8, "4 3")
        c.line(left, py, right, py, t["FG_MUTED"], 0.8, "4 3")
        if quadrants:
            pos = [(left + 4, top + 3, "start", "top"), (right - 4, top + 3, "end", "top"),
                   (left + 4, bottom - 3, "start", "bottom"), (right - 4, bottom - 3, "end", "bottom")]
            for (xx, yy, an, va), s in zip(pos, quadrants):
                if s:
                    c.text(xx, yy, s, t["SIZE_LABEL"], t["FG_MUTED"], an, va, italic=True)
    # 轴
    for v in xax.ticks():
        c.line(xax.pos(v), bottom, xax.pos(v), bottom + 3, t["AXIS"], 0.8)
        c.text(xax.pos(v), bottom + 5, fmt(v, **xf), t["SIZE_SMALL"] + 0.5, t["FG_MUTED"], "middle", "top")
    for v in yax.ticks():
        c.line(left - 3, yax.pos(v), left, yax.pos(v), t["AXIS"], 0.8)
        c.text(left - 5, yax.pos(v), fmt(v, **yf), t["SIZE_SMALL"] + 0.5, t["FG_MUTED"], "end", "middle")
    c.line(left, bottom, right, bottom, t["AXIS"], 0.8)
    c.line(left, top, left, bottom, t["AXIS"], 0.8)
    if x_label:
        c.text((left + right) / 2, y0 + h, x_label, t["SIZE_LABEL"], t["FG_MUTED"], "middle", "bottom")
    if y_label:
        c.text(left - 30, top - 8, y_label, t["SIZE_LABEL"], t["FG_MUTED"], "start", "bottom")
    # 趋势线
    if trend:
        kind, deg = (trend, 2) if isinstance(trend, str) else trend
        f, eq = _fit(xs, ys, kind, deg)
        lo, hi = min(xs), max(xs)
        pts = []
        for j in range(41):
            xv = lo + (hi - lo) * j / 40
            try:
                yv = f(xv)
            except ValueError:
                continue
            if yax.vmin <= yv <= yax.vmax:
                pts.append((xax.pos(xv), yax.pos(yv)))
        if len(pts) > 1:
            c.poly(pts, stroke=t["FG_MUTED"], sw=1.0, closed=False, dash="5 3")
    # 点（大的先画，小的在上）
    boxes = []
    order = sorted(range(len(points)), key=lambda i: -points[i].get("s", 1))
    geo = {}
    for i in order:
        p = points[i]
        x, y, r = xax.pos(p["x"]), yax.pos(p["y"]), rad(p.get("s", 1))
        col = (highlight_color or t["ACCENT"]) if p.get("highlight") else gcol[p.get("group")]
        _marker(c, gmark[p.get("group")], x, y, r, col, t["BG"], 0.85 if bubble else 1.0)
        geo[i] = (x, y, r)
        boxes.append((x - r, y - r, x + r, y + r))
    # 标签避让：8 个候选位置，都冲突时用引线放远处
    if len(points) <= label_limit:
        placed = []
        for i in range(len(points)):
            s = points[i].get("label")
            if not s:
                continue
            x, y, r = geo[i]
            size = t["SIZE_SMALL"] + 0.5
            tw, th = text_w(s, size), size * 1.2
            cands = []
            for d in (r + 3, r + 12):
                for ax_, ay_, an, va in ((1, -1, "start", "bottom"), (1, 1, "start", "top"), (-1, -1, "end", "bottom"),
                                         (-1, 1, "end", "top"), (0, -1, "middle", "bottom"), (0, 1, "middle", "top"),
                                         (1, 0, "start", "middle"), (-1, 0, "end", "middle")):
                    k = 0.72 if ax_ and ay_ else 1
                    cands.append((x + ax_ * d * k, y + ay_ * d * k, an, va, d > r + 5))
            done = False
            for (lx, ly, an, va, far) in cands:
                bb = Canvas.text_bbox(lx, ly, s, size, an, va)
                if bb[0] < left or bb[2] > right + 60 or bb[1] < y0 or bb[3] > bottom:
                    continue
                hit = any(_ov(bb, o) for o in placed) or any(_ov(bb, o) for j, o in enumerate(boxes)
                                                            if j != order.index(i) and _ov(bb, o, 1))
                if not hit:
                    if far:
                        c.line(x, y, lx, ly, t["GUIDE"], 0.5)
                    c.text(lx, ly, s, size, t["FG"], an, va, bold=bool(points[i].get("highlight")))
                    placed.append(bb)
                    done = True
                    break
            if not done:
                c.text(x + r + 3, y, s, size, t["FG"], "start", "middle")
    # 图例
    LG.draw(fig, spot, [str(g) for g in groups], [gcol[g] for g in groups],
            markers=[gmark[g] for g in groups], reverse=legend_reverse)
    if size_legend and bubble:
        lx = right + 40
        yb = bottom - 10
        c.text(lx, top, "气泡大小", t["SIZE_SMALL"], t["FG_MUTED"], "middle", "top")
        for v in sorted(size_legend, reverse=True):
            r = rad(v)
            c.circle(lx, yb - r, r, fill=None, stroke=t["FG_MUTED"], sw=0.7)
            c.text(lx, yb - 2 * r - 1, fmt(v) + size_unit, t["SIZE_SMALL"], t["FG_MUTED"], "middle", "bottom")
    ctx = Ctx(fig, "v", None, yax)
    ctx.extra.update(xax=xax, yax=yax)
    return ctx


def _ov(a, b, pad=0):
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1])
