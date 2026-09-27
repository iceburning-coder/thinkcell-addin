"""Figure：画布 + 标题/副标题/来源 + 绘图区，统一出口（SVG/HTML/PNG/PPTX）。"""
from __future__ import annotations

from .canvas import Canvas, text_w
from .style import theme as _theme


class Figure:
    def __init__(self, W=680, H=400, title=None, subtitle=None, source=None, theme=None,
                 margin=(16, 20, 14, 16)):
        """margin = (左, 右, 上, 下)，单位 pt。"""
        self.t = _theme(theme)
        self.W, self.H = W, H
        self.c = Canvas(W, H, self.t)
        self.title, self.subtitle, self.source = title, subtitle, source
        self.meta = []   # 注释函数的计算结果（如 CAGR 值），便于核对标题
        ml, mr, mt, mb = margin
        y = mt
        if title:
            self.c.text(ml, y, title, self.t["SIZE_TITLE"], self.t["FG"], "start", "top", bold=True)
            y += self.t["SIZE_TITLE"] * 1.45
        if subtitle:
            self.c.text(ml, y, subtitle, self.t["SIZE_SUB"], self.t["FG_MUTED"], "start", "top")
            y += self.t["SIZE_SUB"] * 1.5
        y += 8 if (title or subtitle) else 0
        bottom = H - mb
        if source:
            self.c.text(ml, H - mb + 2, source if source.startswith(("来源", "Source", "注")) else f"来源：{source}",
                        self.t["SIZE_SMALL"], self.t["FG_MUTED"], "start", "bottom")
            bottom -= self.t["SIZE_SMALL"] * 1.6
        self.box = (ml, y, W - ml - mr, bottom - y)   # 绘图区 (x, y, w, h)

    # ---------------- 输出
    def svg(self, responsive=True) -> str:
        return self.c.to_svg(responsive)

    def save_svg(self, path):
        open(path, "w", encoding="utf-8").write(self.c.to_svg(False))
        return path

    def html(self, path=None, page_title=None) -> str:
        h = html_page([self], page_title or self.title or "Chart")
        if path:
            open(path, "w", encoding="utf-8").write(h)
        return h

    def png(self, path, scale=2.0):
        return self.c.to_png(path, scale)

    def pptx(self, slide, x_in=0.5, y_in=0.5, w_in=None):
        return self.c.to_pptx(slide, x_in, y_in, w_in)


def html_page(figs, title="Report", notes: dict | None = None, cols=1) -> str:
    """把多张图拼成一个单文件 HTML 页面（零外部依赖）。"""
    t = figs[0].t if figs else _theme()
    cards = []
    for i, f in enumerate(figs):
        note = (notes or {}).get(i, "")
        cards.append(f'<figure class="card">{f.svg()}' + (f'<figcaption>{note}</figcaption>' if note else "")
                     + '</figure>')
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root{{--bg:{t['BG']};--fg:{t['FG']};--muted:{t['FG_MUTED']}}}
body{{margin:0;background:var(--bg);color:var(--fg);font-family:{t['FONT']}}}
main{{max-width:{980 if cols == 1 else 1400}px;margin:0 auto;padding:28px 16px}}
h1{{font-size:20px;margin:0 0 20px}}
.grid{{display:grid;grid-template-columns:repeat({cols},minmax(0,1fr));gap:28px}}
@media(max-width:800px){{.grid{{grid-template-columns:1fr}}}}
.card{{margin:0}} .card svg{{width:100%;height:auto;display:block}}
figcaption{{font-size:13px;color:var(--muted);margin-top:6px;line-height:1.5}}
</style></head>
<body><main><h1>{title}</h1><div class="grid">
{''.join(cards)}
</div></main></body></html>"""
