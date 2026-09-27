"""
折线家族：折线 / 轮廓图（profile）/ 面积（堆积·100%）/ 组合（柱+线，次坐标轴）/ Pareto /
K 线 / 足球场图 / 误差线 / 平滑 / 缺失值插值 / 日期轴。
"""
from __future__ import annotations

import math

from .axes import CategoryAxis, DateAxis, ValueAxis, nice_range
from .canvas import text_w
from .charts_bar import (Ctx, _val_of_px, draw_baseline, draw_breaks, draw_cat_labels, draw_value_axis,
                         swatch_legend)
from .numfmt import auto_dec, fmt
from . import legend as LG
from .style import apply_named, cat_colors, series_colors as _auto_colors


def _interp(vals):
    """缺失值（None）线性插值（think-cell 默认）。"""
    v = list(vals)
    idx = [i for i, x in enumerate(v) if x is not None]
    for i in range(len(v)):
        if v[i] is None:
            lo = max([j for j in idx if j < i], default=None)
            hi = min([j for j in idx if j > i], default=None)
            if lo is not None and hi is not None:
                v[i] = v[lo] + (v[hi] - v[lo]) * (i - lo) / (hi - lo)
    return v


def _smooth(pts, k=8):
    """Catmull-Rom 平滑。"""
    if len(pts) < 3:
        return pts
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for s in range(k):
            u = s / k
            u2, u3 = u * u, u * u * u
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * u + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2
                       + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2
                       + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3)
            out.append((x, y))
    out.append(pts[-1])
    return out


def line(fig, cats, series: dict, dec=None, unit="", pct=False, mag="", colors=None, highlight=None,
         end_labels=True, markers="last", point_labels=False, smooth=False, interpolate=True,
         errors=None, show_axis=True, grid=True, zero_based=False, profile=False, log=False,
         reverse=False, dates=None, date_scale="year", breaks=None, secondary=None, sec_fmt=None,
         legend="auto", legend_reverse=False, series_colors=None, line_styles=None, marker_shapes=None):
    """
    markers: none | last | all
    highlight: 系列名 —— 该系列用强调色，其余灰
    errors: {系列: [(低, 高), ...]} 误差线
    profile=True: 轮廓图（旋转 90°，类目在纵轴，常用于评分/对标）
    dates: [日期...] 使用日期轴（横轴按真实时间间距）
    secondary: [系列名] 放到右侧次坐标轴
    """
    t, c = fig.t, fig.c
    names = list(series)
    k, n = len(names), len(cats)
    vals = {nm: (_interp(series[nm]) if interpolate else list(series[nm])) for nm in names}
    orig = {nm: list(series[nm]) for nm in names}
    cols = apply_named(colors or cat_colors(t, k), names, series_colors)
    if highlight:
        cols = [t["ACCENT"] if nm == highlight else "#BFBFBF" for nm in names]
    lg = LG.norm(legend, "label" if end_labels else "top")
    if profile and lg == "label":
        lg = "top"
    if k == 1 and lg in ("top", "bottom", "side"):
        lg = "none"
    end_labels = lg == "label"
    spot = LG.reserve(fig, lg, names)
    sec = set(secondary or [])
    prim_v = [v for nm in names if nm not in sec for v in vals[nm] if v is not None]
    sec_v = [v for nm in names if nm in sec for v in vals[nm] if v is not None]
    if errors:
        for nm, e in errors.items():
            prim_v += [x for lo_hi in e for x in lo_hi]
    dec = auto_dec(prim_v + sec_v) if dec is None and not pct else (dec if dec is not None else 0)
    x0, y0, w, h = fig.box
    lab_w = max(text_w(f"{nm} {fmt(vals[nm][-1] or 0, dec=dec, pct=pct)}", t["SIZE_LABEL"]) for nm in names) + 10 \
        if end_labels and not profile else 0
    axis_w = 36 if show_axis else 6
    sec_w = 40 if sec else 0
    if sec:
        lab_w += 4
    lo, hi = min(prim_v), max(prim_v)
    if zero_based or lo >= 0 and lo < (hi - lo) * 0.6:
        lo = min(lo, 0)
    vlo, vhi, st = nice_range(lo, hi, 5, include_zero=zero_based)
    if profile:
        cax = CategoryAxis(n, y0 + 6, y0 + h, 1.0)
        lab = max(text_w(str(s), t["SIZE_LABEL"]) for s in cats) + 10
        vax = ValueAxis(vlo, vhi, x0 + lab, x0 + w - 10, log=log, reverse=reverse, step=st)
        orient = "h"
    else:
        cax = CategoryAxis(n, x0 + axis_w, x0 + w - lab_w - sec_w, 1.0)
        if dates:
            dax = DateAxis(dates[0], dates[-1], cax.center(0), cax.center(n - 1))
            cax.center = lambda i, _d=dates, _a=dax: _a.pos(_d[int(round(i))])
        bottom = y0 + h - t["SIZE_LABEL"] * 1.8
        top = y0 + 6
        vax = ValueAxis(vlo if not log else 10 ** int(__import__("math").floor(__import__("math").log10(min(prim_v)))),
                        vhi if not log else 10 ** int(__import__("math").ceil(__import__("math").log10(max(prim_v)))),
                        bottom, top, log=log, reverse=reverse, breaks=breaks, step=st)
        orient = "v"
    ctx = Ctx(fig, orient, cax, vax, names, cats)
    ctx.dec, ctx.mag = dec, mag
    if show_axis or grid:
        draw_value_axis(ctx, show_axis, grid, dict(pct=pct, dec=0 if pct else None, mag=mag))
    sax = None
    if sec:
        slo, shi, sst = nice_range(min(sec_v), max(sec_v), 5, include_zero=zero_based)
        sax = ValueAxis(slo, shi, vax.p0, vax.p1, step=sst)
        for v in sax.ticks():
            c.text(cax.p1 + 6, sax.pos(v), fmt(v, **(sec_fmt or {})), t["SIZE_SMALL"], t["FG_MUTED"], "start", "middle")
    ends = []
    for si, nm in enumerate(names):
        ax = sax if nm in sec else vax
        pts = []
        for i, v in enumerate(vals[nm]):
            if v is None:
                if len(pts) > 1:
                    c.poly(_smooth(pts) if smooth else pts, stroke=cols[si], sw=2.0, closed=False)
                pts = []
                continue
            pts.append(ctx.P(cax.center(i), v) if ax is vax else (cax.center(i), ax.pos(v)))
        emphasize = (highlight is None or nm == highlight)
        if len(pts) > 1:
            c.poly(_smooth(pts) if smooth else pts, stroke=cols[si], sw=2.2 if emphasize else 1.4,
                   closed=False, dash="5 3" if nm in sec else None)
        if errors and nm in errors:
            for i, (elo, ehi) in enumerate(errors[nm]):
                a, b = ctx.P(cax.center(i), elo), ctx.P(cax.center(i), ehi)
                c.line(a[0], a[1], b[0], b[1], cols[si], 0.8)
                for p in (a, b):
                    if orient == "v":
                        c.line(p[0] - 3, p[1], p[0] + 3, p[1], cols[si], 0.8)
                    else:
                        c.line(p[0], p[1] - 3, p[0], p[1] + 3, cols[si], 0.8)
        for i, v in enumerate(vals[nm]):
            if v is None:
                continue
            p = ctx.P(cax.center(i), v) if ax is vax else (cax.center(i), ax.pos(v))
            if markers == "all" or (markers == "last" and i == n - 1):
                c.circle(p[0], p[1], 2.8, fill=cols[si], stroke=t["BG"], sw=0.8)
            if point_labels and emphasize and orig[nm][i] is not None:
                c.text(p[0], p[1] - 6, fmt(v, dec=dec, pct=pct, mag=mag), t["SIZE_SMALL"] + 0.5, t["FG"],
                       "middle", "bottom")
        last = vals[nm][-1]
        if last is not None:
            p = ctx.P(cax.center(n - 1), last) if ax is vax else (cax.center(n - 1), ax.pos(last))
            ends.append([p[1], p[1], nm, cols[si], last, nm in sec])
    if end_labels and not profile:
        ends.sort(key=lambda e: e[0])
        gap = t["SIZE_LABEL"] * 1.25
        for j in range(1, len(ends)):
            if ends[j][1] - ends[j - 1][1] < gap:
                ends[j][1] = ends[j - 1][1] + gap
        xe = (cax.p1 + sec_w + 2) if sec else cax.center(n - 1) + 8
        for y, yl, nm, col, v, is_sec in ends:
            colr = col if col != "#BFBFBF" else t["FG_MUTED"]
            vs = fmt(v, **(sec_fmt or {})) if is_sec else fmt(v, dec=dec, pct=pct, mag=mag)
            c.text(xe, yl, f"{nm}  {vs}", t["SIZE_LABEL"] - 0.5, colr, "start", "middle", bold=(nm == highlight))
    LG.draw(fig, spot, names, cols, markers=["line"] * k, reverse=legend_reverse)
    if orient == "v":
        base_v = vax.vmin if not reverse else vax.vmax
        a, b = (cax.p0, vax.pos(vax.vmin)), (cax.p1, vax.pos(vax.vmin))
        c.line(cax.p0, vax.p0, cax.p1, vax.p0, t["AXIS"], 0.8)
        if dates:
            dax2 = DateAxis(dates[0], dates[-1], cax.center(0), cax.center(n - 1))
            for d, labx, major in dax2.ticks(date_scale):
                c.text(dax2.pos(d), vax.p0 + 5, labx, t["SIZE_LABEL"], t["FG"], "middle", "top")
        else:
            for i, s in enumerate(cats):
                c.text(cax.center(i), vax.p0 + 5, str(s), t["SIZE_LABEL"], t["FG"], "middle", "top")
    else:
        for i, s in enumerate(cats):
            c.text(vax.p0 - 6, cax.center(i), str(s), t["SIZE_LABEL"], t["FG"], "end", "middle")
            c.line(vax.p0, cax.center(i), vax.p1, cax.center(i), t["GRID"], 0.5)
    draw_breaks(ctx, wave=True)
    ctx.totals = [vals[names[0]][i] for i in range(n)]
    ctx.tops = ctx.totals
    ctx.cols = cols
    return ctx


def area(fig, cats, series: dict, mode="stacked", dec=None, unit="", colors=None, labels=True,
         legend="auto", show_axis=False, legend_reverse=False, series_colors=None):
    """面积图：stacked | 100 | overlap。系列名写在右端。"""
    t, c = fig.t, fig.c
    names = list(series)
    k, n = len(names), len(cats)
    raw = [[float(v or 0) for v in series[nm]] for nm in names]
    sums = [sum(r[i] for r in raw) for i in range(n)]
    data = [[r[i] / sums[i] if sums[i] else 0 for i in range(n)] for r in raw] if mode == "100" else raw
    cols = apply_named(colors or _auto_colors(t, k), names, series_colors)
    dec = auto_dec([v for r in raw for v in r]) if dec is None else dec
    lg = LG.norm(legend, "label")
    spot = LG.reserve(fig, lg, names)
    x0, y0, w, h = fig.box
    leg_w = max(text_w(nm, t["SIZE_LABEL"]) for nm in names) + 12 if lg == "label" else 8
    cax = CategoryAxis(n, x0 + (30 if show_axis or mode == "100" else 0), x0 + w - leg_w, 1.0)
    hi = 1.0 if mode == "100" else (max(sums) if mode == "stacked" else max(v for r in data for v in r))
    vax = ValueAxis(0, hi * (1.0 if mode == "100" else 1.08), y0 + h - t["SIZE_LABEL"] * 1.8, y0 + 12)
    ctx = Ctx(fig, "v", cax, vax, names, cats)
    ctx.dec = dec
    if show_axis:
        draw_value_axis(ctx, True, False, dict(pct=(mode == "100")))
    base = [0.0] * n
    xs = [cax.center(i) for i in range(n)]
    xs[0], xs[-1] = cax.p0, cax.p1
    for si, nm in enumerate(names):
        top = [base[i] + data[si][i] for i in range(n)] if mode != "overlap" else data[si]
        bot = base if mode != "overlap" else [0.0] * n
        pts = [(xs[i], vax.pos(top[i])) for i in range(n)] + [(xs[i], vax.pos(bot[i])) for i in range(n - 1, -1, -1)]
        c.poly(pts, fill=cols[si], stroke=t["BG"], sw=0.8, opacity=0.85 if mode == "overlap" else 1)
        for i in range(n):
            ctx.seg[(si, i)] = (bot[i], top[i])
        mid = vax.pos((top[-1] + bot[-1]) / 2)
        if lg == "label":
            c.text(cax.p1 + 6, mid, nm, t["SIZE_LABEL"] - 0.5, t["FG"], "start", "middle")
        if labels and mode != "overlap":
            for i in range(1, n - 1):
                hpx = abs(vax.pos(top[i]) - vax.pos(bot[i]))
                if hpx > 13:
                    s = fmt(data[si][i], dec=0, pct=True) if mode == "100" else fmt(data[si][i], dec=dec)
                    from .style import text_on
                    c.text(xs[i], vax.pos((top[i] + bot[i]) / 2), s, t["SIZE_SMALL"] + 0.5, text_on(cols[si], t))
        if mode != "overlap":
            base = top
    c.line(cax.p0, vax.pos(0), cax.p1, vax.pos(0), t["AXIS"], 0.8)
    for i, s in enumerate(cats):
        c.text(cax.center(i), vax.p0 + 5, str(s), t["SIZE_LABEL"], t["FG"], "middle", "top")
    if mode == "100":
        c.text(cax.p0 - 3, vax.pos(1), "100%", t["SIZE_SMALL"], t["FG_MUTED"], "end", "middle")
    LG.draw(fig, spot, names, cols, reverse=legend_reverse)
    ctx.totals = sums
    ctx.tops = [1.0] * n if mode == "100" else sums
    return ctx


def combo(fig, cats, bars: dict, lines: dict, bar_mode="stacked", dec=None, line_fmt=None,
          secondary=True, colors=None, line_colors=None, show_axis=False, line_labels=True,
          legend="auto", legend_reverse=False, series_colors=None):
    """
    组合图：柱（堆积/簇状）+ 折线。secondary=True 时折线用右侧次坐标轴。
    line_fmt: 次轴数字格式，如 dict(pct=True, dec=0)
    """
    from .charts_bar import column
    t, c = fig.t, fig.c
    lf = line_fmt or {}
    # 右侧给次轴刻度 + 折线标签让出空间
    lg = LG.norm(legend, "top")
    if lg == "label":
        lg = "top"
    leg_names = list(bars) + [nm + ("（右轴）" if secondary else "") for nm in lines]
    spot = LG.reserve(fig, lg, leg_names)
    ox0, oy0, ow, oh = fig.box
    fig.box = (ox0, oy0, ow - (44 if secondary else 0), oh)
    ctx = column(fig, cats, bars, mode=bar_mode, dec=dec, colors=colors, legend="none", show_axis=show_axis,
                 labels="none" if len(bars) == 1 else "value", totals=len(bars) > 1, series_colors=series_colors)
    from .style import text_on
    if len(bars) == 1:
        nm0 = list(bars)[0]
        col0 = ctx.cols[0]
        for i, v in enumerate(bars[nm0]):
            c.text(ctx.cax.center(i), ctx.vax.pos(0) - 5, fmt(v, dec=ctx.dec), t["SIZE_LABEL"], text_on(col0, t), "middle",
                   "bottom", bold=True)
    fig.box = (ox0, oy0, ow, oh)
    lcols = apply_named(line_colors or [t["ACCENT"], "#595959", "#A6A6A6"][:len(lines)] + ["#595959"] * 3, list(lines), series_colors)
    allv = [v for s in lines.values() for v in s if v is not None]
    if secondary:
        lo, hi, st = nice_range(min(allv), max(allv), 5, include_zero=True)
        sax = ValueAxis(lo, hi * 1.05, ctx.vax.p0, ctx.vax.p1 + 10, step=st)
        for v in sax.ticks():
            c.text(ctx.cax.p1 + 8, sax.pos(v), fmt(v, **lf), t["SIZE_SMALL"], t["FG_MUTED"], "start", "middle")
    else:
        sax = ctx.vax
    for li, (nm, vals) in enumerate(lines.items()):
        col = lcols[li % len(lcols)]
        pts = [(ctx.cax.center(i), sax.pos(v)) for i, v in enumerate(vals) if v is not None]
        c.poly(pts, stroke=col, sw=2.0, closed=False)
        for i, v in enumerate(vals):
            if v is None:
                continue
            p = (ctx.cax.center(i), sax.pos(v))
            c.circle(p[0], p[1], 3, fill=t["BG"], stroke=col, sw=1.6)
            if line_labels:
                c.label_box(p[0], p[1] - 12, fmt(v, **lf), t["SIZE_SMALL"] + 0.5, stroke=col, color=col, r=2, pad=2)
    LG.draw(fig, spot, leg_names, list(ctx.cols) + [lcols[i % len(lcols)] for i in range(len(lines))],
            markers=["rect"] * len(bars) + ["line"] * len(lines), reverse=legend_reverse)
    ctx.extra["sax"] = sax
    return ctx


def pareto(fig, cats, values, dec=None, threshold=0.8, color=None, legend="auto", **_):
    """Pareto：降序柱 + 累计占比折线（右轴）+ 80% 参考线。"""
    t, c = fig.t, fig.c
    order = sorted(range(len(cats)), key=lambda i: -values[i])
    cats = [cats[i] for i in order]
    values = [values[i] for i in order]
    tot = sum(values)
    if not values or any(not math.isfinite(v) or v < 0 for v in values) or tot <= 0:
        raise ValueError("Pareto values must be finite, non-negative, and have a positive total")
    cum, s = [], 0
    for v in values:
        s += v
        cum.append(s / tot)
    ctx = combo(fig, cats, {"数值": values}, {"累计占比": cum}, line_fmt=dict(pct=True, dec=0), dec=dec,
                colors=[color or t["SERIES"][1]], line_colors=[t["ACCENT"]], line_labels=False, legend=legend)
    sax = ctx.extra["sax"]
    # 只标关键点：跨过阈值的那个
    cut = next(i for i, v in enumerate(cum) if v >= threshold - 1e-9)
    y = sax.pos(threshold)
    c.line(ctx.cax.p0, y, ctx.cax.p1, y, t["FG_MUTED"], 0.8, "4 3")
    c.text(ctx.cax.p0 + 2, y - 2, f"{int(threshold * 100)}%", t["SIZE_SMALL"], t["FG_MUTED"], "start", "bottom")
    p = (ctx.cax.center(cut), sax.pos(cum[cut]))
    c.label_box(p[0] + 26, p[1] + 12, f"前 {cut + 1} 项 {fmt(cum[cut], dec=0, pct=True)}", t["SIZE_SMALL"] + 0.5)
    return ctx


def candlestick(fig, cats, ohlc, dec=2, show_axis=True, grid=True, ma=None):
    """
    K 线：ohlc = [(开, 高, 低, 收)]；红涨绿跌（中国习惯，改 theme UP/DOWN 可切换）。
    ma: {名称: 周期} 叠加均线
    """
    t, c = fig.t, fig.c
    n = len(cats)
    x0, y0, w, h = fig.box
    lo, hi = min(o[2] for o in ohlc), max(o[1] for o in ohlc)
    pad = (hi - lo) * 0.08
    vlo, vhi, st = nice_range(lo - pad, hi + pad, 5, include_zero=False)
    cax = CategoryAxis(n, x0 + 40, x0 + w - 10, 0.62)
    vax = ValueAxis(vlo, vhi, y0 + h - t["SIZE_LABEL"] * 1.8, y0 + 18, step=st)
    ctx = Ctx(fig, "v", cax, vax, ["K"], cats)
    draw_value_axis(ctx, show_axis, grid, dict(dec=dec if dec is not None else None))
    for i, (o, hgh, low, cl) in enumerate(ohlc):
        col = t["UP"] if cl >= o else t["DOWN"]
        xc = cax.center(i)
        c.line(xc, vax.pos(hgh), xc, vax.pos(low), col, 0.9)
        y1, y2 = vax.pos(max(o, cl)), vax.pos(min(o, cl))
        c.rect(cax.left(i), y1, cax.bar, max(y2 - y1, 0.8), fill=col if cl >= o else col)
    if ma:
        closes = [o[3] for o in ohlc]
        for mi, (nm, p) in enumerate(ma.items()):
            pts = []
            for i in range(p - 1, n):
                pts.append((cax.center(i), vax.pos(sum(closes[i - p + 1:i + 1]) / p)))
            col = ["#1F5A8C", "#ED7D31", "#7F7F7F"][mi % 3]
            if len(pts) > 1:
                c.poly(pts, stroke=col, sw=1.2, closed=False)
            c.text(x0 + 44 + mi * 60, y0 + 6, nm, t["SIZE_SMALL"], col, "start", "middle", bold=True)
    step = max(1, n // 8)
    for i in range(0, n, step):
        c.text(cax.center(i), vax.p0 + 5, str(cats[i]), t["SIZE_SMALL"] + 0.5, t["FG"], "middle", "top")
    c.line(cax.p0, vax.p0, cax.p1, vax.p0, t["AXIS"], 0.8)
    return ctx


def football(fig, rows, ref=None, ref_label="当前", dec=0, unit="", color=None, marks=None):
    """
    足球场图（估值区间）：rows = [(方法, 低, 高)]；ref 竖线（如当前股价）；
    marks: {方法: 值} 区间内的点（如中值）
    """
    t, c = fig.t, fig.c
    n = len(rows)
    x0, y0, w, h = fig.box
    lab = max(text_w(r[0], t["SIZE_LABEL"]) for r in rows) + 12
    lo, hi = min(r[1] for r in rows), max(r[2] for r in rows)
    if ref is not None:
        lo, hi = min(lo, ref), max(hi, ref)
    span = hi - lo
    vlo, vhi, st = nice_range(lo - span * 0.15, hi + span * 0.15, 5, include_zero=False)
    cax = CategoryAxis(n, y0 + 16, y0 + h - 18, 0.55)
    vax = ValueAxis(vlo, vhi, x0 + lab, x0 + w - 10, step=st)
    ctx = Ctx(fig, "h", cax, vax, [], [r[0] for r in rows])
    for v in vax.ticks():
        c.line(vax.pos(v), cax.p0, vax.pos(v), cax.p1, t["GRID"], 0.5)
        c.text(vax.pos(v), cax.p1 + 4, fmt(v, dec=dec) + unit, t["SIZE_SMALL"], t["FG_MUTED"], "middle", "top")
    col = color or t["SERIES"][2]
    for i, (nm, a, b) in enumerate(rows):
        yc = cax.center(i)
        c.rect(vax.pos(a), yc - cax.bar / 2, vax.pos(b) - vax.pos(a), cax.bar, fill=col)
        c.text(vax.pos(a) - 4, yc, fmt(a, dec=dec), t["SIZE_SMALL"] + 0.5, t["FG"], "end", "middle")
        c.text(vax.pos(b) + 4, yc, fmt(b, dec=dec), t["SIZE_SMALL"] + 0.5, t["FG"], "start", "middle")
        c.text(x0 + lab - 8, yc, nm, t["SIZE_LABEL"], t["FG"], "end", "middle")
        if marks and nm in marks:
            m = marks[nm]
            c.line(vax.pos(m), yc - cax.bar / 2, vax.pos(m), yc + cax.bar / 2, t["BG"], 1.6)
    if ref is not None:
        x = vax.pos(ref)
        c.line(x, cax.p0 - 6, x, cax.p1, t["ACCENT"], 1.2, "4 3")
        c.text(x, cax.p0 - 8, f"{ref_label} {fmt(ref, dec=dec)}{unit}", t["SIZE_SMALL"] + 0.5, t["ACCENT"], "middle",
               "bottom", bold=True)
    return ctx
