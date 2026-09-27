"""甘特 / 时间线（think-cell 风格）。

- 多层日历表头：年 / 季 / 月 / 周（ISO 周号或日期）/ 日；上层带下划线分段，最细一层逐格居中
- 自动刻度（scale="auto"）、财年起始月、周起始日、周末底纹
- 每行可放多个条形（实线 / 虚线计划段）和多个里程碑（菱形/三角/圆/方），标签可放左/右/上/下
- 超出日期范围的条形自动画成箭头
- 分隔线（行 sep=True）、行底纹（可选）
- 全局里程碑：虚线竖线 + 底部 ▲ + 标签；底纹区（假期/排他期）：灰色竖带 + 底部括号 + 标签
- 右侧标签列（负责人 / 备注，自动换行）+ 状态列（Harvey ball / 复选框）
- 顶部时间段括号、今天线、流程箭头、分组颜色 + 图例
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from .axes import DateAxis, as_date
from .canvas import text_w
from .charts_bar import Ctx
from .style import series_colors as _auto_colors
from . import legend as LG
from .table import checkbox

MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
SCALES = ("year", "quarter", "month", "week", "day")


# ---------------------------------------------------------------- 日历单位
def _add_months(d, n):
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


def _floor(d, kind, week_start=0, fy=1):
    if kind == "year":
        y = d.year if d.month >= fy else d.year - 1
        return date(y, fy, 1)
    if kind == "quarter":
        back = (d.month - fy) % 3
        return _add_months(date(d.year, d.month, 1), -back)
    if kind == "month":
        return date(d.year, d.month, 1)
    if kind == "week":
        return d - timedelta(days=(d.weekday() - week_start) % 7)
    return d


def _next(d, kind):
    if kind == "year":
        return _add_months(d, 12)
    if kind == "quarter":
        return _add_months(d, 3)
    if kind == "month":
        return _add_months(d, 1)
    if kind == "week":
        return d + timedelta(days=7)
    return d + timedelta(days=1)


def _units(kind, d0, d1, week_start=0, fy=1):
    """[(start, end)]，覆盖 [d0, d1)。"""
    out = []
    d = _floor(d0, kind, week_start, fy)
    while d < d1:
        n = _next(d, kind)
        out.append((d, n))
        d = n
    return out


def auto_scales(d0, d1):
    span = (as_date(d1) - as_date(d0)).days
    if span <= 35:
        return ["month", "day"]
    if span <= 220:
        return ["month", "week"]
    if span <= 800:
        return ["year", "month"]
    return ["year", "quarter"]


def _label(kind, a, en, fy, week_fmt, with_year, compact=False):
    if kind == "year":
        return f"FY{(a.year + 1) % 100:02d}" if fy != 1 else str(a.year)
    if kind == "quarter":
        q = ((a.month - fy) % 12) // 3 + 1
        if fy != 1:
            fyy = a.year + 1 if a.month >= fy else a.year
            return f"FY{fyy % 100:02d} Q{q}" if with_year else f"Q{q}"
        return (f"Q{q} {a.year}" if en else f"{a.year}Q{q}") if with_year else f"Q{q}"
    if kind == "month":
        if compact:
            return MON_EN[a.month - 1][0] if en else str(a.month)
        s = MON_EN[a.month - 1] if en else f"{a.month}月"
        if with_year:
            s = f"{s} {a.year}" if en else f"{a.year}年{s}"
        return s
    if kind == "week":
        if week_fmt == "date":
            return f"{a.month}/{a.day}"
        return str((a + timedelta(days=3)).isocalendar()[1])
    return str(a.day)


# ---------------------------------------------------------------- 文本换行
def wrap(s, size, maxw, bold=False):
    s = str(s or "")
    if not s:
        return []
    out = []
    for para in s.split("\n"):
        if " " in para.strip():      # 有空格：按词断行（中文短语也整体保留），超长词再按字拆
            toks = []
            for wd in re.findall(r"\S+\s*", para):
                toks += [wd] if text_w(wd.strip(), size, bold) <= maxw else list(wd)
        else:
            toks = re.findall(r"[A-Za-z0-9.,;:'’()&/+\-%$€¥#@!?]+\s*|\s+|.", para)
        cur = ""
        for tk in toks:
            if cur and text_w((cur + tk).rstrip(), size, bold) > maxw:
                out.append(cur.rstrip())
                cur = tk.lstrip()
            else:
                cur += tk
        if cur.strip():
            out.append(cur.rstrip())
    return out


# ---------------------------------------------------------------- 图形
def _mark(c, shape, x, y, s, col):
    if shape == "triangle":
        c.poly([(x, y - s), (x + s, y + s * 0.8), (x - s, y + s * 0.8)], fill=col)
    elif shape == "circle":
        c.circle(x, y, s * 0.8, fill=col)
    elif shape == "square":
        c.rect(x - s * 0.7, y - s * 0.7, s * 1.4, s * 1.4, fill=col)
    elif shape == "star":
        import math
        pts = []
        for k in range(10):
            r = s * (1.1 if k % 2 == 0 else 0.45)
            a = math.radians(-90 + k * 36)
            pts.append((x + r * math.cos(a), y + r * math.sin(a)))
        c.poly(pts, fill=col)
    else:
        c.poly([(x, y - s), (x + s, y), (x, y + s), (x - s, y)], fill=col)


def _harvey(c, t, cx, cy, r, v, col):
    c.circle(cx, cy, r, fill=t["BG"], stroke=t["FG"], sw=0.8)
    frac = max(0.0, min(1.0, v / 4))
    if frac >= 0.999:
        c.circle(cx, cy, r, fill=col, stroke=t["FG"], sw=0.8)
    elif frac > 0:
        c.wedge(cx, cy, r, 0, 360 * frac, col, stroke=None, sw=0)
        c.circle(cx, cy, r, fill=None, stroke=t["FG"], sw=0.8)


def _status_val(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().lower()
    if s in ("check", "cross", "empty", "✓", "✗", "是", "否", "done", "完成", "未完成"):
        return {"✓": "check", "是": "check", "done": "check", "完成": "check", "✗": "cross", "否": "cross",
                "未完成": "empty"}.get(s, s)
    try:
        if s.endswith("%"):
            return float(s[:-1]) / 25
        return float(s)
    except ValueError:
        return None


def _norm_row(r):
    """把旧格式（start/end/milestone）和新格式（items/marks）统一。"""
    bars, marks = [], []
    if r.get("start") and r.get("end"):
        bars.append(dict(start=r["start"], end=r["end"], style=r.get("style", "solid"), label=r.get("label"),
                         color=r.get("color")))
    elif r.get("start") and not r.get("milestone"):
        marks.append(dict(date=r["start"], label=r.get("label"), pos=r.get("label_pos", "right"),
                          shape=r.get("shape", "diamond")))
    if r.get("milestone"):
        marks.append(dict(date=r["milestone"], label=r.get("milestone_label") or r.get("label") if not bars else r.get("milestone_label"),
                          pos=r.get("label_pos", "right"), shape=r.get("shape", "diamond")))
    for it in r.get("items") or []:
        if it.get("end"):
            bars.append(dict(it))
        else:
            marks.append(dict(it, date=it.get("date") or it.get("start")))
    for m in r.get("marks") or []:
        marks.append(dict(m))
    return bars, marks


# ---------------------------------------------------------------- 主函数
def gantt(fig, rows, d0=None, d1=None, scale="auto", sub_scale=None, scales=None, week_start=0, week_fmt="iso",
          year_fmt="yyyy", fy_start=1, lang=None, today=None, milestones=None, brackets=None, shades=None,
          cols=("负责人", "备注"), head_label=None, scale_label=None, status_label=None, group_colors=None,
          row_shading=False, flow=None, label_col_w=None, date_labels=False, weekends=False, snap=True,
          legend="none", legend_reverse=False, series_colors=None, bar_color=None):
    """
    rows: [dict(name, start, end, owner=, remark=, status=0-4|'check'|'cross'|'empty', group=, indent=0,
                bold=False, sep=False, style='solid'|'dashed', label=, milestone=date, milestone_label=,
                label_pos='right'|'left'|'above'|'below', shape='diamond'|'triangle'|'circle'|'square'|'star',
                items=[dict(start, end, style, label, color) | dict(date, label, pos, shape)],
                marks=[dict(date, label, pos, shape)])]
      sep=True：该行上方画分隔线（分段）
    d0/d1:      日期范围（省略 = 按数据自动；早于 d0 / 晚于 d1 的条形画成箭头）
    scales:     表头各层，从上到下，如 ["month","week"]；省略时用 scale/sub_scale，scale="auto" 自动选择
    week_fmt:   iso（周号）| date（月/日）
    fy_start:   财年起始月（≠1 时年/季显示 FY）
    milestones: [dict(name, date, line=True)]      全局里程碑：虚线 + 底部 ▲ + 标签
    shades:     [dict(start, end, text=)]           底纹区；有 text 时底部画括号 + 标签
    brackets:   [dict(start, end, text, row=None)]  顶部时间段括号
    flow:       [(行 a, 行 b)]                      流程箭头：a 结束 → b 开始
    cols:       右侧标签列标题（对应 owner / remark），没有内容的列自动隐藏
    """
    t, c = fig.t, fig.c
    rows = [dict(r) for r in rows]
    norm = [_norm_row(r) for r in rows]
    # ---- 日期范围
    alld = []
    for bars, marks in norm:
        alld += [as_date(b["start"]) for b in bars] + [as_date(b["end"]) for b in bars] + [as_date(m["date"]) for m in marks]
    alld += [as_date(m["date"]) for m in milestones or []]
    for s in shades or []:
        alld += [as_date(s["start"]), as_date(s["end"])]
    if not alld and not (d0 and d1):
        alld = [date.today(), date.today() + timedelta(days=90)]
    D0 = as_date(d0) if d0 else min(alld)
    D1 = as_date(d1) if d1 else max(alld) + timedelta(days=1)
    if D1 <= D0:
        D1 = D0 + timedelta(days=1)
    if scales:
        scs = [s for s in scales if s in SCALES]
    elif scale in (None, "", "auto"):
        scs = auto_scales(D0, D1)
    else:
        scs = [scale] + ([sub_scale] if sub_scale and sub_scale != scale else [])
    scs = sorted(dict.fromkeys(scs), key=SCALES.index) or ["month"]
    fine = scs[-1]
    fy = int(fy_start or 1)
    if snap:
        D0 = _floor(D0, fine, week_start, fy)
        u = _units(fine, D0, D1, week_start, fy)
        D1 = u[-1][1] if u else _next(D0, fine)
    # ---- 语言
    if lang is None:
        probe = (head_label or "") + "".join(str(r.get("name", "")) for r in rows[:4])
        lang = "en" if probe and not re.search(r"[一-鿿]", probe) else "zh"
    en = lang == "en"
    head_label = head_label if head_label is not None else ("Activity" if en else "活动")
    if scale_label is None:
        scale_label = {"week": "Week" if en else "周", "day": "Day" if en else "日"}.get(fine, "")
    status_label = status_label if status_label is not None else ("Status" if en else "状态")
    # ---- 分组颜色 / 图例
    _grp = []
    for r in rows:
        if r.get("group") not in (None, "") and r.get("group") not in _grp:
            _grp.append(r.get("group"))
    lg = LG.norm(legend, "none") if len(_grp) > 1 else "none"
    if lg == "label":
        lg = "top"
    spot = LG.reserve(fig, lg, [str(g) for g in _grp])
    pal = group_colors or _auto_colors(t, max(len(_grp), 1))
    base_col = bar_color or (series_colors or {}).get("条形") or t["SERIES"][1 if len(t["SERIES"]) > 2 else 0]
    gcol = {}
    for g, col in zip(_grp, pal):
        gcol[g] = (series_colors or {}).get(str(g)) or col
    x0, y0, w, h = fig.box
    S, SS = t["SIZE_LABEL"], t["SIZE_SMALL"]
    lh = S * 1.22
    # ---- 列宽
    maxname = w * 0.32
    name_w = max([text_w(r.get("name", ""), S) + r.get("indent", 0) * 10 for r in rows] + [text_w(head_label, S, True)])
    lab_w = label_col_w or min(name_w, maxname) + 12
    lab_w = max(lab_w, text_w(head_label, S, True) + text_w(scale_label, S, True) + 16)
    col_keys = []
    for ci, cn in enumerate(cols or []):
        key = ["owner", "remark"][ci] if ci < 2 else None
        if key and any(str(r.get(key) or "").strip() for r in rows):
            vals = [str(r.get(key) or "") for r in rows]
            cw = min(max([text_w(cn, S, True)] + [text_w(v, S) for v in vals]) + 14, w * 0.2)
            col_keys.append((key, cn, cw))
    has_status = any(_status_val(r.get("status")) is not None for r in rows)
    st_w = max(28, text_w(status_label, S, True) + 12) if has_status else 0
    left = x0 + lab_w
    right = x0 + w - sum(cw for _, _, cw in col_keys) - st_w
    dax = DateAxis(D0, D1, left, right)
    # ---- 行高（按换行和下方标签加权）
    wts, gaps, wrapped = [], [], []
    for i, (r, (bars, marks)) in enumerate(zip(rows, norm)):
        nl = wrap(r.get("name", ""), S, lab_w - 10 - r.get("indent", 0) * 10, r.get("bold", False)) or [""]
        cl = {k: wrap(r.get(k), S, cw - 12) for k, _, cw in col_keys}
        lines = max([len(nl)] + [len(v) for v in cl.values()])
        below = any((m.get("pos") in ("below", "下")) and m.get("label") for m in marks) or \
            any((b.get("label_pos") in ("below", "下")) and b.get("label") for b in bars)
        wts.append(max(1.0, 0.3 + 0.7 * lines) + (0.55 if below else 0))
        gaps.append(0.3 if (r.get("sep") and i > 0) else 0.0)
        wrapped.append((nl, cl))
    # ---- 纵向布局
    nh = len(scs)
    hr = S * 1.9
    hy = y0 + (16 if brackets else 0)
    top = hy + nh * hr
    bot_lines = 0
    for m in milestones or []:
        bot_lines = max(bot_lines, len(wrap(m.get("name"), SS + 1, 110)))
    for s in shades or []:
        if s.get("text"):
            bot_lines = max(bot_lines, len(wrap(s["text"], SS + 1, 110)))
    bottom_h = (14 + bot_lines * (SS + 1) * 1.22 + (8 if any(s.get("text") for s in shades or []) else 0)) if bot_lines else 4
    if today and not bot_lines:
        bottom_h = max(bottom_h, SS + 4)
    bottom = y0 + h - bottom_h
    tot = sum(wts) + sum(gaps)
    unit = (bottom - top) / max(tot, 1)
    lh = min(lh, unit * 0.62)
    bh = max(3.0, min(unit * 0.3, 8.0))
    ms = max(3.0, min(unit * 0.22, 5.5))
    ys, seps = [], []
    y = top
    for i in range(len(rows)):
        if gaps[i]:
            seps.append(y + gaps[i] * unit / 2)
            y += gaps[i] * unit
        ys.append((y, y + wts[i] * unit))
        y += wts[i] * unit
    # ---- 底纹：行底纹、周末、底纹区
    if row_shading:
        for i, (ya, yb) in enumerate(ys):
            if i % 2 == 0:
                c.rect(x0, ya, w, yb - ya, fill=t["SHADE"])
    if weekends and fine in ("day", "week") and (right - left) / max((D1 - D0).days, 1) >= 1.2:
        d = D0
        while d < D1:
            if d.weekday() >= 5:
                c.rect(dax.pos(d), top, dax.pos(d + timedelta(days=1)) - dax.pos(d), bottom - top, fill="#F0F0F0")
            d += timedelta(days=1)
    shade_col = "#E4E4E4" if t.get("name") != "dark" else "#2A2E36"
    for s in shades or []:
        xa, xb = max(left, dax.pos(s["start"])), min(right, dax.pos(s["end"]))
        if xb > xa:
            c.rect(xa, top, xb - xa, bottom - top, fill=shade_col)
    # ---- 表头
    grid_col = "#9A9A9A"
    for li, kind in enumerate(scs):
        ya = hy + li * hr
        units = _units(kind, D0, D1, week_start, fy)
        is_fine = li == nh - 1
        cross_year = D0.year != (D1 - timedelta(days=1)).year
        for ui, (a, b) in enumerate(units):
            xa, xb = max(left, dax.pos(a)), min(right, dax.pos(b))
            if xb - xa < 0.5:
                continue
            if is_fine:
                wy = li == 0 and kind in ("month", "quarter") and cross_year and (ui == 0 or a.month == 1)
                lab = _label(kind, a, en, fy, week_fmt, wy)
                if text_w(lab, S, True) > xb - xa - 1 and kind == "month":
                    lab = _label(kind, a, en, fy, week_fmt, False, compact=True)
                if text_w(lab, S, True) <= xb - xa + 2:
                    c.text((xa + xb) / 2, ya + hr / 2, lab, S, t["FG"], "middle", "middle", bold=True)
                if ui > 0 or xa > left + 0.5:
                    c.line(xa, top, xa, bottom, grid_col, 0.5, "1 2")
            else:
                full = dax.pos(b) - dax.pos(a)
                if xb - xa < 0.4 * full:      # 范围边缘不足半格的上层分段：不写标签不画线
                    continue
                wy = "year" not in scs[:li] and kind in ("month", "quarter") and cross_year and (ui == 0 or a.month == 1)
                lab = _label(kind, a, en, fy, week_fmt, wy)
                if text_w(lab, S, True) > xb - xa - 3 and kind == "month":
                    lab = _label(kind, a, en, fy, week_fmt, False, compact=True)
                if text_w(lab, S, True) <= xb - xa - 2:
                    c.text(xa + 3, ya + hr / 2 - 1, lab, S, t["FG"], "start", "middle", bold=True)
                c.line(xa + 2, ya + hr - 2, xb - 2, ya + hr - 2, t["FG"], 0.7)
    # 表头文字
    c.text(x0 + 2, hy + (nh - 0.5) * hr, head_label, S, t["FG"], "start", "middle", bold=True)
    if scale_label:
        c.text(left - 5, hy + (nh - 0.5) * hr, scale_label, S, t["FG"], "end", "middle", bold=True)
    xc = right
    for key, cn, cw in col_keys:
        c.text(xc + 8, hy + (nh - 0.5) * hr, cn, S, t["FG"], "start", "middle", bold=True)
        xc += cw
    if has_status:
        c.text(xc + st_w / 2, hy + (nh - 0.5) * hr, status_label, S, t["FG"], "middle", "middle", bold=True)
    # 框线
    c.line(x0, top, x0 + w, top, t["FG"], 0.9)
    c.line(x0, bottom, x0 + w, bottom, t["FG"], 0.9)
    c.line(left, hy + (nh - 1) * hr + 2, left, bottom, t["FG"], 0.7)
    c.line(right, hy + (nh - 1) * hr + 2, right, bottom, t["FG"], 0.7)
    for ysep in seps:
        c.line(x0, ysep, x0 + w, ysep, t["FG"], 0.7)
    # ---- 全局里程碑竖线（先画，压在条形下面）
    for m in milestones or []:
        xm = dax.pos(m["date"])
        if left - 0.5 <= xm <= right + 0.5 and m.get("line", True):
            c.line(xm, top, xm, bottom, t["FG"], 1.0, "4 3")
    # ---- 行
    geo = {}
    for i, (r, (bars, marks)) in enumerate(zip(rows, norm)):
        ya, yb = ys[i]
        yc = ya + unit * 0.5
        nl, cl = wrapped[i]
        for k, s in enumerate(nl):
            c.text(x0 + 2 + r.get("indent", 0) * 10, yc + k * lh, s, S, t["FG"], "start", "middle", bold=r.get("bold", False))
        row_col = r.get("color") or gcol.get(r.get("group")) or base_col
        for b in bars:
            col = b.get("color") or row_col
            da, db = as_date(b["start"]), as_date(b["end"])
            xa, xb = dax.pos(da), dax.pos(db)
            cut_l, cut_r = xa < left - 0.1, xb > right + 0.1
            xa, xb = max(xa, left), min(xb, right)
            if xb <= xa and not (cut_l or cut_r):
                xb = xa + 1.5
            hs = bh * 1.1
            dashed = str(b.get("style", "solid")).lower() in ("dashed", "dash", "plan", "虚线", "计划")
            ra, rb = xa + (hs if cut_l else 0), xb - (hs if cut_r else 0)
            if dashed:
                c.rect(ra, yc - bh / 2, max(rb - ra, 1), bh, fill=None, stroke=col, sw=1.0, dash="4 3")
            else:
                c.rect(ra, yc - bh / 2, max(rb - ra, 1.5), bh, fill=col)
            if cut_l:
                c.poly([(xa - 2, yc), (ra, yc - bh), (ra, yc + bh)], fill=None if dashed else col,
                       stroke=col if dashed else None, sw=1.0)
            if cut_r:
                c.poly([(xb + 2, yc), (rb, yc - bh), (rb, yc + bh)], fill=None if dashed else col,
                       stroke=col if dashed else None, sw=1.0)
            if date_labels and not dashed:
                if not cut_l:
                    c.text(xa - 3, yc, f"{da.month}/{da.day}", SS, t["FG_MUTED"], "end", "middle")
                if not cut_r:
                    de = db - timedelta(days=1) if db > da else db
                    c.text(xb + 3, yc, f"{de.month}/{de.day}", SS, t["FG_MUTED"], "start", "middle")
            lab = b.get("label")
            if lab:
                lp = b.get("label_pos") or ("center" if dashed else "right")
                tw = text_w(lab, SS + 0.5)
                if lp in ("center", "inside", "中") or dashed and lp not in ("right", "left", "above", "below"):
                    c.rect((xa + xb) / 2 - tw / 2 - 2, yc - SS * 0.7, tw + 4, SS * 1.4, fill=t["BG"])
                    c.text((xa + xb) / 2, yc, lab, SS + 0.5, col if dashed else t["FG"], "middle", "middle")
                elif lp in ("left", "左"):
                    c.text(xa - 4, yc, lab, SS + 0.5, t["FG"], "end", "middle")
                elif lp in ("below", "下"):
                    c.text((xa + xb) / 2, yc + bh / 2 + 2, lab, SS + 0.5, t["FG"], "middle", "top")
                elif lp in ("above", "上"):
                    c.text((xa + xb) / 2, yc - bh / 2 - 2, lab, SS + 0.5, t["FG"], "middle", "bottom")
                else:
                    c.text(xb + 4, yc, lab, SS + 0.5, t["FG"], "start", "middle")
            g = geo.get(i)
            geo[i] = (min(xa, g[0]) if g else xa, max(xb, g[1]) if g else xb, yc)
        for m in marks:
            xm = dax.pos(m["date"])
            if xm < left - 0.5 or xm > right + 0.5:
                continue
            _mark(c, m.get("shape") or "diamond", xm, yc, ms, m.get("color") or t["FG"])
            lab = m.get("label")
            if lab:
                p = m.get("pos") or "right"
                if p in ("left", "左"):
                    c.text(xm - ms - 3, yc, lab, S, t["FG"], "end", "middle")
                elif p in ("below", "下"):
                    c.text(xm, yc + ms + 2, lab, S, t["FG"], "middle", "top")
                elif p in ("above", "上"):
                    c.text(xm, yc - ms - 2, lab, S, t["FG"], "middle", "bottom")
                else:
                    c.text(xm + ms + 3, yc, lab, S, t["FG"], "start", "middle")
            geo.setdefault(i, (xm, xm, yc))
        # 右侧列
        xc = right
        for key, cn, cw in col_keys:
            for k, s in enumerate(cl.get(key) or []):
                c.text(xc + 8, yc + k * lh, s, S, t["FG"], "start", "middle")
            xc += cw
        stv = _status_val(r.get("status"))
        if stv is not None:
            if isinstance(stv, str):
                checkbox(c, t, xc + st_w / 2, yc, min(10, unit * 0.5), stv)
            else:
                _harvey(c, t, xc + st_w / 2, yc, min(6, unit * 0.3), stv, row_col)
    # ---- 流程箭头
    for a, b in flow or []:
        if a in geo and b in geo:
            xe, ya_ = geo[a][1], geo[a][2]
            xs, yb_ = geo[b][0], geo[b][2]
            xb_end = geo[b][1]
            if xs <= xe + 5 and xb_end > xe + 5:     # 目标条已在前一个结束前开始：竖直落到目标条上沿
                ye = yb_ - bh / 2 - 0.5 if yb_ > ya_ else yb_ + bh / 2 + 0.5
                c.polyline_arrow([(xe, ya_), (xe + 5, ya_), (xe + 5, ye)], t["FG_MUTED"], 0.7, 4)
            else:
                c.polyline_arrow([(xe, ya_), (xe + 4, ya_), (xe + 4, yb_), (xs, yb_)], t["FG_MUTED"], 0.7, 4)
    # ---- 底部：全局里程碑 ▲ + 标签；底纹区括号 + 标签
    lb = (SS + 1) * 1.22
    for m in milestones or []:
        xm = dax.pos(m["date"])
        if not (left - 0.5 <= xm <= right + 0.5):
            continue
        c.poly([(xm, bottom + 2), (xm + 5, bottom + 10), (xm - 5, bottom + 10)], fill=t["FG"])
        for k, s in enumerate(wrap(m.get("name"), SS + 1, 110)):
            c.text(xm, bottom + 12 + k * lb, s, SS + 1, t["FG"], "middle", "top")
    for s in shades or []:
        if not s.get("text"):
            continue
        xa, xb = max(left, dax.pos(s["start"])), min(right, dax.pos(s["end"]))
        if xb <= xa:
            continue
        yb_ = bottom + 12
        c.poly([(xa, bottom + 4), (xa, yb_), (xb, yb_), (xb, bottom + 4)], stroke=t["FG"], sw=0.8, closed=False)
        xm = (xa + xb) / 2
        c.poly([(xm - 6, yb_), (xm + 6, yb_), (xm, yb_ + 7)], fill=t["FG"])
        for k, ln in enumerate(wrap(s["text"], SS + 1, 110)):
            c.text(xm, yb_ + 9 + k * lb, ln, SS + 1, t["FG"], "middle", "top")
    # ---- 顶部括号
    for bk in brackets or []:
        xa, xb = max(left, dax.pos(bk["start"])), min(right, dax.pos(bk["end"]))
        yb_ = (ys[bk["row"]][0] + 3) if bk.get("row") is not None and bk["row"] < len(ys) else y0 + 8
        c.poly([(xa, yb_ + 5), (xa, yb_), (xb, yb_), (xb, yb_ + 5)], stroke=t["FG_MUTED"], sw=0.8, closed=False)
        c.text((xa + xb) / 2, yb_ - 1, bk["text"], SS, t["FG_MUTED"], "middle", "bottom")
    # ---- 今天线
    if today:
        xt = dax.pos(today)
        if left <= xt <= right:
            c.line(xt, top, xt, bottom, t["ACCENT"], 1.1)
            c.text(xt + 2, bottom - 2, "Today" if en else "今天", SS - 0.5, t["ACCENT"], "start", "bottom", bold=True)
    LG.draw(fig, spot, [str(g) for g in _grp], [gcol[g] for g in _grp], reverse=legend_reverse)
    ctx = Ctx(fig, "h", None, None, [], [r.get("name", "") for r in rows])
    ctx.extra.update(dax=dax, geo=geo, row_h=unit, top=top, rows_y=ys)
    return ctx
