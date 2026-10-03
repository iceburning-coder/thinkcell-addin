"""表格：Harvey ball / 复选框 / 数值 / 迷你条 / 文本单元格，斑马纹，表头，合计行。"""
from __future__ import annotations

import math

from .canvas import text_w
from .numfmt import fmt


def harvey(c, t, cx, cy, r, v, maxv=4):
    """Harvey ball：v/maxv 填充（0–4 五档）。"""
    c.circle(cx, cy, r, fill=t["BG"], stroke=t["FG"], sw=0.9)
    frac = max(0, min(1, v / maxv))
    if frac >= 0.999:
        c.circle(cx, cy, r, fill=t["FG"])
    elif frac > 0:
        c.wedge(cx, cy, r, 0, 360 * frac, t["FG"], stroke=None, sw=0)


def checkbox(c, t, cx, cy, s, state="check"):
    """复选框：check ✓ | cross ✗ | empty。"""
    c.rect(cx - s / 2, cy - s / 2, s, s, fill=t["BG"], stroke=t["FG_MUTED"], sw=0.8, r=1.2)
    if state == "check":
        c.poly([(cx - s * 0.3, cy), (cx - s * 0.08, cy + s * 0.25), (cx + s * 0.32, cy - s * 0.28)],
               stroke="#2E8B57", sw=1.6, closed=False)
    elif state == "cross":
        c.line(cx - s * 0.28, cy - s * 0.28, cx + s * 0.28, cy + s * 0.28, "#C0392B", 1.4)
        c.line(cx - s * 0.28, cy + s * 0.28, cx + s * 0.28, cy - s * 0.28, "#C0392B", 1.4)


def table(fig, header, rows, col_types=None, col_w=None, dec=1, zebra=True, total_row=False,
          align=None, bar_max=None, highlight_rows=None, font_size=None):
    """
    header: [列名]；rows: [[单元格...]]
    col_types: 每列类型 text | num | pct | harvey | check | bar
        harvey: 0–4；check: 'check'/'cross'/'empty' 或 True/False；bar: 数值（画迷你条 + 数字）
    total_row: 最后一行加粗 + 上边线
    """
    t, c = fig.t, fig.c
    x0, y0, w, h = fig.box
    k = len(header)
    types = col_types or ["text"] + ["num"] * (k - 1)
    fs = font_size or t["SIZE_LABEL"]
    if not col_w:
        need = []
        for j in range(k):
            ws = [text_w(str(header[j]), fs, True)]
            for r in rows:
                v = r[j]
                if types[j] in ("num", "pct"):
                    ws.append(text_w(fmt(v, dec=dec, pct=types[j] == "pct"), fs))
                elif types[j] == "bar":
                    ws.append(70)
                elif types[j] in ("harvey", "check"):
                    ws.append(18)
                else:
                    ws.append(text_w(str(v), fs))
            need.append(max(ws) + 16)
        scale = w / sum(need)
        col_w = [v * scale for v in need]
    rh = min(fs * 2.2, (h - fs * 2.4) / max(len(rows), 1))
    xs = [x0]
    for cw in col_w:
        xs.append(xs[-1] + cw)
    # 表头
    hy = y0 + fs * 1.1
    for j, hd in enumerate(header):
        an = "start" if types[j] == "text" else "middle" if types[j] in ("harvey", "check", "bar") else "end"
        xx = xs[j] + 6 if an == "start" else (xs[j] + xs[j + 1]) / 2 if an == "middle" else xs[j + 1] - 6
        c.text(xx, hy, str(hd), fs - 0.5, t["FG_MUTED"], an, "middle", bold=True)
    c.line(x0, y0 + fs * 2.2, xs[-1], y0 + fs * 2.2, t["FG"], 1.0)
    ytop = y0 + fs * 2.2
    bmax = bar_max or max([abs(r[j]) for r in rows for j in range(k) if types[j] == "bar"] + [1])
    for i, r in enumerate(rows):
        yy = ytop + i * rh
        yc = yy + rh / 2
        last = total_row and i == len(rows) - 1
        if zebra and i % 2 == 1 and not last:
            c.rect(x0, yy, xs[-1] - x0, rh, fill=t["SHADE"])
        if highlight_rows and i in highlight_rows:
            c.rect(x0, yy, xs[-1] - x0, rh, fill="#FFF2CC")
        if last:
            c.line(x0, yy, xs[-1], yy, t["FG"], 0.8)
        for j in range(k):
            v = r[j]
            tp = types[j]
            if v in ("", None):
                continue
            if tp == "harvey":
                harvey(c, t, (xs[j] + xs[j + 1]) / 2, yc, min(rh * 0.3, 6), v)
            elif tp == "check":
                st = v if isinstance(v, str) else ("check" if v else "empty")
                checkbox(c, t, (xs[j] + xs[j + 1]) / 2, yc, min(rh * 0.5, 10), st)
            elif tp == "bar":
                bw = (xs[j + 1] - xs[j] - 44) * abs(v) / bmax
                c.rect(xs[j] + 6, yc - rh * 0.22, bw, rh * 0.44, fill=t["SERIES"][2] if v >= 0 else t["NEG"])
                c.text(xs[j] + 10 + bw, yc, fmt(v, dec=dec), fs - 0.5, t["FG"], "start", "middle")
            elif tp in ("num", "pct"):
                c.text(xs[j + 1] - 6, yc, fmt(v, dec=dec, pct=tp == "pct") if not isinstance(v, str) else v, fs,
                       t["FG"], "end", "middle", bold=last)
            else:
                c.text(xs[j] + 6, yc, str(v), fs, t["FG"], "start", "middle", bold=last)
    c.line(x0, ytop + len(rows) * rh, xs[-1], ytop + len(rows) * rh, t["AXIS"], 0.8)
    return dict(xs=xs, top=ytop, row_h=rh)
