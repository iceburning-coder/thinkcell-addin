"""饼图 / 圆环 / 分离扇区 / Pie-of-pie / 同心圆环 / 量规（Gauge）。"""
from __future__ import annotations

import math

from .canvas import text_w
from .numfmt import fmt
from . import legend as LG
from .style import apply_named, series_colors as _auto_colors, text_on


def _pt(cx, cy, r, a):
    rad = math.radians(a - 90)
    return cx + r * math.cos(rad), cy + r * math.sin(rad)


def pie(fig, labels, values, donut=0.0, explode=None, dec=0, colors=None, sort=True, other_below=None,
        center_text=None, show_values=False, start=0.0, cx=None, cy=None, r=None, label_side=True,
        legend="auto", legend_reverse=False, series_colors=None, order="desc"):
    """
    donut: 内径比例（0 = 饼图，0.55 = 圆环）
    explode: [序号] 分离扇区
    other_below: 占比低于该值的合并为"其他"
    center_text: 圆环中心文字（如合计）
    """
    t, c = fig.t, fig.c
    items = list(zip(labels, values))
    tot = sum(v for _, v in items)
    if other_below:
        big = [(l, v) for l, v in items if v / tot >= other_below]
        small = sum(v for l, v in items if v / tot < other_below)
        items = big + ([("其他", small)] if small else [])
    if sort and order != "sheet":
        oth = [x for x in items if x[0] == "其他"]
        items = sorted([x for x in items if x[0] != "其他"], key=lambda x: (-x[1] if order == "desc" else x[1])) + oth
    cols = colors or _auto_colors(t, len(items))
    for i, (l, _) in enumerate(items):
        if l == "其他" and not colors:
            cols[i] = t["OTHER"]
    cols = apply_named(cols, [l for l, _ in items], series_colors)
    lg = LG.norm(legend, "side") if label_side else "none"
    spot = LG.reserve(fig, lg, [l for l, _ in items]) if lg in ("top", "bottom") else None
    x0, y0, w, h = fig.box
    if lg == "label":
        r = r or min(h / 2 - 22, w / 3.4)
        cx = cx or (x0 + w / 2)
    else:
        r = r or min(h / 2 - 16, w / 4)
        cx = cx or (x0 + (w * 0.36 if lg == "side" else w / 2))
    cy = cy or (y0 + h / 2)
    a = start
    placed = []
    geo = []
    for i, (l, v) in enumerate(items):
        da = v / tot * 360
        mid = a + da / 2
        off = 8 if explode and i in explode else 0
        ox, oy = _pt(0, 0, off, mid)
        c.wedge(cx + ox, cy + oy, r, a, a + da, cols[i], r_in=r * donut, stroke=t["BG"], sw=1.2)
        share = fmt(v / tot, dec=dec, pct=True)
        # 段内标签（放得下时）
        rr = r * (0.5 + donut / 2) if donut else r * 0.62
        lx, ly = _pt(cx + ox, cy + oy, rr, mid)
        arc_len = math.radians(da) * rr
        if arc_len > text_w(share, t["SIZE_LABEL"]) + 4:
            c.text(lx, ly, share, t["SIZE_LABEL"] - 0.5, text_on(cols[i], t))
            inside = True
        else:
            inside = False
        geo.append((l, v, mid, inside, share, cols[i], off))
        a += da
    # 外侧标签：引线标注（label）或右侧列表（side）
    if lg == "label":
        _outside_labels(c, t, cx, cy, r, geo, show_values, y0, y0 + h)
    elif lg in ("top", "bottom"):
        LG.draw(fig, spot, [g[0] for g in geo], [g[5] for g in geo], reverse=legend_reverse)
    elif lg == "side":
        lx = cx + r + 30
        n = len(geo)
        gap = min(t["SIZE_LABEL"] * 1.9, (h - 10) / max(n, 1))
        ys = [cy - gap * (n - 1) / 2 + gap * i for i in range(n)]
        for (l, v, mid, inside, share, col, off), y in zip(geo, ys):
            px, py = _pt(cx, cy, r + off + 2, mid)
            c.rect(lx, y - 4, 8, 8, fill=col)
            s = f"{l}  {share}" + (f"（{fmt(v)}）" if show_values else "")
            c.text(lx + 12, y, s if not inside else f"{l}" + (f"  {fmt(v)}" if show_values else ""), t["SIZE_LABEL"],
                   t["FG"], "start", "middle")
    if center_text and donut:
        lines = center_text if isinstance(center_text, (list, tuple)) else [center_text]
        for j, s in enumerate(lines):
            c.text(cx, cy + (j - (len(lines) - 1) / 2) * t["SIZE_TITLE"] * 1.2, s,
                   t["SIZE_TITLE"] if j == 0 else t["SIZE_SMALL"] + 1, t["FG"] if j == 0 else t["FG_MUTED"],
                   bold=(j == 0))
    return dict(cx=cx, cy=cy, r=r, items=geo)


def _outside_labels(c, t, cx, cy, r, geo, show_values, ymin, ymax):
    """饼图外侧标签 + 引线；左右两侧分别纵向避让。"""
    size = t["SIZE_LABEL"]
    sides = {1: [], -1: []}
    for (l, v, mid, inside, share, col, off) in geo:
        px, py = _pt(cx, cy, r + off, mid)
        ex, ey = _pt(cx, cy, r + off + 12, mid)
        side = 1 if ex >= cx else -1
        s = (l if inside else f"{l} {share}") + (f"（{fmt(v)}）" if show_values else "")
        sides[side].append([ey, px, py, ex, s])
    gap = size * 1.35
    for side, arr in sides.items():
        arr.sort(key=lambda a: a[0])
        for j in range(1, len(arr)):
            if arr[j][0] - arr[j - 1][0] < gap:
                arr[j][0] = arr[j - 1][0] + gap
        over = (arr[-1][0] - (ymax - size)) if arr else 0
        if over > 0:
            for a in arr:
                a[0] -= over
        for ly, px, py, ex, s in arr:
            tx = cx + side * (r + 22)
            c.poly([(px, py), (ex, ly), (tx, ly)], stroke=t["GUIDE"], sw=0.6, closed=False)
            c.text(tx + side * 3, ly, s, size, t["FG"], "start" if side > 0 else "end", "middle")


def pie_of_pie(fig, labels, values, n_small=3, dec=0, colors=None, bar=True):
    """
    Pie-of-pie：最小的 n_small 项合并为"其他"，右侧用小饼（或 100% 条）展开。
    """
    t, c = fig.t, fig.c
    items = sorted(zip(labels, values), key=lambda x: -x[1])
    main, small = items[:-n_small], items[-n_small:]
    ssum = sum(v for _, v in small)
    tot = sum(values)
    x0, y0, w, h = fig.box
    r = min(h / 2 - 16, w / 5)
    cx, cy = x0 + r + 20, y0 + h / 2
    ml = [l for l, _ in main] + ["其他"]
    mv = [v for _, v in main] + [ssum]
    cols = colors or _auto_colors(t, len(main)) + [t["OTHER"]]
    # 让"其他"扇区朝右（3 点方向）
    start = 90 - (ssum / tot * 360) / 2 - sum(mv[:-1]) / tot * 360
    g = pie(fig, ml, mv, dec=dec, colors=cols, sort=False, start=start, cx=cx, cy=cy, r=r, label_side=False)
    # 主饼标签：引线
    for (l, v, mid, inside, share, col, off) in g["items"]:
        if l == "其他":
            continue
        px, py = _pt(cx, cy, r + 4, mid)
        tx, ty = _pt(cx, cy, r + 16, mid)
        c.line(px, py, tx, ty, t["GUIDE"], 0.6)
        c.text(tx + (-3 if tx < cx else 3), ty, f"{l} {share}" if not inside else l, t["SIZE_SMALL"] + 0.5, t["FG"],
               "end" if tx < cx else "start", "middle")
    bx = cx + r + 90
    bw, bh = 34, h - 40
    by = y0 + 20
    # 连接线：主饼"其他"扇区边缘 → 右侧展开
    a0 = 90 - (ssum / tot * 360) / 2
    a1 = 90 + (ssum / tot * 360) / 2
    p0, p1 = _pt(cx, cy, r, a0), _pt(cx, cy, r, a1)
    c.line(p0[0], p0[1], bx, by, t["GUIDE"], 0.7)
    c.line(p1[0], p1[1], bx, by + bh, t["GUIDE"], 0.7)
    scol = [t["SERIES"][2], t["SERIES"][3], t["SERIES"][4], "#DDE9F5", "#EEF4FA"]
    yy = by
    for i, (l, v) in enumerate(small):
        hh = v / ssum * bh
        c.rect(bx, yy, bw, hh, fill=scol[i % len(scol)], stroke=t["BG"], sw=0.8)
        c.text(bx + bw + 6, yy + hh / 2, f"{l}  {fmt(v / tot, dec=dec, pct=True)}", t["SIZE_SMALL"] + 0.5,
               t["FG"], "start", "middle")
        yy += hh
    c.text(bx + bw / 2, by - 4, f"其他 {fmt(ssum / tot, dec=dec, pct=True)}", t["SIZE_SMALL"] + 0.5, t["FG_MUTED"],
           "middle", "bottom")


def concentric(fig, labels, series: dict, dec=0, colors=None, series_colors=None, **_):
    """同心圆环：每个系列一圈（内→外），比较结构变化（如 2020 vs 2025 构成）。"""
    t, c = fig.t, fig.c
    names = list(series)
    x0, y0, w, h = fig.box
    R = min(h / 2 - 12, w / 4)
    cx, cy = x0 + w * 0.34, y0 + h / 2
    cols = apply_named(colors or _auto_colors(t, len(labels)), labels, series_colors)
    ring = R * 0.72 / len(names)
    for k, nm in enumerate(names):
        vals = series[nm]
        tot = sum(vals)
        r_in = R * 0.28 + ring * k
        r_out = r_in + ring * 0.92
        a = 0
        for i, v in enumerate(vals):
            da = v / tot * 360
            c.wedge(cx, cy, r_out, a, a + da, cols[i], r_in=r_in, stroke=t["BG"], sw=1)
            if math.radians(da) * (r_in + r_out) / 2 > 26 and ring > 14:
                p = _pt(cx, cy, (r_in + r_out) / 2, a + da / 2)
                c.text(p[0], p[1], fmt(v / tot, dec=dec, pct=True), t["SIZE_SMALL"], text_on(cols[i], t))
            a += da
        p = _pt(cx, cy, (r_in + r_out) / 2, 0)
        c.text(p[0] - 4, p[1], nm, t["SIZE_SMALL"], t["FG"], "end", "middle", bold=True)
    lx = cx + R + 30
    for i, l in enumerate(labels):
        y = cy - (len(labels) - 1) * 9 + i * 18
        c.rect(lx, y - 4, 8, 8, fill=cols[i])
        c.text(lx + 12, y, l, t["SIZE_LABEL"], t["FG"], "start", "middle")


def gauge(fig, value, vmin=0.0, vmax=1.0, bands=None, label=None, pct=True, dec=0, target=None):
    """
    量规（半环）：bands = [(上限, 颜色)] 分区（如 红/黄/绿）；指针指向 value；target 目标刻度。
    """
    t, c = fig.t, fig.c
    x0, y0, w, h = fig.box
    R = min(w / 2 - 20, h - 70)
    cx, cy = x0 + w / 2, y0 + R + 14
    ang = lambda v: -90 + (v - vmin) / (vmax - vmin) * 180
    bands = bands or [(vmax, t["SERIES"][3])]
    a = vmin
    for ub, col in bands:
        c.wedge(cx, cy, R, ang(a), ang(ub), col, r_in=R * 0.68, stroke=t["BG"], sw=1.5)
        a = ub
    # 已完成部分：深色覆盖
    c.wedge(cx, cy, R * 0.66, ang(vmin), ang(value), t["SERIES"][0], r_in=R * 0.6, stroke=None, sw=0)
    p = _pt(cx, cy, R * 0.92, ang(value))
    c.poly([_pt(cx, cy, 5, ang(value) - 90), p, _pt(cx, cy, 5, ang(value) + 90)], fill=t["FG"])
    c.circle(cx, cy, 6, fill=t["FG"])
    if target is not None:
        q0, q1 = _pt(cx, cy, R * 0.64, ang(target)), _pt(cx, cy, R + 6, ang(target))
        c.line(q0[0], q0[1], q1[0], q1[1], t["ACCENT"], 2)
        q = _pt(cx, cy, R + 14, ang(target))
        c.text(q[0], q[1], f"目标 {fmt(target, dec=dec, pct=pct)}", t["SIZE_SMALL"] + 0.5, t["ACCENT"], "middle", "middle")
    c.text(cx, cy + 12, fmt(value, dec=dec, pct=pct), t["SIZE_TITLE"] + 8, t["FG"], "middle", "top", bold=True)
    if label:
        c.text(cx, cy + 12 + (t["SIZE_TITLE"] + 8) * 1.3, label, t["SIZE_LABEL"], t["FG_MUTED"], "middle", "top")
    c.text(cx - R * 0.84, cy + 4, fmt(vmin, dec=dec, pct=pct), t["SIZE_SMALL"], t["FG_MUTED"], "middle", "top")
    c.text(cx + R * 0.84, cy + 4, fmt(vmax, dec=dec, pct=pct), t["SIZE_SMALL"], t["FG_MUTED"], "middle", "top")
