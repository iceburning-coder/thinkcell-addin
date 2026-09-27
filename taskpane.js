/* think-cell 风格图表 · Office 加载项（PowerPoint / Excel / 浏览器）
 * 数据表 → 图表 JSON → Pyodide 里的 tccore 引擎 → SVG / PPTX → 插入 Office
 */
"use strict";
const $ = (id) => document.getElementById(id);
let HOST = "web";           // ppt | xl | web
let PY = null, API = null, PPTX_READY = false;
let LAST = null;            // {spec, svg, width, height, meta}
let SEL_ADDRESS = null;     // Excel：读取选区的地址（原生图表用）

// ------------------------------------------------------------------ 工具
const store = {
  get(k, d) { try { const v = localStorage.getItem("tc." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("tc." + k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } },
};
function status(msg, kind) { const s = $("status"); s.textContent = msg || ""; s.className = "status " + (kind || ""); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function parseGrid(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const delim = lines.some((l) => l.includes("\t")) ? "\t" : (lines.some((l) => l.includes(",")) ? "," : /\s{2,}|\s/);
  return lines.map((l) => l.split(delim).map((c) => c.trim()));
}
function num(s) {
  if (s === undefined || s === null) return null;
  if (typeof s === "number") return s;
  let t = String(s).trim();
  if (t === "" || t === "-" || t === "–") return null;
  if (t.toLowerCase() === "e") return "e";
  let pct = false;
  if (t.endsWith("%")) { pct = true; t = t.slice(0, -1); }
  t = t.replace(/[,，\s¥$€]/g, "");
  if (/^\(.*\)$/.test(t)) t = "-" + t.slice(1, -1);
  const v = Number(t);
  if (!isFinite(v)) return NaN;
  return pct ? v / 100 : v;
}
function numCol(rows, j) { return rows.map((r) => num(r[j])); }
function checkNums(arr, label) {
  arr.forEach((v, i) => { if (Number.isNaN(v)) throw new Error(`${label} 第 ${i + 1} 行不是数字`); });
  return arr;
}
function isoDate(s) {
  if (typeof s === "number") return excelDate(s);
  const t = String(s).trim().replace(/[./年月]/g, "-").replace(/日/g, "");
  const m = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) throw new Error(`无法识别日期：${s}（请用 2026-09-01 格式）`);
  return `${m[1]}-${m[2].padStart(2, "0")}-${(m[3] || "1").padStart(2, "0")}`;
}
function excelDate(n) { const d = new Date(Math.round((n - 25569) * 86400000)); return d.toISOString().slice(0, 10); }

// ------------------------------------------------------------------ 图表类型定义
// 数据约定：第一行表头；第一列为类目（除散点等）；其余列为系列
const COL_OPTS = [
  { k: "mode", t: "select", label: "形式", opts: [["stacked", "堆积"], ["clustered", "簇状"], ["100", "100%"]] },
  { k: "horizontal", t: "check", label: "横向条形" },
  { k: "sort", t: "select", label: "类目排序", opts: [["sheet", "按表格"], ["desc", "降序"], ["asc", "升序"], ["reverse", "倒序"]] },
  { k: "labels", t: "select", label: "段内标签", opts: [["value", "数值"], ["pct", "百分比"], ["both", "数值+%"], ["none", "无"]] },
  { k: "show_axis", t: "check", label: "显示数值轴" },
  { k: "log", t: "check", label: "对数轴" },
  { k: "breaks", t: "text", label: "断轴区间", ph: "如 40-160" },
  { k: "highlight_cat", t: "catselect", label: "高亮类目" },
];
const TYPES = [
  { id: "column", name: "柱形 / 条形（堆积·簇状·100%）", anns: true, opts: COL_OPTS,
    hint: "第一列类目，其余每列一个系列。单系列时柱顶标数值，多系列时顶部标合计。",
    sample: "年份\t刻蚀\t沉积\t其他\n2021\t12\t6\t3\n2022\t14\t7\t3.3\n2023\t13\t6.5\t3.1\n2024\t15.5\t7.2\t3.4\n2025E\t17.5\t8\t3.7",
    build(rows, h, o) {
      const cats = rows.map((r) => r[0]); const series = {};
      h.slice(1).forEach((nm, j) => { series[nm || `系列${j + 1}`] = checkNums(numCol(rows, j + 1), nm); });
      const s = { type: "column", cats, series, mode: o.mode || "stacked", sort: o.sort || "sheet", labels: o.labels || "value" };
      if (o.horizontal) s.horizontal = true;
      if (o.show_axis) s.show_axis = true;
      if (o.log) s.log = true;
      const br = parseBreak(o.breaks); if (br) s.breaks = [br];
      if (o.highlight_cat !== undefined && o.highlight_cat !== "") {
        const k = Object.keys(series).length === 1 ? String(o.highlight_cat) : `0,${o.highlight_cat}`;
        s.highlight = { [k]: "accent" };
      }
      if (s.mode === "100") s.totals = false;
      return s;
    } },
  { id: "waterfall", name: "瀑布图（营收桥 / 成本拆解）", anns: false,
    opts: [{ k: "build_down", t: "check", label: "拆解（总量→组成）" }, { k: "show_axis", t: "check", label: "显示数值轴" }],
    hint: "第一列标签，第二列数值。首行为起点；写 e 自动计算小计/合计；负数向下。多列 = 多段瀑布。",
    sample: "项目\t金额\n2024\t20\n销量\t4.2\n价格\t-2.6\n结构\t0.9\n汇率\t-0.7\n2025E\te",
    build(rows, h, o) {
      const multi = h.length > 2;
      const steps = rows.map((r) => {
        if (!multi) { const v = num(r[1]); if (Number.isNaN(v) || v === null) throw new Error(`「${r[0]}」的数值无效`); return [r[0], v]; }
        if (String(r[1]).toLowerCase() === "e") return [r[0], "e"];
        return [r[0], r.slice(1).map((x) => num(x) || 0)];
      });
      const s = { type: "waterfall", steps };
      if (multi) s.series_names = h.slice(1);
      if (o.build_down) s.build_down = true;
      if (o.show_axis) s.show_axis = true;
      return s;
    } },
  { id: "line", name: "折线（趋势 / 份额走势）", anns: true,
    opts: [{ k: "highlight", t: "seriesselect", label: "只高亮一条" }, { k: "pct", t: "check", label: "数值是百分比" },
      { k: "secondary", t: "seriesselect", label: "放到右轴" }, { k: "markers", t: "select", label: "数据点", opts: [["last", "仅末点"], ["all", "全部"], ["none", "无"]] },
      { k: "point_labels", t: "check", label: "标注每个点" }, { k: "smooth", t: "check", label: "平滑" }, { k: "profile", t: "check", label: "轮廓图（旋转90°）" }],
    hint: "第一列类目，其余每列一条线。空单元格自动线性插值。系列名和末值写在线的末端。",
    sample: "年份\tA 公司\tB 公司\tC 公司\n2021\t30%\t22%\t5%\n2022\t29%\t22%\t7%\n2023\t28%\t21%\t10%\n2024\t27%\t21%\t13%\n2025E\t26%\t20%\t16%",
    build(rows, h, o) {
      const cats = rows.map((r) => r[0]); const series = {};
      h.slice(1).forEach((nm, j) => { series[nm] = checkNums(numCol(rows, j + 1), nm); });
      const s = { type: "line", cats, series, markers: o.markers || "last" };
      if (o.highlight) s.highlight = o.highlight;
      if (o.pct) s.pct = true;
      if (o.secondary) s.secondary = [o.secondary];
      if (o.point_labels) { s.point_labels = true; }
      if (o.smooth) s.smooth = true;
      if (o.profile) { s.profile = true; s.end_labels = false; s.markers = "all"; }
      return s;
    } },
  { id: "area", name: "面积（堆积 / 100%）", anns: false,
    opts: [{ k: "mode", t: "select", label: "形式", opts: [["stacked", "堆积"], ["100", "100%"], ["overlap", "重叠"]] }],
    hint: "第一列类目，其余每列一个系列。",
    sample: "年份\t设备\t服务\t备件\n2021\t11\t6\t3\n2022\t13\t6.5\t3\n2023\t14\t7\t2.8\n2024\t17\t7.2\t2.7\n2025E\t20\t7.6\t2.7",
    build(rows, h, o) {
      const series = {}; h.slice(1).forEach((nm, j) => { series[nm] = checkNums(numCol(rows, j + 1), nm); });
      return { type: "area", cats: rows.map((r) => r[0]), series, mode: o.mode || "stacked" };
    } },
  { id: "combo", name: "组合图（柱 + 折线右轴）", anns: true,
    opts: [{ k: "line_pct", t: "check", label: "折线是百分比", def: true }],
    hint: "第一列类目；最后一列画成折线（右轴），其余列画成柱。",
    sample: "年份\t订单(亿)\t毛利率\n2021\t18\t33%\n2022\t22\t31%\n2023\t21\t28%\n2024\t26\t32%\n2025E\t31\t35%",
    build(rows, h, o) {
      const cats = rows.map((r) => r[0]); const bars = {}; const lines = {};
      h.slice(1, -1).forEach((nm, j) => { bars[nm] = checkNums(numCol(rows, j + 1), nm); });
      lines[h[h.length - 1]] = checkNums(numCol(rows, h.length - 1), h[h.length - 1]);
      const s = { type: "combo", cats, bars, lines };
      s.line_fmt = o.line_pct === false ? {} : { pct: true, dec: 0 };
      return s;
    } },
  { id: "pareto", name: "Pareto（降序柱 + 累计%）", anns: false,
    opts: [{ k: "threshold", t: "number", label: "参考线 %", def: 80 }],
    hint: "第一列类目，第二列数值（自动降序）。", sample: "故障类型\t停机小时\n温控失效\t42\n泄漏\t28\n传感器\t14\n通讯\t6\n电源\t4\n软件\t3\n其他\t3",
    build(rows, h, o) { return { type: "pareto", cats: rows.map((r) => r[0]), values: checkNums(numCol(rows, 1), h[1]), threshold: (Number(o.threshold) || 80) / 100 }; } },
  { id: "butterfly", name: "蝴蝶图 / 龙卷风（两方对比）", anns: false,
    opts: [{ k: "tornado", t: "check", label: "龙卷风（按幅度降序）" }],
    hint: "第一列指标，第二列左侧、第三列右侧。", sample: "指标\t国产\t韩系\n营收增速%\t28\t9\n毛利率%\t34\t41\n研发占比%\t14\t9\n海外收入占比%\t12\t55",
    build(rows, h, o) {
      const s = { type: "butterfly", cats: rows.map((r) => r[0]), left: [h[1], checkNums(numCol(rows, 1), h[1])], right: [h[2], checkNums(numCol(rows, 2), h[2])] };
      if (o.tornado) s.sort = "desc";
      return s;
    } },
  { id: "mekko", name: "Mekko（市场 × 份额）", anns: false,
    opts: [{ k: "mode", t: "select", label: "纵轴", opts: [["pct", "百分比（份额）"], ["units", "单位（绝对值）"]] },
      { k: "other_threshold", t: "number", label: "合并其他 <%", def: 5 }],
    hint: "每行一个细分市场（列宽 = 行合计），每列一个厂商，填绝对销售额。单位轴需加一列「宽度」。",
    sample: "细分市场\tA 公司\tB 公司\tC 公司\tD 公司\tE 公司\n刻蚀\t68\t45\t27\t18\t9\n沉积\t18\t22\t14\t11\t6\n光刻\t9\t6\t8\t3\t2\n清洗\t5\t6\t7\t6\t3",
    build(rows, h, o) {
      const wi = h.findIndex((x) => /^(宽度|width)$/i.test(x));
      const series = {};
      h.forEach((nm, j) => { if (j > 0 && j !== wi) series[nm] = checkNums(numCol(rows, j), nm); });
      const s = { type: "mekko", cats: rows.map((r) => r[0]), series, mode: o.mode || "pct" };
      if (s.mode === "units") { if (wi < 0) throw new Error("单位轴 Mekko 需要一列「宽度」"); s.widths = checkNums(numCol(rows, wi), "宽度"); }
      const th = Number(o.other_threshold); if (th > 0) s.other_threshold = th / 100;
      return s;
    } },
  { id: "pie", name: "饼图 / 圆环", anns: false,
    opts: [{ k: "donut", t: "check", label: "圆环" }, { k: "other_below", t: "number", label: "合并其他 <%", def: 5 },
      { k: "explode_first", t: "check", label: "分离最大扇区" }, { k: "center", t: "text", label: "圆环中心文字", ph: "如 62%|前三大客户" }],
    hint: "第一列名称，第二列数值。超过 5 块建议合并为「其他」。", sample: "应用\t占比\n刻蚀\t40\n沉积\t22\n光刻\t15\n清洗\t12\nCMP\t7\n离子注入\t4",
    build(rows, h, o) {
      const s = { type: "pie", labels: rows.map((r) => r[0]), values: checkNums(numCol(rows, 1), h[1]) };
      if (o.donut) s.donut = 0.58;
      const ob = Number(o.other_below); if (ob > 0) s.other_below = ob / 100;
      if (o.explode_first) s.explode = [0];
      if (o.center) s.center_text = o.center.split("|");
      return s;
    } },
  { id: "pie_of_pie", name: "Pie-of-pie（长尾拆解）", anns: false,
    opts: [{ k: "n_small", t: "number", label: "展开最小几项", def: 4 }],
    hint: "第一列名称，第二列数值。", sample: "客户\t收入\nA\t34\nB\t25\nC\t18\nD\t9\nE\t7\nF\t4\nG\t3",
    build(rows, h, o) { return { type: "pie_of_pie", labels: rows.map((r) => r[0]), values: checkNums(numCol(rows, 1), h[1]), n_small: Number(o.n_small) || 4 }; } },
  { id: "concentric", name: "同心圆环（两期结构）", anns: false, opts: [],
    hint: "第一列类别，每列一期（内圈→外圈）。", sample: "应用\t2020\t2025E\n刻蚀\t32\t40\n沉积\t25\t22\n光刻\t18\t15\n其他\t25\t23",
    build(rows, h) { const series = {}; h.slice(1).forEach((nm, j) => { series[nm] = checkNums(numCol(rows, j + 1), nm); }); return { type: "concentric", labels: rows.map((r) => r[0]), series }; } },
  { id: "scatter", name: "散点 / 气泡（四象限）", anns: false,
    opts: [{ k: "bubble", t: "check", label: "气泡（第 4 列为大小）", def: true }, { k: "x_pct", t: "check", label: "X 为百分比" }, { k: "y_pct", t: "check", label: "Y 为百分比" },
      { k: "px", t: "text", label: "X 分界", ph: "如 10%" }, { k: "py", t: "text", label: "Y 分界", ph: "如 32%" },
      { k: "quadrants", t: "text", label: "象限名（左上,右上,左下,右下）", ph: "利润型,明星,待改善,成长型", full: true },
      { k: "trend", t: "select", label: "趋势线", opts: [["", "无"], ["linear", "线性"], ["poly", "二次"], ["exp", "指数"], ["log", "对数"], ["power", "幂"]] },
      { k: "hl", t: "text", label: "高亮点（标签）", ph: "如 C" }],
    hint: "列：标签、X、Y、[大小]、[分组]。气泡面积∝大小。",
    sample: "公司\t营收增速\t毛利率\t营收(亿)\nA\t5%\t28%\t30\nB\t8%\t41%\t22\nC\t25%\t36%\t8\nD\t18%\t38%\t12\nE\t2%\t22%\t18\nF\t12%\t25%\t5",
    build(rows, h, o) {
      const pts = rows.map((r, i) => {
        const p = { x: num(r[1]), y: num(r[2]), label: r[0] };
        if ([p.x, p.y].some((v) => v === null || Number.isNaN(v))) throw new Error(`第 ${i + 1} 行 X/Y 无效`);
        if (h.length > 3 && r[3] !== undefined && r[3] !== "") { const sv = num(r[3]); if (!Number.isNaN(sv) && sv !== null) p.s = sv; else p.group = r[3]; }
        if (h.length > 4 && r[4]) p.group = r[4];
        if (o.hl && o.hl.split(/[,，\s]+/).includes(r[0])) p.highlight = true;
        return p;
      });
      const s = { type: o.bubble === false ? "scatter" : "bubble", points: pts, x_label: h[1], y_label: h[2] };
      if (o.x_pct) s.x_fmt = { pct: true, dec: 0 };
      if (o.y_pct) s.y_fmt = { pct: true, dec: 0 };
      const px = num(o.px), pyv = num(o.py);
      if (px !== null && pyv !== null && !Number.isNaN(px) && !Number.isNaN(pyv)) {
        s.partitions = [px, pyv];
        if (o.quadrants) s.quadrants = o.quadrants.split(/[,，]/).map((x) => x.trim());
      }
      if (o.trend) s.trend = o.trend;
      return s;
    } },
  { id: "football", name: "足球场图（估值区间）", anns: false,
    opts: [{ k: "ref", t: "text", label: "参考线（如现价）", ph: "26.5" }, { k: "ref_label", t: "text", label: "参考线名称", ph: "现价" }],
    hint: "列：方法、低、高。", sample: "方法\t低\t高\nDCF\t28\t41\n可比公司 PE\t25\t36\n可比交易\t30\t44\n52 周区间\t19\t33\n分析师目标价\t27\t38",
    build(rows, h, o) {
      const s = { type: "football", rows: rows.map((r) => [r[0], num(r[1]), num(r[2])]) };
      const rf = num(o.ref); if (rf !== null && !Number.isNaN(rf)) { s.ref = rf; s.ref_label = o.ref_label || "参考"; }
      return s;
    } },
  { id: "candlestick", name: "K 线（红涨绿跌）", anns: false,
    opts: [{ k: "ma", t: "text", label: "均线周期", ph: "5,10" }],
    hint: "列：日期、开、高、低、收。", sample: "日期\t开\t高\t低\t收\n9/1\t20\t20.6\t19.7\t20.4\n9/2\t20.4\t20.9\t20.1\t20.2\n9/3\t20.2\t20.5\t19.3\t19.5\n9/4\t19.5\t19.9\t19.1\t19.8\n9/5\t19.8\t20.8\t19.7\t20.7\n9/6\t20.7\t21.4\t20.5\t21.2\n9/7\t21.2\t21.3\t20.4\t20.6\n9/8\t20.6\t21.9\t20.5\t21.7\n9/9\t21.7\t22.4\t21.5\t22.2\n9/10\t22.2\t22.3\t21.4\t21.6",
    build(rows, h, o) {
      const s = { type: "candlestick", cats: rows.map((r) => r[0]), ohlc: rows.map((r) => [1, 2, 3, 4].map((j) => num(r[j]))) };
      if (o.ma) { s.ma = {}; o.ma.split(/[,，\s]+/).filter(Boolean).forEach((p) => { s.ma["MA" + p] = Number(p); }); }
      return s;
    } },
  { id: "gauge", name: "量规（目标完成度）", anns: false,
    opts: [{ k: "pct", t: "check", label: "百分比", def: true }],
    hint: "两行：「完成」一个数值，可选「目标」。百分比写 72% 或 0.72。", sample: "指标\t值\n完成\t72%\n目标\t75%",
    build(rows, h, o) {
      const v = num(rows[0] && rows[0][1]); const tg = rows[1] ? num(rows[1][1]) : null;
      const s = { type: "gauge", value: v, vmin: 0, vmax: 1, pct: o.pct !== false, label: rows[0][0],
        bands: [[0.5, "#F2C4BE"], [0.8, "#FCE5B8"], [1.0, "#CDE6D3"]] };
      if (o.pct === false) { s.vmax = Math.max(v, tg || 0) * 1.25; s.bands = [[s.vmax, "#DDE9F5"]]; }
      if (tg !== null && !Number.isNaN(tg)) s.target = tg;
      return s;
    } },
  { id: "gantt", name: "甘特图（项目计划）", anns: false,
    opts: [{ k: "scale", t: "select", label: "主刻度", opts: [["month", "月"], ["quarter", "季"], ["week", "周"], ["year", "年"]] },
      { k: "sub_scale", t: "select", label: "次刻度", opts: [["", "无"], ["week", "周"], ["month", "月"]] },
      { k: "today", t: "check", label: "显示今天线", def: true }],
    hint: "列：活动、开始、结束、[负责人]、[备注]、[状态 0-4]。结束留空 = 里程碑。日期如 2026-09-01。",
    sample: "活动\t开始\t结束\t负责人\t备注\t状态\n数据收集\t2026-09-01\t2026-10-15\t张\t\t3\n专家访谈\t2026-09-20\t2026-11-10\t李\t\t1\n模型搭建\t2026-10-15\t2026-12-01\t王\t\t0\n中期汇报\t2026-11-05\t\t张\t\t\n报告撰写\t2026-11-20\t2026-12-22\t张\t含 PPT\t0",
    build(rows, h, o) {
      const items = rows.map((r) => {
        const it = { name: r[0] };
        const st = isoDate(r[1]);
        if (r[2]) { it.start = st; it.end = isoDate(r[2]); } else { it.milestone = st; }
        if (r[3]) it.owner = r[3];
        if (r[4]) it.remark = r[4];
        if (r[5] !== undefined && r[5] !== "") it.status = Number(r[5]);
        return it;
      });
      const ds = items.flatMap((i) => [i.start, i.end, i.milestone].filter(Boolean)).sort();
      const pad = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x.toISOString().slice(0, 10); };
      const d0 = ds[0].slice(0, 8) + "01";
      const s = { type: "gantt", rows: items, d0, d1: pad(ds[ds.length - 1].slice(0, 8) + "01", 1), scale: o.scale || "month" };
      if (o.sub_scale) s.sub_scale = o.sub_scale;
      if (o.today !== false) s.today = new Date().toISOString().slice(0, 10);
      return s;
    } },
  { id: "table", name: "表格（Harvey ball / 复选框）", anns: false,
    opts: [{ k: "harvey", t: "text", label: "Harvey 列（列号）", ph: "如 2,3,4" }, { k: "check", t: "text", label: "复选框列", ph: "如 5" },
      { k: "bar", t: "text", label: "迷你条列", ph: "如 6" }, { k: "total_row", t: "check", label: "最后一行是合计" }],
    hint: "第一行表头。Harvey 列填 0–4；复选框列填 是/否 或 check/cross。列号从 1 开始。",
    sample: "供应商\t交期\t质量\t价格\t认证\t年采购额\nA 公司\t4\t3\t2\t是\t42\nB 公司\t2\t4\t3\t是\t31\nC 公司\t3\t2\t4\t否\t18\nD 公司\t1\t3\t4\t\t9",
    build(rows, h, o) {
      const idx = (s) => (s || "").split(/[,，\s]+/).filter(Boolean).map((x) => Number(x) - 1);
      const hv = idx(o.harvey), ck = idx(o.check), br = idx(o.bar);
      const types = h.map((_, j) => (j === 0 ? "text" : hv.includes(j) ? "harvey" : ck.includes(j) ? "check" : br.includes(j) ? "bar"
        : (rows.every((r) => r[j] === "" || !Number.isNaN(num(r[j]))) ? "num" : "text")));
      const body = rows.map((r) => r.map((c, j) => {
        if (types[j] === "check") return /^(是|y|yes|true|1|check|✓)$/i.test(c) ? "check" : /^(否|n|no|false|0|cross|✗)$/i.test(c) ? "cross" : (c ? c : "empty");
        if (["num", "harvey", "bar"].includes(types[j])) return c === "" ? "" : num(c);
        return c;
      }));
      return { type: "table", header: h, rows: body, col_types: types, total_row: !!o.total_row, dec: 0 };
    } },
];
const T = Object.fromEntries(TYPES.map((t) => [t.id, t]));
function parseBreak(s) { if (!s) return null; const m = String(s).match(/(-?[\d.]+)\s*[-~–至到]\s*(-?[\d.]+)/); return m ? [Number(m[1]), Number(m[2])] : null; }

// ------------------------------------------------------------------ 表单
let OPT = {}, ANN = {};
function renderOpts() {
  const ty = T[$("type").value];
  $("typehint").textContent = ty.hint;
  const box = $("opts");
  box.innerHTML = "";
  $("optCard").style.display = ty.opts.length ? "" : "none";
  const g = document.createElement("div"); g.className = "opt";
  const { rows, head } = currentGrid(true);
  ty.opts.forEach((f) => {
    const lab = document.createElement("label");
    if (f.t === "check") lab.className = "chk";
    if (f.full) lab.classList.add("full");
    let el;
    if (f.t === "select" || f.t === "catselect" || f.t === "seriesselect") {
      el = document.createElement("select");
      let opts = f.opts || [];
      if (f.t === "catselect") opts = [["", "无"]].concat(rows.map((r, i) => [String(i), r[0]]));
      if (f.t === "seriesselect") opts = [["", "无"]].concat(head.slice(1).map((h) => [h, h]));
      el.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      const cur = OPT[f.k] ?? f.def ?? opts[0][0];
      if ([...el.options].some((op) => op.value === String(cur))) el.value = String(cur);
    } else if (f.t === "check") {
      el = document.createElement("input"); el.type = "checkbox"; el.checked = OPT[f.k] ?? f.def ?? false;
    } else {
      el = document.createElement("input"); el.type = f.t === "number" ? "number" : "text";
      if (f.ph) el.placeholder = f.ph;
      el.value = OPT[f.k] ?? f.def ?? "";
    }
    el.dataset.k = f.k;
    el.addEventListener(f.t === "check" || el.tagName === "SELECT" ? "change" : "input", () => { readOpts(); schedule(); });
    if (f.t === "check") { lab.appendChild(el); lab.appendChild(document.createTextNode(f.label)); }
    else { const sp = document.createElement("span"); sp.textContent = f.label; lab.appendChild(sp); lab.appendChild(el); }
    g.appendChild(lab);
  });
  box.appendChild(g);
  readOpts();
  renderAnns();
}
function readOpts() {
  OPT = {};
  $("opts").querySelectorAll("[data-k]").forEach((el) => { OPT[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; });
}
function renderAnns() {
  const ty = T[$("type").value];
  const card = $("annCard");
  if (!ty.anns) { card.style.display = "none"; ANN = {}; return; }
  card.style.display = "";
  const { rows } = currentGrid(true);
  const catOpts = (extra) => extra + rows.map((r, i) => `<option value="${i}">${esc(r[0])}</option>`).join("");
  const n = rows.length;
  $("anns").innerHTML = `
    <div class="ann opt">
      <label><span>CAGR 起点</span><select data-a="cagr0">${catOpts('<option value="">无</option>')}</select></label>
      <label><span>CAGR 终点</span><select data-a="cagr1">${catOpts("")}</select></label>
    </div>
    <div class="ann opt">
      <label class="full"><span>差异箭头</span><select data-a="diff">
        <option value="">无</option><option value="adjacent">相邻类目逐个标注</option><option value="pick">指定两个类目</option></select></label>
      <label><span>从</span><select data-a="d0">${catOpts("")}</select></label>
      <label><span>到</span><select data-a="d1">${catOpts("")}</select></label>
      <label class="full"><span>箭头模式</span><select data-a="dmode">
        <option value="rel">相对变化 %（单向）</option><option value="abs">绝对差值（双向）</option><option value="rel_rev">反向相对 %</option></select></label>
    </div>
    <div class="ann opt">
      <label><span>数值线</span><select data-a="vl"><option value="">无</option><option value="mean">均值</option><option value="value">指定值</option></select></label>
      <label><span>值 / 名称</span><input data-a="vlv" placeholder="如 30 / 目标"></label>
    </div>`;
  const cur = { cagr1: String(Math.max(n - 1, 0)), d1: String(Math.max(n - 1, 0)), ...ANN };
  $("anns").querySelectorAll("[data-a]").forEach((el) => {
    if (cur[el.dataset.a] !== undefined && (el.tagName !== "SELECT" || [...el.options].some((o) => o.value === String(cur[el.dataset.a])))) el.value = cur[el.dataset.a];
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => { readAnns(); schedule(); });
  });
  readAnns();
}
function readAnns() {
  ANN = {};
  $("anns").querySelectorAll("[data-a]").forEach((el) => { ANN[el.dataset.a] = el.value; });
  const pick = ANN.diff === "pick";
  $("anns").querySelectorAll('[data-a="d0"],[data-a="d1"]').forEach((el) => { el.parentElement.style.display = pick ? "" : "none"; });
  const dm = $("anns").querySelector('[data-a="dmode"]'); if (dm) dm.parentElement.style.display = ANN.diff ? "" : "none";
  const vv = $("anns").querySelector('[data-a="vlv"]'); if (vv) vv.parentElement.style.display = ANN.vl ? "" : "none";
}
function annotations(spec, nCats) {
  const a = [];
  const ty = spec.type;
  if (ANN.cagr0 !== undefined && ANN.cagr0 !== "") {
    const i0 = Number(ANN.cagr0), i1 = Number(ANN.cagr1);
    if (i1 > i0 && ty !== "line") a.push({ type: "cagr", i0, i1 });
  }
  if (ANN.diff === "adjacent" && ty === "column") {
    for (let i = 0; i + 1 < nCats; i++) a.push({ type: "diff", a: i, b: i + 1, mode: ANN.dmode || "rel", dec: 0 });
    spec.width = spec.width || 0.5;
  } else if (ANN.diff === "pick" && ty === "column") {
    const d0 = Number(ANN.d0), d1 = Number(ANN.d1);
    if (d0 !== d1) a.push({ type: "diff", a: d0, b: d1, mode: ANN.dmode || "rel" });
  }
  if (ANN.vl === "mean") a.push({ type: "value_line", label: (ANN.vlv || "均值").replace(/^[\d.\s/]+/, "") || "均值" });
  if (ANN.vl === "value") {
    const m = String(ANN.vlv || "").match(/(-?[\d.]+)\s*[/／]?\s*(.*)/);
    if (m) a.push({ type: "value_line", value: Number(m[1]), label: m[2] || "目标" });
  }
  return a;
}

function currentGrid(silent) {
  const g = parseGrid($("data").value);
  return { head: g[0] || [], rows: g.slice(1) };
}

function buildSpec() {
  const ty = T[$("type").value];
  const { head, rows } = currentGrid();
  if (head.length < 2 && ty.id !== "gauge") throw new Error("至少需要两列（类目 + 数值）");
  if (!rows.length) throw new Error("没有数据行");
  const spec = ty.build(rows, head, OPT);
  const [W, H] = $("size").value.split("x").map(Number);
  spec.size = [W, H];
  if ($("title").value.trim()) spec.title = $("title").value.trim();
  if ($("subtitle").value.trim()) spec.subtitle = $("subtitle").value.trim();
  if ($("source").value.trim()) spec.source = $("source").value.trim();
  spec.theme = $("theme").value;
  if ($("dec").value !== "" && !["pie", "pie_of_pie", "concentric", "table", "gantt", "gauge", "scatter", "bubble"].includes(spec.type)) spec.dec = Number($("dec").value);
  if (ty.anns) {
    const ann = annotations(spec, rows.length);
    if (ann.length) spec.annotations = ann;
    if (spec.type === "column" && spec.annotations && spec.annotations.some((x) => x.type === "cagr") && spec.horizontal) {
      spec.annotations = spec.annotations.filter((x) => x.type !== "cagr");
    }
  }
  return spec;
}

// ------------------------------------------------------------------ 渲染
const schedule = debounce(render, 250);
async function render(fromJson) {
  $("dataErr").textContent = "";
  let spec;
  try {
    if (fromJson === true) spec = JSON.parse($("json").value);
    else if ($("jsonLock").checked) spec = JSON.parse($("json").value);
    else { spec = buildSpec(); $("json").value = JSON.stringify(spec, null, 1); }
  } catch (e) { $("dataErr").textContent = e.message; return; }
  saveState();
  if (!API) return;
  try {
    const out = JSON.parse(API.render(JSON.stringify(spec)));
    LAST = { spec, ...out };
    $("preview").innerHTML = out.svg.replace(/width="[\d.]+" height="[\d.]+"/, 'width="100%"');
    const m = (out.meta || []).map((x) => (x.annotation === "cagr" ? `CAGR ${(x.value * 100 >= 0 ? "+" : "")}${(x.value * 100).toFixed(1)}%`
      : x.annotation === "diff" ? `差异 ${x.value}` : x.annotation === "value_line" ? `数值线 ${Number(x.value).toFixed(1)}` : "")).filter(Boolean);
    $("meta").textContent = m.slice(0, 3).join(" · ") + (m.length > 3 ? " …" : "");
    setBusy(false);
  } catch (e) {
    const msg = String(e.message || e).split("\n").filter((l) => l.trim()).slice(-1)[0];
    $("dataErr").textContent = "生成失败：" + msg;
  }
}
function setBusy(b) { document.querySelectorAll(".actions button").forEach((x) => { x.disabled = b || !LAST; }); }

// ------------------------------------------------------------------ Pyodide
async function initPy() {
  try {
    $("loadmsg").textContent = "正在加载 Python 运行环境…";
    PY = await loadPyodide({ indexURL: new URL("pyodide/", location.href).href });
    $("loadmsg").textContent = "正在加载图表引擎…";
    const buf = await (await fetch("py/pylib.zip")).arrayBuffer();
    PY.unpackArchive(buf, "zip", { extractDir: "/lib/tc" });
    PY.runPython("import sys; sys.path.insert(0, '/lib/tc'); import addin_api");
    API = PY.pyimport("addin_api");
    $("loading").classList.add("hide");
    render();
  } catch (e) {
    $("loadmsg").textContent = "引擎加载失败：" + (e.message || e);
  }
}
async function ensurePptx() {
  if (PPTX_READY) return;
  status("首次使用：正在加载 PPT 组件（约 10 MB）…");
  await PY.loadPackage(["lxml", "pillow", "typing-extensions"]);
  PPTX_READY = true;
}

// ------------------------------------------------------------------ 导出（浏览器）
function download(name, blob) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function fileBase() { return (LAST.spec.title || "chart").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40); }
function svgToPngDataUrl(svg, w, h, scale = 2) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement("canvas"); c.width = w * scale; c.height = h * scale; const g = c.getContext("2d"); g.scale(scale, scale); g.drawImage(img, 0, 0, w, h); res(c.toDataURL("image/png")); };
    img.onerror = rej;
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
async function pptxB64() { await ensurePptx(); const r = $("slideRatio") ? $("slideRatio").value : "16:9"; const [w, h] = r === "4:3" ? [10, 7.5] : [13.333, 7.5]; return API.render_pptx(JSON.stringify(LAST.spec), w, h); }
function b64ToBlob(b64, type) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }

// ------------------------------------------------------------------ Office：PowerPoint
function svgForOffice() { return LAST.svg; }
function setSelectedAsync(data, opts) {
  return new Promise((res, rej) => Office.context.document.setSelectedDataAsync(data, opts, (r) => (r.status === Office.AsyncResultStatus.Succeeded ? res() : rej(r.error))));
}
async function pptInsertSvg() {
  const wPt = 640, hPt = wPt * LAST.height / LAST.width;
  try {
    await setSelectedAsync(svgForOffice(), { coercionType: Office.CoercionType.XmlSvg, imageLeft: 40, imageTop: 40, imageWidth: wPt, imageHeight: hPt });
  } catch (e) {
    const png = await svgToPngDataUrl(LAST.svg, LAST.width, LAST.height, 3);
    await setSelectedAsync(png.split(",")[1], { coercionType: Office.CoercionType.Image, imageLeft: 40, imageTop: 40, imageWidth: wPt, imageHeight: hPt });
    return "已插入为图片（此版本 PowerPoint 不支持 SVG）";
  }
  return "已插入。右键 →「转换为形状」可逐个编辑";
}
async function pptInsertSlide() {
  const b64 = await pptxB64();
  await PowerPoint.run(async (ctx) => {
    const sel = ctx.presentation.getSelectedSlides();
    sel.load("items/id");
    await ctx.sync();
    const opt = { formatting: "KeepSourceFormatting" };
    if (sel.items.length) opt.targetSlideId = sel.items[sel.items.length - 1].id;
    ctx.presentation.insertSlidesFromBase64(b64, opt);
    await ctx.sync();
  });
  return "已作为新幻灯片插入（全部为可编辑形状）";
}

// ------------------------------------------------------------------ Office：Excel
async function xlInsertSvg() {
  const wPx = 560;
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getActiveWorksheet();
    const r = ctx.workbook.getSelectedRange(); r.load("left,top,width");
    await ctx.sync();
    let shp;
    try { shp = sh.shapes.addSvg(LAST.svg); }
    catch (e) { const png = await svgToPngDataUrl(LAST.svg, LAST.width, LAST.height, 3); shp = sh.shapes.addImage(png.split(",")[1]); }
    shp.lockAspectRatio = true;
    shp.left = r.left + r.width + 12; shp.top = r.top; shp.width = wPx;
    shp.name = "tc_" + Date.now();
    await ctx.sync();
  });
  return "已插入到选区右侧";
}
const XL_TYPE = { stacked: "ColumnStacked", clustered: "ColumnClustered", "100": "ColumnStacked100" };
function xlChartType(spec) {
  const t = spec.type;
  if (t === "column") { let k = XL_TYPE[spec.mode || "stacked"]; if (spec.horizontal) k = k.replace("Column", "Bar"); if (Object.keys(spec.series).length === 1) k = spec.horizontal ? "BarClustered" : "ColumnClustered"; return k; }
  if (t === "line") return "Line";
  if (t === "area") return spec.mode === "100" ? "AreaStacked100" : spec.mode === "overlap" ? "Area" : "AreaStacked";
  if (t === "pie") return spec.donut ? "Doughnut" : "Pie";
  if (t === "waterfall") return "Waterfall";
  if (t === "pareto") return "Pareto";
  if (t === "scatter") return "XYScatter";
  if (t === "bubble") return "Bubble";
  if (t === "combo") return "ColumnClustered";
  return null;
}
async function xlInsertNative() {
  const kind = xlChartType(LAST.spec);
  if (!kind) throw new Error("这种图 Excel 没有原生类型，请用「插入图表（高保真）」");
  const grid = parseGrid($("data").value);
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getActiveWorksheet();
    let rng;
    if (SEL_ADDRESS) rng = sh.getRange(SEL_ADDRESS.split("!").pop());
    else {  // 数据是粘贴进来的：先写到选中单元格处
      const sel = ctx.workbook.getSelectedRange(); sel.load("address"); await ctx.sync();
      const tl = sel.getCell(0, 0);
      const vals = grid.map((r, i) => r.map((c, j) => {
        const v = num(c);
        if (j === 0 && i > 0 && typeof v === "number") return "'" + c;   // 类目列保持文本，避免被当成系列
        return i === 0 || j === 0 || v === null || Number.isNaN(v) || v === "e" ? c : v;
      }));
      const w = Math.max(...vals.map((r) => r.length));
      vals.forEach((r) => { while (r.length < w) r.push(""); });
      rng = tl.getResizedRange(vals.length - 1, w - 1);
      rng.values = vals;
    }
    const ch = sh.charts.add(kind, rng, "Columns");
    ch.title.text = LAST.spec.title || "";
    ch.title.format.font.size = 13; ch.title.format.font.bold = true;
    try { ch.axes.valueAxis.majorGridlines.visible = false; } catch (e) { /* 部分类型无数值轴 */ }
    ch.dataLabels.showValue = true;
    const pal = { consulting: ["#0B2D4F", "#1F5A8C", "#3F86C0", "#7FB2DC", "#B9D5EC"], semi: ["#1F5A8C", "#A6A6A6", "#7FB2DC", "#595959", "#D9D9D9"], dark: ["#5B9BD5", "#3F86C0", "#7FB2DC", "#B9D5EC", "#DDE9F5"] }[LAST.spec.theme || "consulting"];
    ch.series.load("items"); await ctx.sync();
    if (!["Pie", "Doughnut", "Waterfall", "Pareto"].includes(kind)) {
      const n = ch.series.items.length;
      ch.series.items.forEach((s, i) => { const c = pal[Math.round(i * (pal.length - 1) / Math.max(n - 1, 1))]; try { s.format.fill.setSolidColor(c); s.format.line.color = c; } catch (e) { /* 忽略 */ } });
    }
    if (LAST.spec.type === "combo" && ch.series.items.length > 1) {
      const s = ch.series.items[ch.series.items.length - 1]; s.chartType = "LineMarkers"; s.axisGroup = "Secondary"; s.format.line.color = "#E4572E";
    }
    ch.legend.position = "Top";
    await ctx.sync();
  });
  return "已插入原生图表（改单元格数据会自动更新）";
}
async function xlReadSelection() {
  await Excel.run(async (ctx) => {
    const r = ctx.workbook.getSelectedRange(); r.load("values,numberFormat,address"); await ctx.sync();
    const lines = r.values.map((row, i) => row.map((v, j) => {
      const nf = String((r.numberFormat[i] || [])[j] || "");
      if (typeof v === "number" && /[yd]/i.test(nf) && !/%/.test(nf) && v > 20000) return excelDate(v);
      if (typeof v === "number" && /%/.test(nf)) return +(v * 100).toFixed(6) + "%";
      return v;
    }).join("\t"));
    $("data").value = lines.join("\n");
    SEL_ADDRESS = r.address;
  });
  renderOpts(); schedule();
  return "已读取选区 " + (SEL_ADDRESS || "");
}

// ------------------------------------------------------------------ 状态保存
function saveState() {
  store.set("state", { type: $("type").value, data: $("data").value, title: $("title").value, subtitle: $("subtitle").value,
    source: $("source").value, theme: $("theme").value, dec: $("dec").value, size: $("size").value, opt: OPT, ann: ANN });
}
function loadState() {
  const s = store.get("state", null);
  if (!s || !T[s.type]) return false;
  $("type").value = s.type; $("data").value = s.data || T[s.type].sample;
  ["title", "subtitle", "source", "theme", "dec", "size"].forEach((k) => { if (s[k] !== undefined) $(k).value = s[k]; });
  OPT = s.opt || {}; ANN = s.ann || {};
  return true;
}

// ------------------------------------------------------------------ 启动
function wire() {
  $("type").innerHTML = TYPES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  if (!loadState()) { $("type").value = "column"; $("data").value = T.column.sample; $("title").value = "Chiller 市场 4 年复合增长 8.6%"; $("subtitle").value = "全球市场规模，亿美元"; ANN = { cagr0: "0", cagr1: "4" }; }
  $("type").addEventListener("change", () => {
    OPT = {}; ANN = {}; SEL_ADDRESS = null;
    const cur = parseGrid($("data").value);
    if (!cur.length || TYPES.some((t) => t.sample === $("data").value)) $("data").value = T[$("type").value].sample;
    renderOpts(); schedule();
  });
  $("data").addEventListener("input", () => { SEL_ADDRESS = null; debounce(() => { renderOpts(); }, 400)(); schedule(); });
  ["title", "subtitle", "source"].forEach((k) => $(k).addEventListener("input", schedule));
  ["theme", "dec", "size"].forEach((k) => $(k).addEventListener("change", schedule));
  $("btnSample").onclick = () => { $("data").value = T[$("type").value].sample; SEL_ADDRESS = null; renderOpts(); schedule(); };
  $("btnJson").onclick = () => render(true);
  const act = (fn) => async () => {
    if (!LAST) return;
    setBusy(true); status("处理中…");
    try { const msg = await fn(); status(msg || "完成", "ok"); }
    catch (e) { status("失败：" + (e.message || e.code || e), "bad"); console.error(e); }
    finally { setBusy(false); }
  };
  $("btnSvgPpt").onclick = act(pptInsertSvg);
  $("btnSlide").onclick = act(pptInsertSlide);
  $("btnSvgXl").onclick = act(xlInsertSvg);
  $("btnNative").onclick = act(xlInsertNative);
  $("btnSel").onclick = act(xlReadSelection);
  $("btnDlSvg").onclick = act(async () => { download(fileBase() + ".svg", new Blob([LAST.svg], { type: "image/svg+xml" })); return "已下载 SVG"; });
  $("btnDlPng").onclick = act(async () => { const u = await svgToPngDataUrl(LAST.svg, LAST.width, LAST.height, 3); download(fileBase() + ".png", b64ToBlob(u.split(",")[1], "image/png")); return "已下载 PNG"; });
  $("btnDlPptx").onclick = act(async () => { download(fileBase() + ".pptx", b64ToBlob(await pptxB64(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")); return "已下载 PPTX"; });
  // 幻灯片比例选择（PPT）
  const r = document.createElement("select"); r.id = "slideRatio"; r.innerHTML = '<option value="16:9">目标幻灯片 16:9</option><option value="4:3">目标幻灯片 4:3</option>';
  r.value = store.get("ratio", "16:9"); r.onchange = () => store.set("ratio", r.value);
  $("btnSlide").after(r);
  renderOpts();
  setBusy(true);
}
function setHost(h) {
  HOST = h;
  document.body.classList.remove("ppt", "xl", "web");
  document.body.classList.add(h);
  $("host").textContent = { ppt: "PowerPoint", xl: "Excel", web: "浏览器预览模式" }[h];
}

wire();
setHost("web");
let hostSet = false;
if (window.Office && Office.onReady) {
  Office.onReady((info) => {
    hostSet = true;
    if (info.host === Office.HostType.PowerPoint) setHost("ppt");
    else if (info.host === Office.HostType.Excel) setHost("xl");
  });
}
initPy();
