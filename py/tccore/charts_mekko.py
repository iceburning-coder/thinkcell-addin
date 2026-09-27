"""Mekko：百分比轴（列宽=规模，高度=份额）与单位轴（宽、高独立）。"""
from __future__ import annotations

from .axes import ValueAxis, nice_range
from .canvas import text_w
from .charts_bar import Ctx
from .numfmt import auto_dec, fmt
from . import legend as LG
from .style import series_colors as _auto_colors, text_on


def mekko(fig, cats, series: dict, mode="pct", widths=None, dec=None, unit="", mag="", colors=None,
          other_threshold=None, sort_cols="desc", sort_segs="sheet", min_label_area=240,
          width_labels=True, highlight=None, legend="auto", show_axis=True, legend_reverse=False,
          series_colors=None):
    """
    mode='pct'：输入绝对值 {系列: [每列的值]}；列宽 = 列合计占比，段高 = 份额
    mode='units'：widths=[每列宽度]（独立输入），段高 = 绝对值，纵轴为单位
    other_threshold：某系列在所有列份额都低于该值 → 合并为"其他"（浅灰，置顶）
    sort_cols：desc | sheet（列按规模降序）；sort_segs：sheet | desc | asc（列内段排序）
    highlight：{系列名: 颜色}
    """
    t, c = fig.t, fig.c
    names = list(series)
    n = len(cats)
    raw = {k: [float(v or 0) for v in series[k]] for k in names}
    tot = [sum(raw[k][i] for k in names) for i in range(n)]
    if other_threshold:
        small = [k for k in names if all((raw[k][i] / tot[i] if tot[i] else 0) < other_threshold for i in range(n))]
        if small:
            oth = [sum(raw[k][i] for k in small) for i in range(n)]
            names = [k for k in names if k not in small and k != "其他"] + ["其他"]
            raw["其他"] = [a + b for a, b in zip(oth, series.get("其他", [0] * n))]
    cols = colors or _auto_colors(t, len([k for k in names if k != "其他"]))
    cmap = {}
    ci = 0
    for k in names:
        if k == "其他":
            cmap[k] = t["OTHER"]
        else:
            cmap[k] = cols[ci % len(cols)]
            ci += 1
    for k, v in list((highlight or {}).items()) + list((series_colors or {}).items()):
        if v:
            cmap[k] = v
    wv = widths if mode == "units" else tot
    order = list(range(n))
    if sort_cols == "desc":
        order.sort(key=lambda i: -wv[i])
    grand = sum(wv)
    dec = auto_dec(tot) if dec is None else dec
    lg = LG.norm(legend, "label")
    spot = LG.reserve(fig, lg, names)
    x0, y0, w, h = fig.box
    leg_w = max(text_w(k, t["SIZE_LABEL"]) for k in names) + 12 if lg == "label" else 0
    axis_w = 30 if show_axis else 0
    left, right = x0 + axis_w, x0 + w - leg_w
    top = y0 + t["SIZE_LABEL"] * 3.0
    bottom = y0 + h - t["SIZE_LABEL"] * (3.2 if width_labels else 1.9)
    if mode == "pct":
        vax = ValueAxis(0, 1, bottom, top)
    else:
        vmax = max(tot)
        lo, hi, st = nice_range(0, vmax, 5)
        vax = ValueAxis(0, hi, bottom, top, step=st)
    ctx = Ctx(fig, "v", None, vax, names, cats)
    if show_axis:
        for v in (vax.ticks() if mode == "units" else [0, .2, .4, .6, .8, 1.0]):
            c.text(left - 4, vax.pos(v), fmt(v, dec=0, pct=(mode == "pct"), mag=mag), t["SIZE_SMALL"],
                   t["FG_MUTED"], "end", "middle")
    x = left
    geo = []
    for i in order:
        cw = (right - left) * wv[i] / grand
        segs = [(k, raw[k][i]) for k in names]
        if sort_segs in ("desc", "asc"):
            body = [s for s in segs if s[0] != "其他"]
            body.sort(key=lambda s: -s[1] if sort_segs == "desc" else s[1])
            segs = body + [s for s in segs if s[0] == "其他"]
        b = 0.0
        for k, v in segs:
            hv = v / tot[i] if (mode == "pct" and tot[i]) else v
            y1, y2 = vax.pos(b + hv), vax.pos(b)
            c.rect(x, y1, cw, y2 - y1, fill=cmap[k], stroke=t["BG"], sw=0.8)
            if cw * (y2 - y1) >= min_label_area and v:
                s = fmt(hv, dec=0, pct=True) if mode == "pct" else fmt(v, dec=dec, mag=mag)
                if text_w(s, t["SIZE_SMALL"] + 0.5) < cw - 3 and (y2 - y1) > 11:
                    c.text(x + cw / 2, (y1 + y2) / 2, s, t["SIZE_SMALL"] + 0.5, text_on(cmap[k], t))
            ctx.seg[(names.index(k), i)] = (b, b + hv)
            b += hv
        # 列合计（顶部）与列宽标签（底部）
        c.text(x + cw / 2, vax.pos(b) - 3, fmt(tot[i] if mode == "pct" else wv[i], dec=dec, mag=mag), t["SIZE_LABEL"],
               t["FG"], "middle", "bottom", bold=True)
        lab = str(cats[i])
        if text_w(lab, t["SIZE_LABEL"]) > cw + 8:
            lab = lab[:max(1, int(cw / t["SIZE_LABEL"]))] + "…"
        c.text(x + cw / 2, bottom + 4, lab, t["SIZE_LABEL"], t["FG"], "middle", "top")
        if width_labels:
            c.text(x + cw / 2, bottom + 4 + t["SIZE_LABEL"] * 1.3, fmt(wv[i] / grand, dec=0, pct=True),
                   t["SIZE_SMALL"], t["FG_MUTED"], "middle", "top")
        geo.append((i, x, cw))
        x += cw
    c.line(left, bottom, right, bottom, t["AXIS"], 0.8)
    if mode == "pct":
        c.text(left, y0 + 2, f"100% = {fmt(grand, dec=dec, mag=mag)}{unit}", t["SIZE_SMALL"], t["FG_MUTED"], "start", "top")
    # 系列名：写在最右列旁
    LG.draw(fig, spot, names, [cmap[k] for k in names], reverse=legend_reverse)
    if lg == "label":
        i, xl, cw = geo[-1]
        b, placed = 0.0, []
        for k in names:
            v = raw[k][i]
            hv = v / tot[i] if mode == "pct" else v
            y = vax.pos(b + hv / 2)
            if placed and placed[-1] - y < t["SIZE_LABEL"] * 1.15:
                y = placed[-1] - t["SIZE_LABEL"] * 1.15
            if v:
                placed.append(y)
                c.text(right + 6, y, k, t["SIZE_LABEL"] - 0.5, t["FG"], "start", "middle")
            b += hv
    ctx.extra["geo"] = geo
    ctx.totals = tot
    return ctx
