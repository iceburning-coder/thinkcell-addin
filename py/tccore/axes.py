"""
坐标轴（对应 think-cell Axes）：
  ValueAxis     线性 / 对数 / 反转 / 断轴（多段压缩）/ 手动刻度
  CategoryAxis  等分槽位 + 类别间隔（category gap）+ 排序 + 序数标签
  DateAxis      日期 → 坐标，年/季/月/周刻度，周起始日，yy/yyyy
  same_scale    多图共用刻度
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta


def nice_step(span: float, n: int = 5) -> float:
    if span <= 0:
        return 1.0
    raw = span / n
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag + 1e-12:
            return m * mag
    return 10 * mag


def nice_range(vmin: float, vmax: float, n: int = 5, include_zero=True):
    if include_zero:
        vmin, vmax = min(vmin, 0), max(vmax, 0)
    if vmax == vmin:
        vmax = vmin + 1
    st = nice_step(vmax - vmin, n)
    return math.floor(vmin / st + 1e-9) * st, math.ceil(vmax / st - 1e-9) * st, st


class ValueAxis:
    """
    数值 → 像素位置。p0 对应 vmin，p1 对应 vmax（纵轴一般 p0=底部 y，p1=顶部 y）。
    breaks: [(a, b), ...] 把 (a,b) 区间压缩成 gap 像素（断轴）
    """

    def __init__(self, vmin, vmax, p0, p1, log=False, reverse=False, breaks=None, gap=8.0,
                 step=None):
        self.vmin, self.vmax, self.p0, self.p1 = vmin, vmax, p0, p1
        self.log, self.reverse, self.gap = log, reverse, gap
        self.breaks = sorted(breaks or [])
        self.step = step
        if log and vmin <= 0:
            raise ValueError("对数轴不能包含 0 或负数（think-cell 同样限制）")
        if reverse:
            self.p0, self.p1 = p1, p0
        # 分段：[(v0,v1)] 去掉断轴区间
        segs, cur = [], vmin
        for a, b in self.breaks:
            segs.append((cur, a))
            cur = b
        segs.append((cur, vmax))
        self.segs = segs

    def _f(self, v):
        return math.log10(v) if self.log else v

    def pos(self, v: float) -> float:
        if self.log and v < self.vmin:
            v = self.vmin
        total_px = self.p1 - self.p0
        n_gap = len(self.breaks)
        sgn = 1 if total_px >= 0 else -1
        usable = total_px - sgn * self.gap * n_gap
        lens = [self._f(b) - self._f(a) for a, b in self.segs]
        tot = sum(lens) or 1
        p = self.p0
        for i, ((a, b), L) in enumerate(zip(self.segs, lens)):
            seg_px = usable * L / tot
            if v <= b or i == len(self.segs) - 1:
                vv = min(max(v, a), b) if i < len(self.segs) - 1 else v
                return p + seg_px * ((self._f(vv) - self._f(a)) / L if L else 0)
            p += seg_px + sgn * self.gap
            # 落在断轴区间内的值：贴到下一段起点
            if v < self.segs[i + 1][0]:
                return p
        return p

    def break_positions(self):
        """每个断点在像素上的中心位置。"""
        out = []
        for a, b in self.breaks:
            out.append((self.pos(a) + self.pos(b)) / 2)
        return out

    def ticks(self):
        if self.log:
            lo, hi = math.floor(math.log10(self.vmin) + 1e-9), math.ceil(math.log10(self.vmax) - 1e-9)
            return [10 ** e for e in range(lo, hi + 1) if self.vmin <= 10 ** e <= self.vmax * 1.0001]
        if self.breaks and not self.step:
            out = []
            for a, b in self.segs:
                st = nice_step(b - a, 3)
                v = math.ceil(a / st - 1e-9) * st
                while v <= b + 1e-9:
                    out.append(round(v, 10))
                    v += st
            return sorted(set(out))
        st = self.step or nice_step(self.vmax - self.vmin)
        v = math.ceil(self.vmin / st - 1e-9) * st
        out = []
        while v <= self.vmax + 1e-9:
            if not any(a < v < b for a, b in self.breaks):
                out.append(round(v, 10))
            v += st
        return out


def auto_value_axis(values, p0, p1, headroom=0.12, log=False, include_zero=True, **kw):
    vals = [float(v) for v in values if v is not None]
    lo, hi = min(vals + ([0] if include_zero and not log else [])), max(vals + ([0] if include_zero and not log else []))
    if log:
        lo10 = 10 ** math.floor(math.log10(min(v for v in vals if v > 0)))
        hi10 = 10 ** math.ceil(math.log10(max(vals)))
        return ValueAxis(lo10, hi10, p0, p1, log=True, **kw)
    span = (hi - lo) or 1
    return ValueAxis(lo - (span * 0.02 if lo < 0 else 0), hi + span * headroom, p0, p1, **kw)


def same_scale(*groups_of_values, headroom=0.12):
    """Set Same Scale：多张图共用同一数值上限。返回 (vmin, vmax)。"""
    allv = [float(v) for g in groups_of_values for v in g if v is not None]
    lo, hi = min(allv + [0]), max(allv + [0])
    return lo, hi + (hi - lo) * headroom


class CategoryAxis:
    """
    n 个类别等分 [p0, p1]。
    width_frac: 柱宽占槽位比例
    gaps: {类别序号 i: 额外间隔（槽位倍数）}，在第 i 个类别之后加宽（think-cell Category gap）
    """

    def __init__(self, n, p0, p1, width_frac=0.62, gaps=None, pad=0.0):
        self.n, self.p0, self.p1 = n, p0, p1
        self.width_frac = width_frac
        self.gaps = gaps or {}
        units = n + sum(self.gaps.values())
        self.slot = (p1 - p0 - 2 * pad) / max(units, 1e-9)
        self.pad = pad

    def center(self, i: float) -> float:
        extra = sum(g for k, g in self.gaps.items() if k < math.floor(i + 1e-9))
        return self.p0 + self.pad + (i + 0.5 + extra) * self.slot

    @property
    def bar(self) -> float:
        return self.slot * self.width_frac

    def left(self, i):
        return self.center(i) - self.bar / 2

    def right(self, i):
        return self.center(i) + self.bar / 2

    def between(self, i, j=None):
        """两个相邻类别之间空档的中心。"""
        j = i + 1 if j is None else j
        return (self.right(i) + self.left(j)) / 2


def sort_order(cats, values, mode="sheet"):
    """类别排序：sheet | reverse | desc | asc。返回新的索引顺序。"""
    idx = list(range(len(cats)))
    if mode == "reverse":
        return idx[::-1]
    if mode == "desc":
        return sorted(idx, key=lambda i: -values[i])
    if mode == "asc":
        return sorted(idx, key=lambda i: values[i])
    return idx


# ---------------------------------------------------------------- 日期
def as_date(d) -> date:
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, date):
        return d
    return datetime.fromisoformat(str(d)).date()


class DateAxis:
    def __init__(self, d0, d1, p0, p1):
        self.d0, self.d1 = as_date(d0), as_date(d1)
        self.p0, self.p1 = p0, p1
        self.span = (self.d1 - self.d0).days or 1

    def pos(self, d) -> float:
        return self.p0 + (as_date(d) - self.d0).days / self.span * (self.p1 - self.p0)

    def ticks(self, scale="month", week_start=0, year_fmt="yyyy"):
        """
        返回 [(date, label, major)]。scale: year|quarter|month|week|day
        week_start: 0=周一 … 6=周日（think-cell Week Starts On）
        year_fmt: yyyy | yy
        """
        yf = (lambda y: str(y)) if year_fmt == "yyyy" else (lambda y: f"{y % 100:02d}")
        out = []
        d = self.d0
        if scale == "year":
            d = date(d.year, 1, 1)
            while d <= self.d1:
                if d >= self.d0:
                    out.append((d, yf(d.year), True))
                d = date(d.year + 1, 1, 1)
        elif scale == "quarter":
            d = date(d.year, (d.month - 1) // 3 * 3 + 1, 1)
            while d <= self.d1:
                if d >= self.d0:
                    q = (d.month - 1) // 3 + 1
                    out.append((d, f"{yf(d.year)}Q{q}" if q == 1 else f"Q{q}", q == 1))
                m = d.month + 3
                d = date(d.year + (m - 1) // 12, (m - 1) % 12 + 1, 1)
        elif scale == "month":
            d = date(d.year, d.month, 1)
            while d <= self.d1:
                if d >= self.d0:
                    out.append((d, f"{yf(d.year)}/{d.month}" if d.month == 1 or not out else f"{d.month}月",
                                d.month == 1))
                m = d.month + 1
                d = date(d.year + (m - 1) // 12, (m - 1) % 12 + 1, 1)
        elif scale == "week":
            d = d - timedelta(days=(d.weekday() - week_start) % 7)
            while d <= self.d1:
                if d >= self.d0:
                    out.append((d, f"{d.month}/{d.day}", d.day <= 7))
                d += timedelta(days=7)
        else:
            while d <= self.d1:
                out.append((d, str(d.day), d.day == 1))
                d += timedelta(days=1)
        return out


def years_between_30_360(d0, d1) -> float:
    """30/360 日计数（think-cell CAGR 用）。"""
    a, b = as_date(d0), as_date(d1)
    da, db = min(a.day, 30), min(b.day, 30) if a.day >= 30 or b.day < 31 else b.day
    db = min(db, 30)
    days = (b.year - a.year) * 360 + (b.month - a.month) * 30 + (db - da)
    return days / 360
