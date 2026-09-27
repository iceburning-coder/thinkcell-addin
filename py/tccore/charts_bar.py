"""
柱/条形图家族：堆积、簇状、100%、横向条形、蝴蝶/龙卷风、瀑布、图下数据表。
全部返回 Ctx，供 annotations 使用。
"""
from __future__ import annotations

from .axes import CategoryAxis, ValueAxis, nice_range, sort_order
from .canvas import text_w
from .numfmt import auto_dec, fmt, ordinal
from . import legend as LG
from .style import apply_named, series_colors as _auto_colors, text_on


class Ctx:
    """图表上下文：注释元素需要的几何信息。"""

    def __init__(self, fig, orient, cax, vax, names=None, cats=None):
        self.fig, self.c, self.t = fig, fig.c, fig.t
        self.orient, self.cax, self.vax = orient, cax, vax
        self.names, self.cats = names or [], cats or []
        self.seg = {}         # (si, i) -> (v0, v1)
        self.tops = []        # 每个类别正向堆叠顶值
        self.bottoms = []     # 负向堆叠底值
        self.totals = []      # 每个类别合计（代数和）
        self.label_top = []   # 每个类别顶部标签占到的数值高度（给箭头避让）
        self.boxes = []       # 已占用的文字框（碰撞检测）
        self.dec, self.unit, self.mag = 0, "", ""
        self.extra = {}

    def P(self, cpx, v):
        """(类别轴像素, 数值) -> (x, y)"""
        return (cpx, self.vax.pos(v)) if self.orient == "v" else (self.vax.pos(v), cpx)

    def cpos(self, i):
        return self.cax.center(i)

    def fmt(self, v, **kw):
        kw.setdefault("dec", self.dec)
        kw.setdefault("unit", "")
        kw.setdefault("mag", self.mag)
        return fmt(v, **kw)

    def px_per_value(self):
        return abs(self.vax.pos(1) - self.vax.pos(0)) if not self.vax.log else None


# ---------------------------------------------------------------- 轴绘制
def draw_value_axis(ctx, show=True, grid=False, fmt_kw=None, side="left"):
    c, t, vax = ctx.c, ctx.t, ctx.vax
    fmt_kw = fmt_kw or {}
    x0, y0, w, h = ctx.fig.box
    bps = vax.break_positions()
    for v in vax.ticks():
        if any(abs(vax.pos(v) - bp) < 10 for bp in bps):
            continue
        if ctx.orient == "v":
            y = vax.pos(v)
            if grid:
                c.line(ctx.cax.p0, y, ctx.cax.p1, y, t["GRID"], 0.6, "3 3")
            if show:
                xx = ctx.cax.p0 - 4 if side == "left" else ctx.cax.p1 + 4
                c.text(xx, y, fmt(v, **fmt_kw), t["SIZE_SMALL"], t["FG_MUTED"],
                       "end" if side == "left" else "start", "middle")
        else:
            x = vax.pos(v)
            if grid:
                c.line(x, ctx.cax.p0, x, ctx.cax.p1, t["GRID"], 0.6, "3 3")
            if show:
                c.text(x, ctx.cax.p1 + 4, fmt(v, **fmt_kw), t["SIZE_SMALL"], t["FG_MUTED"], "middle", "top")


def draw_breaks(ctx, wave=False):
    for p in ctx.vax.break_positions():
        if ctx.orient == "v":
            ctx.c.break_mark(ctx.cax.p0 - 6, p, ctx.cax.p1 - ctx.cax.p0 + 12, True, wave)
        else:
            ctx.c.break_mark(p, ctx.cax.p0 - 6, ctx.cax.p1 - ctx.cax.p0 + 12, False, wave)


def _bar_breaks(ctx, n):
    """断轴：只在穿过断点的柱子上画断点标记（直线型）。"""
    for (a, b), p in zip(ctx.vax.breaks, ctx.vax.break_positions()):
        for i in range(n):
            if ctx.tops[i] > b:
                if ctx.orient == "v":
                    ctx.c.break_mark(ctx.cax.left(i), p, ctx.cax.bar, True, False)
                else:
                    ctx.c.break_mark(p, ctx.cax.left(i), ctx.cax.bar, False, False)


def draw_baseline(ctx, v=0.0):
    c, t = ctx.c, ctx.t
    if ctx.vax.log:
        v = ctx.vax.vmin
    a = ctx.P(ctx.cax.p0, v)
    b = ctx.P(ctx.cax.p1, v)
    c.line(a[0], a[1], b[0], b[1], t["AXIS"], 0.8)


def draw_cat_labels(ctx, cats, ordinal_labels=False, rotate=0, below_value=None):
    c, t = ctx.c, ctx.t
    for i, cat in enumerate(cats):
        s = ordinal(i + 1) + " " + str(cat) if ordinal_labels else str(cat)
        if ctx.orient == "v":
            y = ctx.vax.pos(below_value if below_value is not None else
                            (min(0, ctx.vax.vmin) if not ctx.vax.log else ctx.vax.vmin))
            y = max(y, ctx.vax.pos(ctx.vax.vmin) if not ctx.vax.reverse else y)
            if rotate:
                c.text(ctx.cpos(i), y + 6, s, t["SIZE_LABEL"], t["FG"], "end", "middle", rotate=rotate)
            else:
                c.text(ctx.cpos(i), y + 5, s, t["SIZE_LABEL"], t["FG"], "middle", "top")
        else:
            x = ctx.vax.pos(0 if not ctx.vax.log else ctx.vax.vmin)
            x = min(x, ctx.vax.pos(ctx.vax.vmin))
            c.text(x - 6, ctx.cpos(i), s, t["SIZE_LABEL"], t["FG"], "end", "middle")


def _cat_label_space(cats, size, orient):
    if orient == "v":
        return size * 1.6
    return max(text_w(str(s), size) for s in cats) + 10


# ---------------------------------------------------------------- 柱形/条形
def column(fig, cats, series: dict, mode="stacked", horizontal=False, labels="value", totals=True,
           dec=None, unit="", mag="", colors=None, legend="right", highlight=None, sort="sheet",
           gaps=None, breaks=None, log=False, reverse=False, show_axis=False, grid=False,
           width=0.62, min_label_px=11, ordinal_labels=False, vmax=None, vmin=None, top_reserve=26,
           total_values=None, datatable=None, cat_rotate=0, legend_reverse=False, series_colors=None):
    """
    mode: stacked | clustered | 100
    labels: value | pct | both | none（段内标签内容，think-cell Label Content）
    totals: 堆积柱顶部合计；100% 模式下显示绝对合计
    highlight: {(系列序号, 类目序号) 或 类目序号: 颜色}
    sort: sheet | reverse | desc | asc（按合计排序类目）
    gaps: {i: 额外间隔}，在第 i 类后加宽（类别间隔）
    breaks: [(a,b)] 断轴；log: 对数轴；reverse: 反转数值轴
    show_axis/grid: 显示数值轴刻度 / 网格（默认按 think-cell 用标签代替数值轴）
    datatable: {行名: [值...]} 在图下方附数据表
    """
    t, c = fig.t, fig.c
    names = list(series)
    n, k = len(cats), len(names)
    raw = [[(None if v is None else float(v)) for v in series[nm]] for nm in names]
    sums = [sum(r[i] or 0 for r in raw) for i in range(n)]
    order = sort_order(cats, sums, sort)
    cats = [cats[i] for i in order]
    raw = [[r[i] for i in order] for r in raw]
    sums = [sums[i] for i in order]
    if total_values:
        total_values = [total_values[i] for i in order]
    pct = mode == "100"
    data = [[((r[i] or 0) / sums[i] if sums[i] else 0) for i in range(n)] for r in raw] if pct else \
        [[(r[i] or 0) for i in range(n)] for r in raw]
    cols = colors or _auto_colors(t, k)
    if "其他" in names and not colors:
        cols[names.index("其他")] = t["OTHER"]
    cols = apply_named(cols, names, series_colors)
    dec = auto_dec([v for r in raw for v in r if v is not None]) if dec is None else dec

    # 图例
    lg = LG.norm(legend, "top" if (mode == "clustered" or horizontal) else "label")
    if k <= 1:
        lg = "none"
    if lg == "label" and horizontal:
        lg = "top"
    spot = LG.reserve(fig, lg, names)
    # 绘图区布局
    x0, y0, w, h = fig.box
    right_legend = lg == "label"
    leg_w = max(text_w(nm, t["SIZE_LABEL"]) for nm in names) + 10 if right_legend else 0
    top_pad = 0
    dt_h = (len(datatable) * t["SIZE_LABEL"] * 1.6 + 4) if datatable else 0
    axis_w = 34 if show_axis else (24 if pct else 0)
    if datatable:
        axis_w = max(axis_w, max(text_w(k_, t["SIZE_SMALL"]) for k_ in datatable) + 10)
    if horizontal:
        lab_w = _cat_label_space(cats, t["SIZE_LABEL"], "h")
        cax = CategoryAxis(n, y0 + top_pad, y0 + h - (14 if show_axis else 0), width)
        vp0, vp1 = x0 + lab_w, x0 + w - 44
    else:
        cax = CategoryAxis(n, x0 + axis_w, x0 + w - leg_w, width, gaps)
        vp0 = y0 + h - _cat_label_space(cats, t["SIZE_LABEL"], "v") - dt_h - (30 if cat_rotate else 0)
        vp1 = y0 + top_pad + t["SIZE_LABEL"] * 1.6 + top_reserve
    if mode == "clustered":
        allv = [v for r in data for v in r]
        hi, lo = max(allv + [0]), min(allv + [0])
    else:
        pos_tot = [sum(max(r[i], 0) for r in data) for i in range(n)]
        neg_tot = [sum(min(r[i], 0) for r in data) for i in range(n)]
        hi, lo = max(pos_tot + [0]), min(neg_tot + [0])
    if log:
        vax = ValueAxis(vmin or 10 ** int(__import__("math").floor(__import__("math").log10(max(min(v for r in data for v in r if v > 0), 1e-9)))),
                        vmax or 10 ** int(__import__("math").ceil(__import__("math").log10(hi))), vp0, vp1, log=True, reverse=reverse)
    else:
        span = (hi - lo) or 1
        vax = ValueAxis(vmin if vmin is not None else (lo - span * 0.03 if lo < 0 else 0),
                        vmax if vmax is not None else (1.0 if pct else hi), vp0, vp1, reverse=reverse,
                        breaks=breaks)
    orient = "h" if horizontal else "v"
    ctx = Ctx(fig, orient, cax, vax, names, cats)
    ctx.dec, ctx.unit, ctx.mag = dec, unit, mag
    ctx.totals = sums
    hl = highlight or {}

    def bar(cpx, bw, v0, v1, fill):
        a = ctx.P(cpx - bw / 2, v0)
        b = ctx.P(cpx + bw / 2, v1)
        c.rect(min(a[0], b[0]), min(a[1], b[1]), abs(b[0] - a[0]), abs(b[1] - a[1]), fill=fill,
               stroke=t["BG"], sw=0.6)

    if show_axis or grid:
        draw_value_axis(ctx, show_axis, grid, dict(dec=None, pct=pct, mag=mag))

    ctx.tops, ctx.bottoms, ctx.label_top = [0.0] * n, [0.0] * n, [0.0] * n
    if mode == "clustered":
        sub = cax.slot * 0.8 / k
        for si in range(k):
            for i in range(n):
                v = data[si][i]
                cp = cax.center(i) - cax.slot * 0.4 + sub * (si + 0.5)
                fill = hl.get((si, i)) or cols[si]
                bar(cp, sub * 0.9, 0, v, fill)
                ctx.seg[(si, i)] = (0, v)
                if labels != "none" and raw[si][i] is not None:
                    _outside_label(ctx, cp, v, ctx.fmt(v, unit=""), t["SIZE_LABEL"] - 0.5)
                ctx.tops[i] = max(ctx.tops[i], v)
                ctx.bottoms[i] = min(ctx.bottoms[i], v)
        ctx.extra["sub"] = sub
        for i in range(n):
            ctx.label_top[i] = ctx.tops[i] + _val_of_px(ctx, t["SIZE_LABEL"] * 1.5)
    else:
        for i in range(n):
            pb, nb = 0.0, 0.0
            for si in range(k):
                v = data[si][i]
                if v >= 0:
                    v0, v1 = pb, pb + v
                    pb = v1
                else:
                    v0, v1 = nb, nb + v
                    nb = v1
                fill = hl.get((si, i)) or (hl.get(i) if k == 1 else None) or cols[si]
                if v:
                    bar(cax.center(i), cax.bar, v0, v1, fill)
                ctx.seg[(si, i)] = (v0, v1)
                seg_px = abs(vax.pos(v1) - vax.pos(v0))
                if labels != "none" and k > 1 and v and seg_px >= min_label_px and raw[si][i] is not None:
                    if labels == "pct" or pct:
                        s = fmt(v if pct else v / sums[i], dec=0, pct=True)
                        if labels == "both" and pct:
                            s = f"{ctx.fmt(raw[si][i])} ({s})"
                    elif labels == "both":
                        s = f"{ctx.fmt(v)} ({fmt(v / sums[i], dec=0, pct=True)})"
                    else:
                        s = ctx.fmt(v)
                    bw = cax.bar if not horizontal else abs(vax.pos(v1) - vax.pos(v0))
                    if text_w(s, t["SIZE_LABEL"] - 0.5) < (cax.bar if not horizontal else seg_px) - 2:
                        x, y = ctx.P(cax.center(i), (v0 + v1) / 2)
                        c.text(x, y, s, t["SIZE_LABEL"] - 0.5, text_on(fill, t), "middle", "middle")
            ctx.tops[i], ctx.bottoms[i] = pb, nb
            show_total = (totals and (k > 1 or pct)) or (k == 1 and labels != "none")
            tv = (total_values[i] if total_values else sums[i])
            if show_total and not (pct and not totals):
                lab = ctx.fmt(tv, unit="", dec=None if log else dec) if not (pct and k == 1) else fmt(1, dec=0, pct=True)
                lab_v = pb if pb > 0 or nb == 0 else nb
                _outside_label(ctx, cax.center(i), lab_v, lab, t["SIZE_LABEL"], bold=(k > 1))
                ctx.label_top[i] = lab_v + _val_of_px(ctx, t["SIZE_LABEL"] * 1.6) if lab_v >= 0 else pb
            else:
                ctx.label_top[i] = pb
    draw_baseline(ctx)
    _bar_breaks(ctx, n)
    draw_cat_labels(ctx, cats, ordinal_labels, rotate=cat_rotate)
    if pct and not horizontal:
        # 100% 指示器
        y = vax.pos(1.0)
        xx = cax.p0 - 2
        c.text(xx, y, "100%", t["SIZE_SMALL"], t["FG_MUTED"], "end", "middle")
    # 图例
    if right_legend and not horizontal:
        _right_legend(ctx, data, cols, names, n - 1)
    else:
        LG.draw(fig, spot, names, cols, reverse=legend_reverse)
    if datatable:
        _datatable(ctx, datatable, vp0 + _cat_label_space(cats, t["SIZE_LABEL"], "v") + 2, dec)
    ctx.cols = cols
    return ctx


def _val_of_px(ctx, px):
    if ctx.vax.log:
        return 0
    ppv = abs(ctx.vax.pos(1) - ctx.vax.pos(0)) or 1
    return px / ppv


def _outside_label(ctx, cpx, v, s, size, bold=False):
    c, t = ctx.c, ctx.t
    x, y = ctx.P(cpx, v)
    if ctx.orient == "v":
        up = (v >= 0) != ctx.vax.reverse
        c.text(x, y - 3 if up else y + 3, s, size, t["FG"], "middle", "bottom" if up else "top", bold)
    else:
        right = v >= 0
        c.text(x + 4 if right else x - 4, y, s, size, t["FG"], "start" if right else "end", "middle", bold)


def _right_legend(ctx, data, cols, names, last):
    c, t = ctx.c, ctx.t
    x = ctx.cax.right(last) + 6
    placed = []
    for si, nm in enumerate(names):
        v0, v1 = ctx.seg[(si, last)]
        if v1 == v0:
            continue
        y = ctx.vax.pos((v0 + v1) / 2)
        for py in placed:
            if abs(y - py) < t["SIZE_LABEL"] * 1.2:
                y = py - t["SIZE_LABEL"] * 1.2 if y < py else py + t["SIZE_LABEL"] * 1.2
        placed.append(y)
        c.text(x, y, nm, t["SIZE_LABEL"] - 0.5, t["FG"], "start", "middle")


def swatch_legend(ctx, names, cols, x, y, markers=None):
    c, t = ctx.c, ctx.t
    xx = x
    for nm, col in zip(names, cols):
        c.rect(xx, y + 2, 8, 8, fill=col)
        c.text(xx + 11, y + 6, nm, t["SIZE_SMALL"] + 0.5, t["FG"], "start", "middle")
        xx += 11 + text_w(nm, t["SIZE_SMALL"] + 0.5) + 14


def _datatable(ctx, rows, y, dec):
    c, t = ctx.c, ctx.t
    for r, (nm, vals) in enumerate(rows.items()):
        yy = y + r * t["SIZE_LABEL"] * 1.6 + t["SIZE_LABEL"] * 0.8
        c.text(ctx.cax.p0 - 6, yy, nm, t["SIZE_SMALL"], t["FG_MUTED"], "end", "middle")
        for i, v in enumerate(vals):
            c.text(ctx.cpos(i), yy, v if isinstance(v, str) else fmt(v, dec=dec), t["SIZE_SMALL"] + 0.5,
                   t["FG"], "middle", "middle")
        c.line(ctx.cax.p0, yy - t["SIZE_LABEL"] * 0.8, ctx.cax.p1, yy - t["SIZE_LABEL"] * 0.8, t["GRID"], 0.5)


# ---------------------------------------------------------------- 蝴蝶 / 龙卷风
def butterfly(fig, cats, left: tuple, right: tuple, dec=None, unit="", colors=None, sort="sheet",
              center_labels=True, highlight=None, series_colors=None, **_):
    """
    left/right = (名称, [值])。类别标签放中间（center_labels）或左侧。
    龙卷风图：按 |左|+|右| 降序（sort='desc'）。
    """
    t, c = fig.t, fig.c
    ln, lv = left
    rn, rv = right
    n = len(cats)
    lraw, rraw = list(lv), list(rv)
    lvals = [0 if v is None else v for v in lraw]
    rvals = [0 if v is None else v for v in rraw]
    tot = [abs(a) + abs(b) for a, b in zip(lvals, rvals)]
    order = sort_order(cats, tot, sort)
    cats = [cats[i] for i in order]
    lraw, rraw = [lraw[i] for i in order], [rraw[i] for i in order]
    lvals, rvals = [lvals[i] for i in order], [rvals[i] for i in order]
    dec = auto_dec(lraw + rraw) if dec is None else dec
    x0, y0, w, h = fig.box
    lab_w = max(text_w(str(s), t["SIZE_LABEL"]) for s in cats) + 24 if center_labels else 0
    head = t["SIZE_LABEL"] * 2
    cax = CategoryAxis(n, y0 + head, y0 + h, 0.66)
    m = max([abs(v) for v in lvals + rvals] + [1e-9])
    half = (w - lab_w) / 2 - 36
    cx = x0 + w / 2
    lcol, rcol = apply_named(colors or [t["SERIES"][0], t["SERIES"][2]], [ln, rn], series_colors)
    hl = highlight or {}
    for i in range(n):
        yc = cax.center(i)
        for side, vals, raw, col in ((-1, lvals, lraw, lcol), (1, rvals, rraw, rcol)):
            v = abs(vals[i])
            L = v / m * half
            xs = cx + side * lab_w / 2
            fill = hl.get(i, col)
            c.rect(xs if side > 0 else xs - L, yc - cax.bar / 2, L, cax.bar, fill=fill)
            c.text(xs + side * (L + 4), yc, fmt(raw[i], dec=dec), t["SIZE_LABEL"] - 0.5, t["FG"],
                   "start" if side > 0 else "end", "middle")
        if center_labels:
            c.text(cx, yc, str(cats[i]), t["SIZE_LABEL"], t["FG"], "middle", "middle")
    c.text(cx - lab_w / 2, y0 + head * 0.4, ln, t["SIZE_LABEL"], lcol, "end", "middle", True)
    c.text(cx + lab_w / 2, y0 + head * 0.4, rn, t["SIZE_LABEL"], rcol, "start", "middle", True)
    c.line(cx - lab_w / 2, y0 + head * 0.8, cx - lab_w / 2, y0 + h, t["AXIS"], 0.8)
    c.line(cx + lab_w / 2, y0 + head * 0.8, cx + lab_w / 2, y0 + h, t["AXIS"], 0.8)
    return Ctx(fig, "h", cax, ValueAxis(0, m, cx, cx + half), [ln, rn], cats)


# ---------------------------------------------------------------- 瀑布
def waterfall(fig, steps, dec=None, unit="", mag="", build_down=False, connectors=True, width=0.6,
              colors=None, show_axis=False, breaks=None, series_names=None, first_total=True,
              reverse_start=None, legend="auto", legend_reverse=False, series_colors=None,
              colors_pnt=None):
    """
    steps: [(标签, 值 | 'e' | [多段值])]
      * 第一项默认是起点合计（落地）
      * 'e'：自动计算到此的累计值，画成落地的小计/合计柱（think-cell 的 e）
      * [a, b, ...]：多段瀑布（每段一个系列，颜色取 series_names 顺序）
      * 负值向下；跨越 0 轴的段按代数和继续计算
    build_down=True：总量 → 各组成部分逐项扣减（中性色，无正负号）
    reverse_start=(终点标签, 终点值)：首列为 e —— 已知终点反推起点
    """
    t, c = fig.t, fig.c
    steps = list(steps)
    if reverse_start:
        lab, endv = reverse_start
        deltas = sum((sum(v) if isinstance(v, (list, tuple)) else v) for _, v in steps[1:] if v != "e")
        steps[0] = (steps[0][0], endv - deltas)
        steps.append((lab, "e"))
    n = len(steps)
    kinds, bars, run = [], [], 0.0
    multi = any(isinstance(v, (list, tuple)) for _, v in steps)
    for i, (lab, v) in enumerate(steps):
        if i == 0 and first_total and v != "e":
            tv = sum(v) if isinstance(v, (list, tuple)) else float(v)
            run = tv
            bars.append((0.0, tv, v))
            kinds.append("total")
        elif v == "e":
            bars.append((0.0, run, run))
            kinds.append("total")
        else:
            dv = sum(v) if isinstance(v, (list, tuple)) else float(v)
            if build_down:
                dv = -abs(dv)
            bars.append((run, run + dv, v))
            kinds.append("part" if build_down else ("pos" if dv >= 0 else "neg"))
            run += dv
    allv = [b for a, b0, _ in bars for b in (a, b0)]
    dec = auto_dec([b[1] - b[0] for b in bars]) if dec is None else dec
    x0, y0, w, h = fig.box
    cax = CategoryAxis(n, x0 + (34 if show_axis else 0), x0 + w, width)
    lo, hi = min(allv + [0]), max(allv + [0])
    span = (hi - lo) or 1
    vax = ValueAxis(lo - (span * 0.04 if lo < 0 else 0), hi, y0 + h - t["SIZE_LABEL"] * 1.7,
                    y0 + t["SIZE_LABEL"] * 1.8, breaks=breaks)
    ctx = Ctx(fig, "v", cax, vax, series_names or [], [s[0] for s in steps])
    ctx.dec, ctx.mag = dec, mag
    if show_axis:
        draw_value_axis(ctx, True, False, dict(mag=mag))
    scol = colors or _auto_colors(t, max((len(v) for _, v in steps if isinstance(v, (list, tuple))), default=1))
    if series_names:
        scol = apply_named(scol, series_names, series_colors)
    if series_colors:   # 单系列瀑布：可按「合计/增加/减少/组成」改色
        t = dict(t)
        for key, nm in (("TOTAL", "合计"), ("POS", "增加"), ("NEG", "减少"), ("PART", "组成")):
            if series_colors.get(nm):
                t[key] = series_colors[nm]
    col = {"total": t["TOTAL"], "pos": t["POS"], "neg": t["NEG"], "part": t["PART"]}
    ctx.tops = []
    for i, ((b0, b1, raw), k) in enumerate(zip(bars, kinds)):
        xl, xr = cax.left(i), cax.right(i)
        if isinstance(raw, (list, tuple)):
            cur = b0
            for si, sv in enumerate(raw):
                sv = -abs(sv) if build_down and k != "total" else sv
                nv = cur + sv
                c.rect(xl, vax.pos(max(cur, nv)), cax.bar, abs(vax.pos(cur) - vax.pos(nv)), fill=scol[si],
                       stroke=t["BG"], sw=0.6)
                segpx = abs(vax.pos(cur) - vax.pos(nv))
                if segpx > 11:
                    c.text((xl + xr) / 2, vax.pos((cur + nv) / 2), fmt(abs(sv) if build_down else sv, dec=dec),
                           t["SIZE_LABEL"] - 0.5, text_on(scol[si], t))
                cur = nv
        else:
            c.rect(xl, vax.pos(max(b0, b1)), cax.bar, abs(vax.pos(b0) - vax.pos(b1)), fill=col[k])
        val = b1 - b0
        s = fmt(abs(val) if k == "part" else val, dec=dec, sign=(k in ("pos", "neg")), mag=mag)
        top = max(b0, b1)
        if (k == "neg" and not multi) or (k == "total" and b1 < 0):
            # 减少：标签放在段下方，避免和连接线重叠
            c.text((xl + xr) / 2, vax.pos(min(b0, b1)) + 3, s, t["SIZE_LABEL"], t["FG"], "middle", "top")
        else:
            c.text((xl + xr) / 2, vax.pos(top) - 3, s, t["SIZE_LABEL"], t["FG"], "middle", "bottom",
                   bold=(k == "total"))
        ctx.tops.append(top)
        ctx.seg[(0, i)] = (b0, b1)
        if connectors and i < n - 1:
            nxt0 = bars[i + 1][0] if kinds[i + 1] != "total" else bars[i + 1][1]
            lvl = b1
            c.line(xr, vax.pos(lvl), cax.left(i + 1), vax.pos(lvl), t["GUIDE"], 0.7)
    ctx.totals = [b[1] for b in bars]
    ctx.label_top = [tp + _val_of_px(ctx, t["SIZE_LABEL"] * 1.6) for tp in ctx.tops]
    draw_baseline(ctx)
    draw_breaks(ctx)
    draw_cat_labels(ctx, [s[0] for s in steps])
    if multi and series_names:
        lg = LG.norm(legend, "top")
        if lg != "none":
            LG.draw(fig, dict(where="top", x=x0, y=y0 - 14, w=w), series_names, scol, reverse=legend_reverse)
    return ctx
