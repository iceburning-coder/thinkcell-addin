"""数字格式（对应 think-cell 的 Number Format）。"""
from __future__ import annotations

import math

MAG = {"": 1, "K": 1e3, "M": 1e6, "B": 1e9, "万": 1e4, "亿": 1e8}


def fmt(v, dec: int | None = None, unit: str = "", pct: bool = False, sign: bool = False,
        neg_paren: bool = False, mag: str = "", thousands: str = ",", decimal: str = ".") -> str:
    """
    v        数值（None/NaN 返回 ""）
    dec      小数位；None = 自动（≥100 取整，≥1 一位，<1 两位）
    pct      v 是比例（0.086 → 8.6%）
    sign     正数带 +
    mag      数量级缩放：'K' 'M' 'B' '万' '亿'，同时作为后缀
    unit     后缀
    """
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    x = float(v) * (100 if pct else 1) / MAG.get(mag, 1)
    if dec is None:
        a = abs(x)
        dec = 0 if a >= 100 or (a == int(a) and not pct and a >= 1) else (1 if a >= 1 else 2)
        if a == 0:
            dec = 0
    s = f"{abs(x):,.{dec}f}"
    if thousands != "," or decimal != ".":
        s = s.replace(",", "\0").replace(".", decimal).replace("\0", thousands)
    s += (mag if mag else "") + ("%" if pct else "") + unit
    if x < 0 and round(abs(x), dec) != 0:
        return f"({s})" if neg_paren else "-" + s
    if sign and x > 0:
        return "+" + s
    return s


def ordinal(i: int, lang: str = "zh") -> str:
    if lang == "zh":
        return f"第{i}"
    suf = "th" if 10 <= i % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(i % 10, "th")
    return f"{i}{suf}"


def auto_dec(values) -> int:
    """一张图内统一小数位：按最大绝对值决定。"""
    vs = [abs(float(v)) for v in values if v not in (None, "e")]
    m = max(vs) if vs else 0
    if m >= 100:
        return 0
    if all(float(v) == int(float(v)) for v in values if v not in (None, "e")):
        return 0
    return 1 if m >= 1 else 2
