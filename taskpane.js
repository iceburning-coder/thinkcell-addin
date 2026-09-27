/* think-cell 风格图表 · Office 加载项（PowerPoint / Excel / 浏览器）
 * 数据表 → 图表 JSON → Pyodide 里的 tccore 引擎 → SVG / PPTX → 插入 Office
 */
"use strict";
const $ = (id) => document.getElementById(id);
let HOST = "web";           // ppt | xl | web
let PY = null, API = null, PPTX_READY = false;
let OFFICE_CAPS = TC.Office.getCapabilities(window.Office, HOST);
let LAST = null;            // {spec, svg, width, height, meta}
const UI_BUSY = TC.Office.createBusyTracker(() => refreshActionUi());
const PREVIEW_FRESHNESS = TC.Office.createFreshnessTracker(() => refreshActionUi());
let END_STARTUP_BUSY = null;
const RENDER_LIFECYCLE = TC.State.createRenderLifecycle();
let SEL_ADDRESS = null;     // Excel：读取选区的地址（原生图表用）
let EDIT = null;            // 正在编辑的已插入图表 {name, id, slideId}
let SEL_CHART = null;       // PowerPoint 当前选中的插件图表
const PREFIX = "TC:";
const DEMO_TITLE = "Chiller 市场 4 年复合增长 8.6%";       // 插件图表的形状名前缀；图表设置存于文档 settings[形状名]

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

// ------------------------------------------------------------------ 表格编辑器
let GRID = [["", ""], ["", ""]];
let CUR = { r: 1, c: 1 };
function padGrid(g) {
  const w = Math.max(2, ...g.map((r) => r.length));
  g.forEach((r) => { while (r.length < w) r.push(""); });
  while (g.length < 2) g.push(Array(w).fill(""));
  return g;
}
function gridToText(g) {
  let rows = g.map((r) => r.map((c) => String(c ?? "").replace(/[\t\n]/g, " ")));
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  let w = Math.max(0, ...rows.map((r) => { let k = r.length; while (k && r[k - 1].trim() === "") k--; return k; }));
  return rows.map((r) => r.slice(0, w).join("\t")).join("\n");
}
function setData(text, keepSel) {
  $("data").value = text;
  GRID = padGrid(parseGrid(text).map((r) => r.slice()));
  if (!keepSel) SEL_ADDRESS = null;
  renderGrid();
}
function renderGrid() {
  const g = GRID;
  const extraRow = g.concat([Array(g[0].length).fill("")]);   // 末尾空行：直接往下填
  let h = "<table>";
  extraRow.forEach((row, r) => {
    h += `<tr class="${r === 0 ? "hd" : ""}"><td class="rh">${r === 0 ? "" : r}</td>`;
    row.concat([""]).forEach((v, c) => {
      h += `<td><input data-r="${r}" data-c="${c}" value="${esc(v)}"${r === 0 && c === 0 ? ' placeholder="表头"' : ""}></td>`;
    });
    h += "</tr>";
  });
  $("grid").innerHTML = h + "</table>";
}
function gridChanged() {
  $("data").value = gridToText(GRID);
  SEL_ADDRESS = null;
  onDataChanged();
}
function ensureCell(r, c) {
  while (GRID.length <= r) GRID.push(Array(GRID[0].length).fill(""));
  if (GRID[0].length <= c) GRID.forEach((row) => { while (row.length <= c) row.push(""); });
}
function gridWire() {
  const box = $("grid");
  box.addEventListener("input", (e) => {
    const el = e.target; if (!el.dataset.r) return;
    const r = +el.dataset.r, c = +el.dataset.c;
    const grow = r >= GRID.length || c >= GRID[0].length;
    ensureCell(r, c); GRID[r][c] = el.value;
    if (grow) { renderGrid(); const n = box.querySelector(`input[data-r="${r}"][data-c="${c}"]`); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }
    gridChanged();
  });
  box.addEventListener("focusin", (e) => { if (e.target.dataset.r) CUR = { r: +e.target.dataset.r, c: +e.target.dataset.c }; });
  box.addEventListener("paste", (e) => {
    const el = e.target; if (!el.dataset.r) return;
    const txt = (e.clipboardData || window.clipboardData).getData("text");
    if (pasteChart(txt)) { e.preventDefault(); return; }
    if (!/[\t\n]/.test(txt.trim())) return;
    e.preventDefault();
    const block = txt.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    const r0 = +el.dataset.r, c0 = +el.dataset.c;
    block.forEach((row, i) => row.forEach((v, j) => { ensureCell(r0 + i, c0 + j); GRID[r0 + i][c0 + j] = v.trim(); }));
    padGrid(GRID); renderGrid(); gridChanged();
  });
  box.addEventListener("keydown", (e) => {
    const el = e.target; if (!el.dataset.r || e.key !== "Enter") return;
    e.preventDefault();
    const n = box.querySelector(`input[data-r="${+el.dataset.r + 1}"][data-c="${el.dataset.c}"]`);
    if (n) n.focus();
  });
  document.querySelectorAll("[data-g]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.g, w = GRID[0].length;
    if (a === "copyData") { copyText(gridToText(GRID)).then((ok) => status(ok ? "已复制表格数据：到 Excel 里选一个单元格 ⌘V 即可" : "复制失败，请切到「文本」后手动全选复制", ok ? "ok" : "bad")); return; }
    if (a === "copyChart") { copyText(chartPayload()).then((ok) => status(ok ? "已复制整张图：到另一个程序（PPT / Excel）的面板里，点任意表格格子 ⌘V" : "复制失败", ok ? "ok" : "bad")); return; }
    if (a === "addRow") GRID.splice(Math.max(CUR.r, 0) + 1, 0, Array(w).fill(""));
    if (a === "addCol") GRID.forEach((row) => row.splice(CUR.c + 1, 0, ""));
    if (a === "delRow" && GRID.length > 2 && CUR.r > 0 && CUR.r < GRID.length) GRID.splice(CUR.r, 1);
    if (a === "delCol" && w > 2 && CUR.c < w) GRID.forEach((row) => row.splice(CUR.c, 1));
    if (a === "transpose") GRID = padGrid(GRID[0].map((_, c) => GRID.map((row) => row[c])));
    if (a === "clear") GRID = [["", ""], ["", ""]];
    if (a === "text") {
      const show = $("data").classList.contains("hide");
      $("data").classList.toggle("hide", !show); $("grid").classList.toggle("hide", show);
      b.textContent = show ? "表格" : "文本";
      if (!show) setData($("data").value, true);
      return;
    }
    renderGrid(); gridChanged();
  }));
}

// ---- 剪贴板：复制数据 / 复制整张图（PPT ↔ Excel 互通）
const PAYLOAD = TC.State.PAYLOAD_PREFIX;
function copyText(txt) {
  const fallback = () => {
    const ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove(); return ok;
  };
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt).then(() => true, () => fallback());
  return Promise.resolve(fallback());
}
function chartPayload() {
  const st = panelState(); st.sel = null; st.src = HOST;
  return TC.State.serializeClipboard(st);
}
function pasteChart(txt) {
  txt = String(txt || "").trim();
  if (!txt.startsWith(PAYLOAD)) return false;
  try {
    const record = TC.State.parseClipboard(txt);
    if (!applyState(record)) throw new Error("格式不对");
    SEL_ADDRESS = null; render();
    status(EDIT ? "已载入复制来的图表，点「更新所选图表」替换" : "已载入复制来的图表，可直接插入", "ok");
  } catch (e) { status("粘贴的图表无法识别：" + e.message, "bad"); }
  return true;
}

// ------------------------------------------------------------------ 甘特数据解析（按表头识别列）
const GANTT_COLS = {
  name: /^(活动|任务|事项|名称|activity|task|name|item)$/i, start: /^(开始|开始日期|起始|日期|start|date|from)$/i,
  end: /^(结束|结束日期|截止|完成|end|finish|to|due)$/i, label: /^(标签|文字|说明文字|里程碑|label|milestone|text)$/i,
  style: /^(样式|类型|形状|style|type|shape)$/i, owner: /^(负责人|责任人|owner|responsible|resp\.?)$/i,
  remark: /^(备注|说明|remark|remarks|note|notes|comment)$/i, status: /^(状态|进度|status|progress)$/i,
  group: /^(分组|组|颜色|group|color|colour|category)$/i, section: /^(阶段|分段|板块|section|phase|stage)$/i,
};
function ganttCols(h) {
  const idx = {};
  h.forEach((x, j) => { const v = String(x || "").trim(); for (const k in GANTT_COLS) if (idx[k] === undefined && GANTT_COLS[k].test(v)) { idx[k] = j; break; } });
  if (idx.name === undefined || idx.start === undefined) {   // 旧格式：按位置
    return { name: 0, start: 1, end: 2, owner: 3, remark: 4, status: 5, group: 6 };
  }
  return idx;
}
function ganttSpec(rows, h, o) {
  const ix = ganttCols(h);
  const get = (r, k) => (ix[k] === undefined ? "" : String(r[ix[k]] ?? "").trim());
  const items = [], milestones = [], shades = [];
  let d0 = null, d1 = null, pendingSep = false, lastSection = null, cur = null;
  rows.forEach((r) => {
    const name = get(r, "name");
    if (/^[-—–_]{2,}$/.test(name)) { pendingSep = true; return; }
    const toks = get(r, "style").toLowerCase().split(/[\s,，、/;；]+/).filter(Boolean);
    const has = (re) => toks.some((x) => re.test(x));
    const sRaw = get(r, "start"), eRaw = get(r, "end"), label = get(r, "label");
    if (!sRaw) {
      if (name && !eRaw) { cur = { name, sep: pendingSep, items: [] }; pendingSep = false; fillMeta(cur, r); items.push(cur); }
      return;
    }
    const st = isoDate(sRaw), en = eRaw ? isoDate(eRaw) : null;
    if (has(/^(范围|range|轴|axis)$/)) { d0 = st; if (en) d1 = en; return; }
    if (has(/^(底纹|shade|排他|假期|holiday|冻结|freeze)$/) && en) { shades.push({ start: st, end: en, text: label || name }); return; }
    if (has(/^(竖线|全局|line|global|vline)$/)) { milestones.push({ name: label || name, date: st }); return; }
    const pos = has(/^(左|left)$/) ? "left" : has(/^(上|above|top)$/) ? "above" : has(/^(下|below|bottom)$/) ? "below" : has(/^(中|center|inside|内)$/) ? "center" : has(/^(右|right)$/) ? "right" : null;
    const shape = has(/^(三角|triangle)$/) ? "triangle" : has(/^(圆|circle)$/) ? "circle" : has(/^(方|square)$/) ? "square" : has(/^(星|star)$/) ? "star" : "diamond";
    const it = en ? { start: st, end: en, style: has(/^(虚线|dashed|dash|计划|plan)$/) ? "dashed" : "solid" } : { date: st, shape };
    if (label) it.label = label;
    if (pos) { if (en) it.label_pos = pos; else it.pos = pos; }
    if (!name && cur) { cur.items.push(it); return; }
    const sec = get(r, "section");
    cur = { name: name || "", items: [it], sep: pendingSep || (sec !== "" && lastSection !== null && sec !== lastSection) };
    if (sec !== "") lastSection = sec;
    pendingSep = false;
    fillMeta(cur, r);
    items.push(cur);
  });
  function fillMeta(x, r) {
    const ow = get(r, "owner"), rm = get(r, "remark"), stv = get(r, "status"), g = get(r, "group");
    if (ow) x.owner = ow;
    if (rm) x.remark = rm;
    if (stv !== "") x.status = /^-?\d+(\.\d+)?$/.test(stv) ? Number(stv) : stv;
    if (g) x.group = g;
  }
  if (!items.length) throw new Error("没有可画的活动行");
  const s = { type: "gantt", rows: items, cols: [ix.owner !== undefined ? h[ix.owner] : "负责人", ix.remark !== undefined ? h[ix.remark] : "备注"] };
  if (ix.name !== undefined && h[ix.name]) s.head_label = h[ix.name];
  if (ix.status !== undefined && h[ix.status]) s.status_label = h[ix.status];
  if (milestones.length) s.milestones = milestones;
  if (shades.length) s.shades = shades;
  const rs = (o.range_start || "").trim(), re_ = (o.range_end || "").trim();
  if (rs) d0 = isoDate(rs);
  if (re_) d1 = isoDate(re_);
  if (d0) s.d0 = d0;
  if (d1) s.d1 = d1;
  const sc = o.scale || "auto";
  if (sc === "auto") s.scale = "auto"; else s.scales = sc.split(",");
  if (o.week_fmt) s.week_fmt = o.week_fmt;
  if (o.fy_start && o.fy_start !== "1") s.fy_start = Number(o.fy_start);
  ["date_labels", "weekends", "row_shading"].forEach((k) => { if (o[k]) s[k] = true; });
  if (o.today) s.today = new Date().toISOString().slice(0, 10);
  return s;
}

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
    opts: [{ k: "scale", t: "select", label: "时间刻度", opts: [["auto", "自动"], ["month,week", "月 + 周"], ["month,day", "月 + 日"], ["year,month", "年 + 月"], ["year,quarter", "年 + 季"], ["month", "月"], ["quarter", "季"], ["week", "周"], ["year", "年"]] },
      { k: "week_fmt", t: "select", label: "周显示", opts: [["iso", "周号（ISO）"], ["date", "日期（月/日）"]] },
      { k: "range_start", t: "text", label: "范围开始", ph: "留空=自动，如 2026-04-27" },
      { k: "range_end", t: "text", label: "范围结束", ph: "留空=自动" },
      { k: "fy_start", t: "select", label: "财年起始月", opts: [["1", "1 月（自然年）"], ["4", "4 月"], ["7", "7 月"], ["10", "10 月"]] },
      { k: "date_labels", t: "check", label: "条形两端显示日期" },
      { k: "weekends", t: "check", label: "周末底纹" },
      { k: "row_shading", t: "check", label: "隔行底纹" },
      { k: "today", t: "check", label: "今天线" }],
    hint: "按表头识别列：活动、开始、结束、标签、样式、负责人、备注、状态(0-4 / 是 / 否)、分组、阶段。结束留空 = 里程碑。活动留空 = 画在上一行（一行多段）。阶段变化或活动写 --- = 分隔线。样式可写：虚线、左/右/上/下（标签位置）、三角/圆/方/星（里程碑形状）、竖线（全局里程碑）、底纹（排他期/假期）、范围（时间轴起止）。",
    sample: [
      "活动\t开始\t结束\t标签\t样式\t负责人\t状态\t阶段",
      "时间范围\t2026-04-27\t2026-07-26\t\t范围\t\t\t",
      "发送推介材料\t2026-04-15\t2026-05-06\t\t\tSasha\t4\t准备",
      "签署保密协议\t2026-05-04\t2026-05-08\t\t\tMahan\t4\t准备",
      "管理层电话会\t2026-05-08\t2026-05-23\t\t\tAmal, Dani\t4\t尽调",
      "财务模型与估值\t2026-05-08\t2026-05-30\t\t\tDani\t4\t尽调",
      "意向报价\t2026-05-25\t2026-06-05\t\t\tAmal\t3\t尽调",
      "\t2026-06-05\t\t买家短名单\t右\t\t\t",
      "数据室开放\t2026-05-08\t2026-06-05\t第一阶段\t虚线\tAmal, Hao\t3\t尽调",
      "\t2026-06-05\t2026-06-29\t第二阶段\t虚线\t\t\t",
      "管理层现场会\t2026-06-10\t2026-06-26\t\t\tDani\t2\t尽调",
      "最终尽职调查\t2026-06-05\t2026-07-06\t\t\tAmal, Hao, Rosario\t1\t尽调",
      "\t2026-07-04\t\t尽调报告交付\t下\t\t\t",
      "最终协议 SPA/APA\t2026-07-06\t2026-07-24\t\t\tQuinn\t0\t签约",
      "股东协议\t2026-06-29\t2026-07-20\t\t虚线\tQuinn\t0\t签约",
      "\t2026-07-20\t2026-07-24\t\t\t\t\t",
      "\t2026-06-29\t\tSPA 初稿\t左\t\t\t",
      "保密协议签署\t2026-05-08\t\t\t竖线\t\t\t",
      "尽调启动\t2026-06-05\t\t\t竖线\t\t\t",
      "排他期\t2026-06-29\t2026-07-06\t\t底纹\t\t\t",
      "协议签署\t2026-07-24\t\t7月24日 协议签署\t竖线\t\t\t",
    ].join("\n"),
    build(rows, h, o) { return ganttSpec(rows, h, o); } },
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
function annotations(spec, nCats, ANN) {
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

function buildSpec(st) {
  st = st || panelState();
  const ty = T[st.type];
  if (!ty) throw new Error("未知图表类型");
  const g = parseGrid(st.data || "");
  const head = g[0] || [], rows = g.slice(1);
  if (head.length < 2 && ty.id !== "gauge") throw new Error("至少需要两列（类目 + 数值）");
  if (!rows.length) throw new Error("没有数据行");
  const mag = Number(st.mag || 1);
  const spec = ty.build(mag > 1 && MAG_TYPES.has(ty.id) ? scaleRows(rows, mag) : rows, head, st.opt || {});
  const [W, H] = String(st.size || "680x400").split("x").map(Number);
  spec.size = [W, H];
  ["title", "subtitle", "source"].forEach((k) => { const v = String(st[k] || "").trim(); if (v) spec[k] = v; });
  spec.theme = st.theme === "custom" ? Object.assign({ base: "consulting" }, customTheme()) : (st.theme || "consulting");
  if (LEGEND_TYPES.has(spec.type)) {
    if (st.legend && st.legend !== "auto") spec.legend = st.legend;
    if (st.legendRev) spec.legend_reverse = true;
  }
  const cols = st.colors || {}, sc = {};
  seriesNames(spec).forEach((n) => { if (cols[n]) sc[n] = cols[n]; });
  if (Object.keys(sc).length) spec.series_colors = sc;
  if (st.dec !== "" && st.dec !== undefined && st.dec !== null && !["pie", "pie_of_pie", "concentric", "table", "gantt", "gauge", "scatter", "bubble"].includes(spec.type)) spec.dec = Number(st.dec);
  if (ty.anns) {
    const ann = annotations(spec, rows.length, st.ann || {});
    if (ann.length) spec.annotations = ann;
    if (spec.type === "column" && spec.annotations && spec.annotations.some((x) => x.type === "cagr") && spec.horizontal) {
      spec.annotations = spec.annotations.filter((x) => x.type !== "cagr");
    }
  }
  return spec;
}
// 不动面板，按保存的图表状态直接出图（Excel 链接自动刷新用）
function renderState(st) {
  const record = TC.State.normalize(st, { mode: "read" });
  const chart = record.chart;
  const spec = chart.json ? TC.State.validateSpec(JSON.parse(chart.json)) : buildSpec(chart);
  return Object.assign({ spec }, JSON.parse(API.render(JSON.stringify(spec))));
}

const MAG_TYPES = new Set(["column", "waterfall", "line", "area", "combo", "pareto", "butterfly", "mekko", "pie", "pie_of_pie",
  "concentric", "football", "candlestick"]);
const LEGEND_TYPES = new Set(["column", "line", "area", "combo", "pareto", "mekko", "pie", "scatter", "bubble", "waterfall", "gantt"]);
function scaleRows(rows, k) {
  return rows.map((r) => r.map((c, j) => {
    if (j === 0 || typeof c !== "string") return c;
    const t = c.trim();
    if (t === "" || /%$/.test(t) || /^e$/i.test(t)) return c;
    const v = num(t);
    return typeof v === "number" && !Number.isNaN(v) ? String(+(v / k).toPrecision(12)) : c;
  }));
}

// ------------------------------------------------------------------ 颜色
let COLORS = {};   // 系列名 → 颜色（用户指定）
const PAL = {
  consulting: ["#0B2D4F", "#1F5A8C", "#3F86C0", "#7FB2DC", "#B9D5EC"],
  semi: ["#1F5A8C", "#A6A6A6", "#7FB2DC", "#595959", "#D9D9D9"],
  dark: ["#5B9BD5", "#3F86C0", "#7FB2DC", "#B9D5EC", "#DDE9F5"],
};
const THEME_DEF = { SERIES: PAL.consulting.slice(), ACCENT: "#E4572E", OTHER: "#D9D9D9", POS: "#2E8B57", NEG: "#C0392B", TOTAL: "#0B2D4F" };
function customTheme() { const t = store.get("customTheme", null); return t && t.SERIES ? t : JSON.parse(JSON.stringify(THEME_DEF)); }
function curPalette() { const th = $("theme").value; return th === "custom" ? customTheme().SERIES : (PAL[th] || PAL.consulting); }
function autoColors(n, cat) {
  const s = curPalette();
  if (cat) { const c = [s[0], s[2], "#8C8C8C", s[1], "#595959", s[3]]; return Array.from({ length: n }, (_, i) => c[i % c.length]); }
  if ($("theme").value === "semi") return Array.from({ length: n }, (_, i) => s[i % s.length]);
  if (n === 1) return [s[0]];
  if (n <= s.length) return Array.from({ length: n }, (_, i) => s[Math.round(i * (s.length - 1) / (n - 1))]);
  return Array.from({ length: n }, (_, i) => s.concat(["#595959", "#A6A6A6", "#D0D0D0", "#ED7D31", "#FFC000"])[i % 10]);
}
function seriesNames(spec) {
  const t = spec.type;
  if (["column", "line", "area", "mekko"].includes(t)) return Object.keys(spec.series || {});
  if (t === "combo") return Object.keys(spec.bars).concat(Object.keys(spec.lines));
  if (["pie", "pie_of_pie", "concentric"].includes(t)) return (spec.labels || []).map(String);
  if (t === "waterfall") return spec.series_names || (spec.build_down ? ["组成", "合计"] : ["增加", "减少", "合计"]);
  if (t === "butterfly") return [spec.left[0], spec.right[0]];
  if (t === "scatter" || t === "bubble") return [...new Set((spec.points || []).map((p) => p.group).filter((g) => g != null))].map(String);
  if (t === "gantt") return [...new Set((spec.rows || []).map((r) => r.group).filter((g) => g != null))].map(String);
  return [];
}
let COLOR_KEY = "";
function renderColors(spec) {
  const names = spec ? seriesNames(spec) : [];
  const key = $("theme").value + "|" + names.join("\u0001") + "|" + JSON.stringify(COLORS);
  if (key === COLOR_KEY) return;
  COLOR_KEY = key;
  $("colorCard").style.display = names.length ? "" : "none";
  const t = spec ? spec.type : "";
  const wf = { "增加": "#2E8B57", "减少": "#C0392B", "合计": "#0B2D4F", "组成": "#3F86C0" };
  const auto = autoColors(names.length, ["line", "scatter", "bubble"].includes(t));
  $("colors").innerHTML = names.map((n, i) => {
    const a = t === "waterfall" && !spec.series_names ? wf[n] : auto[i];
    const v = COLORS[n] || a;
    return `<span class="ci ${COLORS[n] ? "" : "auto"}"><input type="color" data-n="${esc(n)}" value="${v}">${esc(n)}${COLORS[n] ? `<button class="rs" data-rs="${esc(n)}" title="恢复自动">↺</button>` : ""}</span>`;
  }).join("");
}
function colorsWire() {
  $("colors").addEventListener("input", (e) => { const n = e.target.dataset.n; if (!n) return; COLORS[n] = e.target.value; schedule(); });
  $("colors").addEventListener("change", () => { COLOR_KEY = ""; render(); });
  $("colors").addEventListener("click", (e) => { const n = e.target.dataset.rs; if (!n) return; delete COLORS[n]; COLOR_KEY = ""; render(); });
}
function renderThemeEditor() {
  const on = $("theme").value === "custom";
  $("themeEd").classList.toggle("hide", !on);
  if (!on) return;
  const t = customTheme();
  const items = t.SERIES.map((c, i) => [`SERIES.${i}`, `系列 ${i + 1}${i === 0 ? "（最深）" : ""}`, c])
    .concat([["ACCENT", "强调色", t.ACCENT], ["OTHER", "其他（灰）", t.OTHER], ["POS", "瀑布·增加", t.POS], ["NEG", "瀑布·减少", t.NEG], ["TOTAL", "合计", t.TOTAL]]);
  $("themeSw").innerHTML = items.map(([k, l, c]) => `<span class="ci"><input type="color" data-tk="${k}" value="${c}">${l}</span>`).join("");
}
function themeWire() {
  $("themeSw").addEventListener("input", (e) => {
    const k = e.target.dataset.tk; if (!k) return;
    const t = customTheme();
    if (k.startsWith("SERIES.")) t.SERIES[+k.split(".")[1]] = e.target.value; else t[k] = e.target.value;
    store.set("customTheme", t); COLOR_KEY = ""; schedule();
  });
  $("btnThemeReset").onclick = () => { store.set("customTheme", null); renderThemeEditor(); COLOR_KEY = ""; render(); };
}

// ------------------------------------------------------------------ 渲染
const renderLater = debounce(render, 250);
function schedule() {
  PREVIEW_FRESHNESS.invalidate();
  refreshActionUi();
  renderLater();
}
async function render(fromJson) {
  PREVIEW_FRESHNESS.invalidate();
  const endBusy = UI_BUSY.begin();
  try {
    const renderId = RENDER_LIFECYCLE.start();
    LAST = null;
    $("dataErr").textContent = "";
    $("meta").textContent = "";
    $("preview").textContent = "";
    let spec;
    try {
      if (fromJson === true) spec = TC.State.validateSpec(JSON.parse($("json").value));
      else if ($("jsonLock").checked) spec = TC.State.validateSpec(JSON.parse($("json").value));
      else { spec = buildSpec(); $("json").value = JSON.stringify(spec, null, 1); }
    } catch (e) {
      RENDER_LIFECYCLE.fail(renderId);
      $("dataErr").textContent = e.userMessage || e.message;
      return;
    }
    try { renderColors(spec); saveState(); }
    catch (e) {
      RENDER_LIFECYCLE.fail(renderId);
      $("dataErr").textContent = e.userMessage || e.message;
      return;
    }
    if (!API) return;
    try {
      const out = JSON.parse(API.render(JSON.stringify(spec)));
      if (out.error) throw new TC.State.TCError(out.error.code || "TC_ENGINE_RENDER_FAILED", out.error.message || "图表生成失败");
      const safeSvg = TC.State.sanitizeSvg(out.svg);
      const snapshot = { spec, ...out };
      if (!RENDER_LIFECYCLE.publish(renderId, snapshot)) return;
      LAST = RENDER_LIFECYCLE.current();
      PREVIEW_FRESHNESS.publish();
      safeSvg.setAttribute("width", "100%");
      safeSvg.removeAttribute("height");
      $("preview").replaceChildren(document.importNode(safeSvg, true));
      const m = (out.meta || []).map((x) => (x.annotation === "cagr" ? `CAGR ${(x.value * 100 >= 0 ? "+" : "")}${(x.value * 100).toFixed(1)}%`
        : x.annotation === "diff" ? `差异 ${x.value}` : x.annotation === "value_line" ? `数值线 ${Number(x.value).toFixed(1)}` : "")).filter(Boolean);
      $("meta").textContent = m.slice(0, 3).join(" · ") + (m.length > 3 ? " …" : "");
    } catch (e) {
      if (!RENDER_LIFECYCLE.isCurrent(renderId)) return;
      RENDER_LIFECYCLE.fail(renderId);
      LAST = null;
      const msg = String(e.message || e).split("\n").filter((l) => l.trim()).slice(-1)[0];
      $("dataErr").textContent = "生成失败：" + msg;
    }
  } finally {
    endBusy();
  }
}
function applyCapabilityUi() {
  const gates = [
    ["btnSlide", "powerPointSlides", "当前 PowerPoint 版本不支持插入可编辑幻灯片", true],
    ["btnLoadSel", "powerPointSelection", "当前 PowerPoint 版本不支持识别所选形状", false],
    ["btnUpdate", "powerPointSelection", "当前 PowerPoint 版本不支持原位编辑图表", true],
  ];
  gates.forEach(([id, capability, reason, requiresChart]) => {
    const element = $(id); if (!element) return;
    const gate = TC.Office.capabilityGate(OFFICE_CAPS, capability, {
      reason, requiresChart, busy: UI_BUSY.isBusy(), hasChart: chartReady(),
    });
    element.disabled = gate.disabled; element.title = gate.title;
  });
}
function chartReady() { return !!LAST && PREVIEW_FRESHNESS.isFresh(); }
function refreshActionUi() {
  const busy = UI_BUSY.isBusy();
  document.querySelectorAll(".actions button").forEach((x) => { x.disabled = busy || !chartReady(); });
  applyCapabilityUi();
}

// ------------------------------------------------------------------ Pyodide
async function initPy() {
  try {
    $("loadmsg").textContent = "正在加载 Python 运行环境…";
    PY = await loadPyodide({ indexURL: new URL("pyodide/", location.href).href });
    $("loadmsg").textContent = "正在加载图表引擎…";
    const buf = await (await fetch("py/pylib.zip?v=6")).arrayBuffer();
    PY.unpackArchive(buf, "zip", { extractDir: "/lib/tc" });
    PY.runPython("import sys; sys.path.insert(0, '/lib/tc'); import addin_api");
    API = PY.pyimport("addin_api");
    $("loading").classList.add("hide");
    if (END_STARTUP_BUSY) { END_STARTUP_BUSY(); END_STARTUP_BUSY = null; }
    render();
  } catch (e) {
    if (END_STARTUP_BUSY) { END_STARTUP_BUSY(); END_STARTUP_BUSY = null; }
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
async function pptxB64(name) { await ensurePptx(); const r = $("slideRatio") ? $("slideRatio").value : "16:9"; const [w, h] = r === "4:3" ? [10, 7.5] : [13.333, 7.5]; return API.render_pptx(JSON.stringify(LAST.spec), w, h, name || ""); }
function b64ToBlob(b64, type) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }

// ------------------------------------------------------------------ Office：PowerPoint
function svgForOffice(output) { return (output || LAST).svg; }
function setSelectedAsync(data, opts) {
  return TC.Office.fromAsyncResult((callback) => Office.context.document.setSelectedDataAsync(data, opts, callback), Office);
}
function pptRun(callback) { return TC.Office.runPowerPoint(window.PowerPoint, callback); }
function xlRun(callback) { return TC.Office.runExcel(window.Excel, callback); }
function requireCapability(name, message) {
  if (!OFFICE_CAPS[name]) { const error = new Error(message); error.code = "TC_OFFICE_UNSUPPORTED"; throw error; }
}
// ---- 文档内存储：v3 以稳定 chartId 为键；旧的形状名记录只读兼容，成功保存后增量迁移
function docSettings() { try { return Office.context.document.settings; } catch (e) { return null; } }
let DOC_STORE = null, DOC_STORE_SETTINGS = null;
function documentStore() {
  const settings = docSettings();
  if (!settings) return null;
  if (!DOC_STORE || DOC_STORE_SETTINGS !== settings) {
    DOC_STORE_SETTINGS = settings;
    DOC_STORE = TC.Store.create(settings, { state: TC.State, office: window.Office });
  }
  return DOC_STORE;
}
function getChartRecord(name, chartId) {
  const store = documentStore(); if (!store) return null;
  try {
    if (chartId) {
      const direct = store.load(chartId);
      if (direct) return direct;
    }
    const matches = store.classifyRecords().records
      .map((entry) => entry.record)
      .filter((record) => record && record.meta && record.meta.hostName === name)
      .sort((a, b) => b.revision - a.revision);
    return matches[0] || store.loadLegacy(name);
  } catch (e) { console.error("Invalid stored chart record", e); return null; }
}
function chartIndex() {
  const store = documentStore(); if (!store) return [];
  try {
    const classified = store.classifyRecords();
    const current = classified.records.map((entry) => entry.record && entry.record.meta && entry.record.meta.hostName).filter(Boolean);
    return [...new Set(current.concat(classified.legacyNames || []))];
  } catch (e) { console.error("Invalid chart index", e); return []; }
}
async function saveChartState(name, state) {
  const store = documentStore();
  if (!store) throw new Error("当前文档不支持保存图表状态");
  const existing = getChartRecord(name, state && state.chartId);
  const record = prepareChartRecord(state, existing, name);
  return store.save(record);
}
function prepareChartRecord(state, existing, hostName) {
  const record = TC.State.normalize(state, { mode: "write" });
  record.chartId = record.chartId || (existing && existing.chartId) || TC.State.createChartId();
  record.revision = Math.max(record.revision || 0, (existing && existing.revision) || 0) + 1;
  record.meta = Object.assign({}, (existing && existing.meta) || {}, record.meta || {});
  if (hostName) record.meta.hostName = hostName;
  if (existing && !existing.chartId && hostName) record.meta.legacyKey = hostName;
  return record;
}
function operationToken() { return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
async function runChartOperation(record, kind, operation) {
  const store = documentStore(); if (!store) throw new Error("当前文档不支持保存图表状态");
  const token = operationToken();
  await store.beginPending({ chartId: record.chartId, revision: record.revision, kind, token });
  try {
    const result = await operation(token);
    await store.clearPending(record.chartId);
    return result;
  } catch (error) {
    if (!error.persisted) {
      try { await store.clearPending(record.chartId); } catch (clearError) { error.pendingClearError = clearError; }
    }
    throw error;
  }
}
function flattenChartRecord(record) {
  if (!record || !record.chart) return null;
  const flat = Object.assign({}, record.chart);
  if (record.link) flat.link = typeof record.link === "string" ? record.link : (record.link.address || record.link.lastAddress || null);
  flat.sheet = (record.link && record.link.sheet) || (record.meta && record.meta.sheet) || null;
  return flat;
}
function getChartState(name, chartId) {
  return flattenChartRecord(getChartRecord(name, chartId));
}
function newChartName(chartId) { return chartId ? PREFIX + chartId : PREFIX + TC.State.createChartId(); }
function fitBox(frame, W, H) {
  let w = frame.width, h = w * H / W;
  if (h > frame.height) { h = frame.height; w = h * W / H; }
  return { left: frame.left + (frame.width - w) / 2, top: frame.top + (frame.height - h) / 2, width: w, height: h };
}
async function pptInsertAt(box, output) {
  const chart = output || TC.Office.captureChartOutput(LAST);
  const opts = { imageLeft: box.left, imageTop: box.top, imageWidth: box.width, imageHeight: box.height };
  if (OFFICE_CAPS.svgInsertion) {
    try {
      await setSelectedAsync(svgForOffice(chart), Object.assign({ coercionType: Office.CoercionType.XmlSvg }, opts));
      return true;
    } catch (e) { /* 当前主机可能声明支持但拒绝具体 SVG，继续回退 PNG */ }
  }
  const png = await svgToPngDataUrl(chart.svg, chart.width, chart.height, 3);
  await setSelectedAsync(png.split(",")[1], Object.assign({ coercionType: Office.CoercionType.Image }, opts));
  return false;
}
async function pptInsertionSnapshot() {
  return pptRun(async (ctx) => {
    const selectedSlides = ctx.presentation.getSelectedSlides();
    selectedSlides.load("items/id"); await ctx.sync();
    if (!selectedSlides.items.length) throw new Error("请先在左侧选中一张幻灯片");
    const slide = selectedSlides.items[0];
    slide.shapes.load("items/id");
    const selectedShapes = ctx.presentation.getSelectedShapes();
    selectedShapes.load("items/id,items/name,items/left,items/top,items/width,items/height");
    await ctx.sync();
    const prepared = { slideId: slide.id, beforeIds: new Set(slide.shapes.items.map((shape) => shape.id)), oldId: null, frame: null };
    if (selectedShapes.items.length !== 1 || String(selectedShapes.items[0].name).startsWith(PREFIX)) return prepared;
    const shape = selectedShapes.items[0];
    prepared.frame = { left: shape.left, top: shape.top, width: shape.width, height: shape.height };
    try {
      const textFrame = shape.textFrame;
      textFrame.load("hasText"); await ctx.sync();
      if (!textFrame.hasText) prepared.oldId = shape.id;
    } catch (e) { /* 图片等无文本框：保留原形状，仅借用位置 */ }
    return prepared;
  });
}
async function pptUpdateSnapshot(edit, output) {
  return pptRun(async (ctx) => {
    const slide = ctx.presentation.slides.getItem(edit.slideId);
    const old = slide.shapes.getItem(edit.id);
    old.load("left,top,width,height");
    slide.shapes.load("items/id"); await ctx.sync();
    return {
      slideId: edit.slideId,
      oldId: edit.id,
      beforeIds: new Set(slide.shapes.items.map((shape) => shape.id)),
      frame: { left: old.left, top: old.top, width: old.width, height: old.height },
      box: { left: old.left, top: old.top, width: old.width, height: old.width * output.height / output.width },
    };
  });
}
function pptReplacementAdapter(snapshot, name, record, token, output) {
  return {
    snapshot,
    async insert(prepared) {
      const box = prepared.box || (prepared.frame
        ? fitBox(prepared.frame, output.width, output.height)
        : { left: 40, top: 40, width: 640, height: 640 * output.height / output.width });
      prepared.box = box;
      prepared.svgOk = await pptInsertAt(box, output);
    },
    async identify(prepared) {
      return pptRun(async (ctx) => {
        const slide = ctx.presentation.slides.getItem(prepared.slideId);
        slide.shapes.load("items/id");
        let selected = null;
        let selectedSlides = null;
        if (OFFICE_CAPS.powerPointSelection) {
          selected = ctx.presentation.getSelectedShapes(); selected.load("items/id");
          selectedSlides = ctx.presentation.getSelectedSlides(); selectedSlides.load("items/id");
        }
        await ctx.sync();
        const selectedIds = TC.Office.selectedShapeIdsOnSlide(
          prepared.slideId,
          selectedSlides ? selectedSlides.items.map((item) => item.id) : [],
          selected ? selected.items.map((shape) => shape.id) : [],
        );
        const id = TC.Office.resolveInsertedShapeId(
          prepared.beforeIds,
          slide.shapes.items.map((shape) => shape.id),
          selectedIds,
        );
        return { id };
      });
    },
    async persist(prepared, pending) {
      record.meta = Object.assign({}, record.meta, { hostName: name, hostRef: `ppt:${prepared.slideId}:${pending.id}` });
      await documentStore().save(record);
    },
    async renameAndTag(prepared, pending) {
      await pptRun(async (ctx) => {
        const shape = ctx.presentation.slides.getItem(prepared.slideId).shapes.getItem(pending.id);
        shape.name = name;
        try {
          shape.tags.add("TCCHART", "3");
          shape.tags.add("TC_CHART_ID", record.chartId);
          shape.tags.add("TC_REVISION", String(record.revision));
        } catch (e) { /* 旧版本无 tags，名称仍可作为降级标识 */ }
        await ctx.sync();
      });
    },
    async deleteOld(prepared) {
      if (!prepared.oldId) return;
      await pptRun(async (ctx) => {
        ctx.presentation.slides.getItem(prepared.slideId).shapes.getItem(prepared.oldId).delete();
        await ctx.sync();
      });
    },
    async cleanupPending(prepared, pending) {
      await pptRun(async (ctx) => {
        const slide = ctx.presentation.slides.getItem(prepared.slideId);
        let id = pending && pending.id;
        if (!id) {
          slide.shapes.load("items/id"); await ctx.sync();
          id = TC.Office.resolveInsertedShapeId(prepared.beforeIds, slide.shapes.items.map((shape) => shape.id), []);
        }
        slide.shapes.getItem(id).delete(); await ctx.sync();
      });
    },
  };
}
async function pptInsertSvg() {
  const output = TC.Office.captureChartOutput(LAST);
  if (!OFFICE_CAPS.powerPointSelection || !OFFICE_CAPS.powerPointShapes) {
    const svgOk = await pptInsertAt({ left: 40, top: 40, width: 640, height: 640 * output.height / output.width }, output);
    return `已插入${svgOk ? "" : " PNG"}。当前 PowerPoint 版本不支持形状标记，因此本图不能从面板重新载入编辑`;
  }
  const record = prepareChartRecord(panelState(), null);
  const name = newChartName(record.chartId); record.meta.hostName = name;
  try {
    const result = await runChartOperation(record, "ppt-insert", (token) => TC.Office.replacePowerPointChart(
      pptReplacementAdapter(pptInsertionSnapshot, name, record, token, output),
    ));
    const prepared = result.prepared;
    const where = prepared.frame ? (prepared.oldId ? "已替换所选占位符" : "已放入所选形状的位置") : "已插入";
    return `${where}${prepared.svgOk ? "" : "（为图片，此版本不支持 SVG）"}。以后选中它可「载入编辑」`;
  } catch (error) {
    if (error.recoverableDuplicate) error.message += "；旧图与新图均保留，请确认新图后手动删除旧图";
    throw error;
  }
}
async function pptInsertSlide() {
  requireCapability("powerPointSlides", "当前 PowerPoint 版本不支持插入可编辑幻灯片");
  const record = prepareChartRecord(panelState(), null);
  const name = newChartName(record.chartId); record.meta.hostName = name;
  const b64 = await pptxB64(name);
  await pptRun(async (ctx) => {
    const opt = { formatting: "KeepSourceFormatting" };
    if (OFFICE_CAPS.powerPointSelection) {
      const sel = ctx.presentation.getSelectedSlides();
      sel.load("items/id");
      await ctx.sync();
      if (sel.items.length) opt.targetSlideId = sel.items[sel.items.length - 1].id;
    }
    ctx.presentation.insertSlidesFromBase64(b64, opt);
    await ctx.sync();
  });
  await documentStore().save(record);
  return "已作为新幻灯片插入（全部为可编辑形状）";
}
// ---- 选中图表 → 载入编辑 → 更新
async function pptSelectionChanged() {
  if (HOST !== "ppt" || !OFFICE_CAPS.powerPointSelection) { SEL_CHART = null; showBanner(); return; }
  try {
    await pptRun(async (ctx) => {
      const sel = ctx.presentation.getSelectedShapes();
      sel.load("items/id,items/name"); await ctx.sync();
      const sl = ctx.presentation.getSelectedSlides(); sl.load("items/id"); await ctx.sync();
      const x = sel.items.length === 1 ? sel.items[0] : null;
      let identity = null;
      if (x) {
        const tags = {};
        try {
          x.tags.load("items/key,items/value"); await ctx.sync();
          x.tags.items.forEach((tag) => { tags[tag.key] = tag.value; });
        } catch (e) { /* 名称降级 */ }
        identity = TC.Office.powerPointIdentity(tags, x.name);
      }
      const record = x ? getChartRecord(x.name, identity && identity.chartId) : null;
      SEL_CHART = x && record
        ? { id: x.id, name: x.name, chartId: record.chartId, revision: record.revision, slideId: sl.items[0] && sl.items[0].id,
          hostRef: `ppt:${sl.items[0] && sl.items[0].id}:${x.id}` } : null;
    });
  } catch (e) { SEL_CHART = null; }
  showBanner();
}
function showBanner() {
  const b = $("editBanner");
  const selectionMode = TC.Office.chartSelectionMode(EDIT, SEL_CHART);
  if (selectionMode === "editing") {
    b.classList.remove("hide"); b.classList.add("editing");
    $("editMsg").textContent = "正在编辑：" + (EDIT.title || "图表") + "（改完点「更新所选图表」）";
    $("btnLoadSel").textContent = "载入编辑";
    $("btnLoadSel").classList.add("hide"); $("btnNewChart").classList.remove("hide");
  } else if (selectionMode === "selected" || selectionMode === "switch") {
    const st = getChartState(SEL_CHART.name, SEL_CHART.chartId) || {};
    b.classList.remove("hide", "editing");
    $("editMsg").textContent = (selectionMode === "switch" ? "已选中另一张图表：" : "已选中图表：") + (st.title || "未命名");
    $("btnLoadSel").textContent = selectionMode === "switch" ? "切换编辑" : "载入编辑";
    $("btnLoadSel").classList.remove("hide"); $("btnNewChart").classList.add("hide");
  } else b.classList.add("hide");
  $("btnUpdate").classList.toggle("hide", !EDIT || HOST !== "ppt" || selectionMode === "switch");
  $("btnUpdateXl").classList.toggle("hide", !EDIT || HOST !== "xl");
}
async function loadSelectedChart() {
  if (!SEL_CHART) return;
  const forked = await ensureUniqueIdentityForEdit(SEL_CHART.hostRef);
  if (forked) Object.assign(SEL_CHART, { name: forked.name, chartId: forked.record.chartId, revision: forked.record.revision });
  const st = getChartState(SEL_CHART.name, SEL_CHART.chartId);
  if (!st) return;
  EDIT = Object.assign({}, SEL_CHART, { title: st.title });
  applyState(st); render(); showBanner();
  status("已载入所选图表的数据和设置", "ok");
}
function endEdit(restore) {
  EDIT = null;
  if (restore) loadState();
  showBanner(); render();
}
async function pptUpdate() {
  if (!EDIT) throw new Error("没有正在编辑的图表");
  requireCapability("powerPointSelection", "当前 PowerPoint 版本不支持原位编辑图表");
  const existing = getChartRecord(EDIT.name, EDIT.chartId);
  if (!existing) throw new Error("找不到该图表的文档状态");
  const record = prepareChartRecord(panelState(), existing, EDIT.name);
  const name = newChartName(record.chartId); record.meta.hostName = name;
  const output = TC.Office.captureChartOutput(LAST);
  const edit = Object.assign({}, EDIT);
  let result;
  try {
    result = await runChartOperation(record, "ppt-update", (token) => TC.Office.replacePowerPointChart(pptReplacementAdapter(
      () => pptUpdateSnapshot(edit, output), name, record, token, output,
    )));
  } catch (error) {
    if (error.recoverableDuplicate) error.message += "；旧图与新图均保留，请确认新图后手动删除旧图";
    throw error;
  }
  EDIT.id = result.pending.id; EDIT.name = name; EDIT.chartId = record.chartId; EDIT.revision = record.revision; EDIT.title = $("title").value;
  showBanner();
  return "已在原位置更新（宽度保持不变）";
}

// ------------------------------------------------------------------ Office：Excel
function xlPendingName() { return `TC_PENDING_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function xlSheet(ctx, name) { return name ? ctx.workbook.worksheets.getItem(name) : ctx.workbook.worksheets.getActiveWorksheet(); }
function xlConfigureImage(shape, prepared, out, pendingName, altText) {
  shape.lockAspectRatio = true;
  shape.left = prepared.left; shape.top = prepared.top; shape.width = prepared.width;
  shape.name = pendingName;
  try { shape.altTextDescription = altText; } catch (e) { /* 旧版主机仅保留名称标识 */ }
  try { shape.load("id"); } catch (e) { /* 旧版主机无稳定 shape id */ }
}
function xlReplacementAdapter(snapshot, name, out, record, token) {
  const pendingName = xlPendingName();
  let pngPromise = null;
  const pendingAlt = TC.Office.encodeExcelIdentity({ chartId: record.chartId, revision: record.revision, pendingToken: token, title: record.chart.title || "" });
  const finalAlt = TC.Office.encodeExcelIdentity({ chartId: record.chartId, revision: record.revision, title: record.chart.title || "" });
  return {
    snapshot,
    async insertSvg(prepared) {
      if (!OFFICE_CAPS.excelSvg) throw new Error("当前 Excel 版本不支持 SVG 形状");
      return xlRun(async (ctx) => {
        const sh = xlSheet(ctx, prepared.sheet);
        if (!sh.shapes || typeof sh.shapes.addSvg !== "function") throw new Error("当前 Excel 主机未提供 addSvg");
        const shape = sh.shapes.addSvg(out.svg);
        xlConfigureImage(shape, prepared, out, pendingName, pendingAlt);
        await ctx.sync();
        return { name: pendingName, id: shape.id || pendingName };
      });
    },
    async cleanupFailedSvg(prepared) {
      await xlRun(async (ctx) => {
        const sh = xlSheet(ctx, prepared.sheet);
        sh.shapes.load("items/name"); await ctx.sync();
        const shape = sh.shapes.items.find((item) => item.name === pendingName);
        if (shape) { shape.delete(); await ctx.sync(); }
      });
    },
    async insertPng(prepared) {
      if (!pngPromise) pngPromise = svgToPngDataUrl(out.svg, out.width, out.height, 3);
      const png = await pngPromise;
      return xlRun(async (ctx) => {
        const sh = xlSheet(ctx, prepared.sheet);
        const shape = sh.shapes.addImage(png.split(",")[1]);
        xlConfigureImage(shape, prepared, out, pendingName, pendingAlt);
        await ctx.sync();
        return { name: pendingName, id: shape.id || pendingName };
      });
    },
    async persist(prepared, pending) {
      if (record.link) record.link = await xlEnsureNamedLink(record);
      record.meta = Object.assign({}, record.meta, { sheet: prepared.sheet, hostName: name, hostRef: `xl:${prepared.sheet}:${pending.id}` });
      await documentStore().save(record);
    },
    async rename(prepared, pending) {
      await xlRun(async (ctx) => {
        const sh = xlSheet(ctx, prepared.sheet);
        if (prepared.oldName) {
          const old = sh.shapes.getItem(prepared.oldName);
          old.name = prepared.backupName;
        }
        const inserted = sh.shapes.getItem(pending.name);
        inserted.name = name;
        try { inserted.altTextDescription = finalAlt; } catch (e) { /* 名称降级 */ }
        await ctx.sync();
      });
    },
    async deleteOld(prepared) {
      if (!prepared.oldName) return;
      await xlRun(async (ctx) => {
        xlSheet(ctx, prepared.sheet).shapes.getItem(prepared.backupName).delete();
        await ctx.sync();
      });
    },
    async cleanupPending(prepared, pending) {
      await xlRun(async (ctx) => {
        const sh = xlSheet(ctx, prepared.sheet);
        sh.shapes.load("items/name"); await ctx.sync();
        const targetName = pending && pending.name ? pending.name : pendingName;
        const shape = sh.shapes.items.find((item) => item.name === targetName);
        if (shape) { shape.delete(); await ctx.sync(); }
      });
    },
  };
}
async function xlNewSnapshot() {
  return xlRun(async (ctx) => {
    const sh = ctx.workbook.worksheets.getActiveWorksheet(); sh.load("name");
    const range = ctx.workbook.getSelectedRange(); range.load("left,top,width");
    await ctx.sync();
    return { sheet: sh.name, oldName: null, left: range.left + range.width + 12, top: range.top, width: 560 };
  });
}
async function xlExistingSnapshot(name, sheet) {
  return xlRun(async (ctx) => {
    const sh = xlSheet(ctx, sheet); sh.load("name");
    const old = sh.shapes.getItem(name); old.load("left,top,width"); await ctx.sync();
    return {
      sheet: sh.name, oldName: name, backupName: `${xlPendingName()}_OLD`,
      left: old.left, top: old.top, width: old.width,
    };
  });
}
async function xlRunReplacement(adapter) {
  try { return await TC.Office.replaceExcelChart(adapter); }
  catch (error) {
    if (error.recoverableDuplicate) error.message += "；旧图与新图均保留，请确认新图后手动删除旧图";
    throw error;
  }
}
async function xlInsertSvg() {
  const state = panelState(); if (SEL_ADDRESS) state.link = SEL_ADDRESS;
  const record = prepareChartRecord(state, null);
  const name = newChartName(record.chartId); record.meta.hostName = name;
  const result = await runChartOperation(record, "xl-insert", (token) => xlRunReplacement(
    xlReplacementAdapter(xlNewSnapshot, name, LAST, record, token),
  ));
  await xlRefreshList(name);
  const fallback = result.format === "png" ? "（SVG 不可用，已回退为 PNG）" : "";
  return state.link
    ? `已插入${fallback}，并与 ${state.link} 链接：改这些单元格，图会自动更新`
    : `已插入到选区右侧${fallback}。想让图跟着单元格变：先“读取选区”或“数据写入单元格”再插入`;
}
// 按形状名事务式替换图片（位置、宽度不变）
async function xlReplaceShape(name, out, sheet, state, chartId, linkRecord) {
  const existing = getChartRecord(name, chartId);
  if (!existing) throw new Error("找不到该图表的文档状态");
  const record = prepareChartRecord(state, existing, name);
  if (linkRecord !== undefined) record.link = linkRecord;
  const finalName = newChartName(record.chartId); record.meta.hostName = finalName;
  const result = await runChartOperation(record, "xl-update", (token) => xlRunReplacement(
    xlReplacementAdapter(() => xlExistingSnapshot(name, sheet), finalName, out, record, token),
  ));
  return { result, record, name: finalName };
}
// ---- 单元格 ↔ 图表 链接
function splitAddr(a) {
  return TC.Link.splitAddress(a);
}
function colNum(l) { let n = 0; for (const ch of l.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
function a1Rect(r) {
  const parts = String(r).replace(/\$/g, "").split(":");
  const one = (x) => { const m = x.match(/^([A-Za-z]*)(\d*)$/) || ["", "", ""]; return { c: m[1] ? colNum(m[1]) : null, r: m[2] ? Number(m[2]) : null }; };
  const p = one(parts[0]), q = one(parts[1] || parts[0]);
  return { c0: p.c ?? 1, r0: p.r ?? 1, c1: q.c ?? 1e6, r1: q.r ?? 1e7 };
}
function intersects(a, b) { return a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1; }
function rangeText(values, numberFormat) {
  return values.map((row, i) => row.map((v, j) => {
    const nf = String(((numberFormat || [])[i] || [])[j] || "");
    if (typeof v === "number" && /[yd]/i.test(nf) && !/%/.test(nf) && v > 20000) return excelDate(v);
    if (typeof v === "number" && /%/.test(nf)) return +(v * 100).toFixed(6) + "%";
    return v;
  }).join("\t")).join("\n");
}
async function xlReadRange(address) {
  let txt = "";
  await xlRun(async (ctx) => {
    const a = splitAddr(address);
    const ws = a.sheet ? ctx.workbook.worksheets.getItem(a.sheet) : ctx.workbook.worksheets.getActiveWorksheet();
    const r = ws.getRange(a.range); r.load("values,numberFormat"); await ctx.sync();
    txt = rangeText(r.values, r.numberFormat);
  });
  return txt;
}
async function xlResolveLink(link) {
  return TC.Link.resolve(link, (name) => xlRun(async (ctx) => {
    const item = ctx.workbook.names.getItem(name);
    item.load("formula");
    const range = item.getRange();
    range.load("address");
    range.worksheet.load("id,name");
    await ctx.sync();
    return { formula: item.formula, address: range.address, worksheetId: range.worksheet.id, sheet: range.worksheet.name };
  }));
}
async function xlSetNamedLink(chartId, address) {
  const name = TC.Link.definedName(chartId);
  return xlRun(async (ctx) => {
    const parsed = splitAddr(address);
    const sheet = parsed.sheet ? ctx.workbook.worksheets.getItem(parsed.sheet) : ctx.workbook.worksheets.getActiveWorksheet();
    sheet.load("id,name");
    const range = sheet.getRange(parsed.range); range.load("address");
    const existing = ctx.workbook.names.getItemOrNullObject(name); existing.load("name");
    await ctx.sync();
    if (existing.isNullObject) ctx.workbook.names.add(name, range, "think-cell 风格图表数据链接");
    else existing.formula = "=" + range.address;
    await ctx.sync();
    return TC.Link.createRecord(chartId, { worksheetId: sheet.id, sheet: sheet.name, address: range.address });
  });
}
async function xlEnsureNamedLink(record) {
  if (!record.link) return null;
  if (record.link.kind === "workbook-name") {
    const resolved = await xlResolveLink(record.link);
    if (resolved.status === "broken") {
      const error = new Error("Excel 链接已失效；现有图表和最后一次数据已保留");
      error.code = resolved.error && resolved.error.code;
      error.link = resolved;
      throw error;
    }
    return resolved;
  }
  const address = typeof record.link === "string" ? record.link : (record.link.address || record.link.lastAddress);
  if (!address) throw new Error("Excel 链接缺少单元格地址");
  return xlSetNamedLink(record.chartId, address);
}
function gridValues(grid, plain) {
  const vals = grid.map((r, i) => r.map((c, j) => {
    const v = num(c);
    if (j === 0 && i > 0 && typeof v === "number") return plain ? v : "'" + c;   // 类目列保持文本
    return i === 0 || j === 0 || v === null || Number.isNaN(v) || v === "e" || /^\d{4}-\d{1,2}(-\d{1,2})?$/.test(String(c).trim()) ? c : v;
  }));
  const w = Math.max(...vals.map((r) => r.length));
  vals.forEach((r) => { while (r.length < w) r.push(""); });
  return vals;
}
const LINK_ECHOES = TC.Link.createEchoTracker({ ttl: 10000 });
const LINK_REFRESHES = TC.Link.createRefreshQueue({
  delay: 600,
  run: (chartId, payload) => refreshLinked(payload.name, chartId),
  onError: (error) => status("链接图表更新失败：" + (error.message || error), "bad"),
});
// 把面板数据写到 Excel（from = 链接地址，或省略 = 当前选中单元格左上角），返回带表名的新地址
async function xlWriteGrid(grid, from, echo) {
  let addr = "";
  const vals = gridValues(grid, !!from);   // 写回已链接区域：类目列数字保持数字
  await xlRun(async (ctx) => {
    let tl;
    if (from) { const a = splitAddr(from); const ws = a.sheet ? ctx.workbook.worksheets.getItem(a.sheet) : ctx.workbook.worksheets.getActiveWorksheet(); tl = ws.getRange(a.range).getCell(0, 0); }
    else tl = ctx.workbook.getSelectedRange().getCell(0, 0);
    const rng = tl.getResizedRange(vals.length - 1, vals[0].length - 1);
    rng.load("address"); rng.worksheet.load("id"); await ctx.sync();
    if (echo && echo.chartId) LINK_ECHOES.expect({ chartId: echo.chartId, worksheetId: rng.worksheet.id, address: rng.address, values: vals });
    rng.values = vals; await ctx.sync();
    addr = rng.address;
  });
  return addr;
}
async function xlWriteSelection() {
  const g = parseGrid($("data").value);
  if (g.length < 2) throw new Error("面板里还没有数据");
  SEL_ADDRESS = await xlWriteGrid(g);
  return `已写入 ${SEL_ADDRESS}。现在点「插入图表（高保真）」，图会和这些单元格链接`;
}
async function xlChangedLinks(records, ev) {
  return xlRun(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(ev.worksheetId); sheet.load("name");
    const changed = sheet.getRange(ev.address); changed.load("address,values");
    const named = records.filter((entry) => entry.record.link && entry.record.link.kind === "workbook-name").map((entry) => {
      const item = ctx.workbook.names.getItemOrNullObject(entry.record.link.name); item.load("name,formula");
      return Object.assign({ item }, entry);
    });
    await ctx.sync();

    named.forEach((entry) => {
      if (entry.item.isNullObject) return;
      entry.range = entry.item.getRangeOrNullObject(); entry.range.load("address");
    });
    await ctx.sync();
    named.forEach((entry) => {
      if (!entry.range || entry.range.isNullObject) return;
      entry.range.worksheet.load("id,name");
    });
    await ctx.sync();
    named.forEach((entry) => {
      if (!entry.range || entry.range.isNullObject || entry.range.worksheet.id !== ev.worksheetId) return;
      entry.intersection = entry.range.getIntersectionOrNullObject(changed); entry.intersection.load("address");
    });
    await ctx.sync();

    const matches = [], broken = [];
    named.forEach((entry) => {
      if (entry.item.isNullObject || !entry.range || entry.range.isNullObject || /#REF!/i.test(String(entry.item.formula || ""))) {
        const link = Object.assign({}, entry.record.link, { status: "broken", error: { code: "TC_LINK_REF", message: "Excel 定义名称已失效。" } });
        broken.push({ name: entry.name, record: Object.assign({}, entry.record, { link }) });
        return;
      }
      const link = TC.Link.createRecord(entry.record.chartId, {
        worksheetId: entry.range.worksheet.id, sheet: entry.range.worksheet.name, address: entry.range.address,
      });
      if (entry.intersection && !entry.intersection.isNullObject) matches.push({ name: entry.name, record: entry.record, link });
    });
    records.filter((entry) => !entry.record.link || entry.record.link.kind !== "workbook-name").forEach((entry) => {
      const link = entry.record.link;
      const address = typeof link === "string" ? link : (link && (link.address || link.lastAddress));
      if (!address) return;
      const parsed = splitAddr(address);
      if ((parsed.sheet || sheet.name) === sheet.name && intersects(a1Rect(parsed.range), a1Rect(ev.address))) matches.push({ name: entry.name, record: entry.record, link });
    });
    return { matches, broken, worksheetId: ev.worksheetId, address: changed.address, values: changed.values };
  });
}
async function onXlChanged(ev) {
  const records = chartIndex().map((name) => ({ name, record: getChartRecord(name) })).filter((entry) => entry.record && entry.record.link);
  if (!records.length) return;
  let changed;
  try { changed = await xlChangedLinks(records, ev); } catch (e) { status("无法检查 Excel 链接变化：" + (e.message || e), "bad"); return; }
  for (const entry of changed.broken) {
    try { await documentStore().save(entry.record); } catch (e) { /* 保留原记录，稍后由维护工具处理 */ }
  }
  if (changed.broken.length) status("检测到失效的 Excel 链接；现有图表已保留", "bad");
  changed.matches.forEach((entry) => {
    const chartId = entry.record.chartId || entry.name;
    const echo = { chartId, worksheetId: changed.worksheetId, address: changed.address, values: changed.values };
    if (!LINK_ECHOES.consume(echo)) LINK_REFRESHES.schedule(chartId, { name: entry.name, revision: entry.record.revision });
  });
}
async function refreshLinked(name, chartId) {
  const stored = getChartRecord(name, chartId);
  if (!stored || !stored.link || !API) return;
  name = (stored.meta && stored.meta.hostName) || name;
  try {
    const link = await xlResolveLink(stored.link);
    if (!link || link.status === "broken") {
      stored.link = link;
      await documentStore().save(stored);
      status("Excel 链接已失效；已保留现有图表和最后一次数据", "bad");
      return;
    }
    const linkedRecord = Object.assign({}, stored, { link });
    const st = flattenChartRecord(linkedRecord);
    st.data = await xlReadRange(link.lastAddress);
    const out = renderState(st);
    const replacement = await xlReplaceShape(name, out, st.sheet, st, stored.chartId, link);
    if (EDIT && (EDIT.chartId === replacement.record.chartId || EDIT.name === name)) {
      EDIT.name = replacement.name; EDIT.chartId = replacement.record.chartId; EDIT.revision = replacement.record.revision;
      setData(st.data, true); SEL_ADDRESS = link.lastAddress; renderOpts(); render();
    }
    status(`已按单元格数据自动更新：${st.title || "图表"}`, "ok");
  } catch (e) { status("链接图表更新失败：" + (e.message || e), "bad"); }
}
async function xlWatch() {
  let collectionError = null;
  if (OFFICE_CAPS.excelCollectionEvents) {
    try {
      await xlRun(async (ctx) => { ctx.workbook.worksheets.onChanged.add(onXlChanged); await ctx.sync(); });
      return;
    } catch (error) { collectionError = error; }
  }
  if (OFFICE_CAPS.excelWorksheetEvents) {
    await xlRun(async (ctx) => {
      const wss = ctx.workbook.worksheets; wss.load("items"); await ctx.sync();
      wss.items.forEach((ws) => ws.onChanged.add(onXlChanged)); await ctx.sync();
    });
    return;
  }
  if (collectionError) throw collectionError;
  status("当前 Excel 版本不支持自动监听单元格变化；可用“更新所选图表”手动刷新", "bad");
}
async function xlRefreshList(selectName) {
  if (HOST !== "xl") return;
  try {
    await xlRun(async (ctx) => {
      const sh = ctx.workbook.worksheets.getActiveWorksheet(); sh.load("id,name");
      sh.shapes.load("items/id,items/name,items/altTextDescription"); await ctx.sync();
      const items = sh.shapes.items.map((shape) => {
        const identity = TC.Office.parseExcelIdentity(shape.altTextDescription);
        const record = getChartRecord(shape.name, identity && identity.chartId);
        return { shape, identity, record };
      }).filter((item) => item.record && (item.identity || String(item.shape.name).startsWith(PREFIX)));
      const cur = selectName !== undefined ? selectName : $("xlCharts").value;
      $("xlCharts").innerHTML = '<option value="">（新建）</option>' + items.map((item) => {
        const st = flattenChartRecord(item.record) || {};
        const hostRef = `xl:${sh.name}:${item.shape.id}`;
        return `<option value="${esc(item.shape.name)}" data-chart-id="${esc(item.record.chartId || "")}" data-host-ref="${esc(hostRef)}">${st.link ? "🔗 " : ""}${esc(st.title || item.shape.name)}</option>`;
      }).join("");
      if ([...$("xlCharts").options].some((o) => o.value === cur)) $("xlCharts").value = cur;
    });
  } catch (e) { /* 忽略 */ }
}
async function xlPick(name, chartId, hostRef) {
  if (!name) { if (EDIT) endEdit(true); return; }
  const forked = await ensureUniqueIdentityForEdit(hostRef);
  if (forked) { name = forked.name; chartId = forked.record.chartId; await xlRefreshList(name); }
  const record = getChartRecord(name, chartId);
  const st = flattenChartRecord(record); if (!st) return;
  EDIT = { name, chartId: record.chartId, revision: record.revision, title: st.title };
  applyState(st); render(); showBanner();
}
async function xlUpdate() {
  if (!EDIT) throw new Error("没有正在编辑的图表");
  const previousRecord = getChartRecord(EDIT.name, EDIT.chartId);
  if (!previousRecord) throw new Error("找不到该图表的文档状态");
  const prev = flattenChartRecord(previousRecord) || {};
  const st = panelState(); st.sheet = prev.sheet;
  let link = previousRecord.link;
  let note = "";
  if (link) {
    const resolved = await xlResolveLink(link);
    if (resolved.status === "broken") throw new Error("Excel 链接已失效；请重新选择数据区域后再更新");
    link = resolved; st.link = link;
    if (parseGrid(st.data).join("\n") !== parseGrid(prev.data || "").join("\n")) {   // 面板里改了数据 → 写回链接的单元格
      const address = await xlWriteGrid(parseGrid(st.data), link.lastAddress, { chartId: previousRecord.chartId });
      link = await xlSetNamedLink(previousRecord.chartId, address);
      st.link = link;
      note = `，数据已写回 ${link.lastAddress}`;
    }
  } else if (SEL_ADDRESS) { st.link = SEL_ADDRESS; link = undefined; }
  const replacement = await xlReplaceShape(EDIT.name, LAST, st.sheet, st, EDIT.chartId, link);
  EDIT.name = replacement.name; EDIT.chartId = replacement.record.chartId; EDIT.revision = replacement.record.revision;
  EDIT.title = $("title").value; showBanner(); xlRefreshList(EDIT.name);
  return "已在原位置更新" + note;
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
  await xlRun(async (ctx) => {
    let sh, rng;
    if (SEL_ADDRESS) {
      const address = splitAddr(SEL_ADDRESS);
      sh = address.sheet ? ctx.workbook.worksheets.getItem(address.sheet) : ctx.workbook.worksheets.getActiveWorksheet();
      rng = sh.getRange(address.range);
    }
    else {  // 数据是粘贴进来的：先写到选中单元格处
      sh = ctx.workbook.worksheets.getActiveWorksheet();
      const sel = ctx.workbook.getSelectedRange(); sel.load("address"); await ctx.sync();
      const tl = sel.getCell(0, 0);
      const vals = gridValues(grid), w = vals[0].length;
      rng = tl.getResizedRange(vals.length - 1, w - 1);
      rng.values = vals;
    }
    const ch = sh.charts.add(kind, rng, "Columns");
    ch.title.text = LAST.spec.title || "";
    ch.title.format.font.size = 13; ch.title.format.font.bold = true;
    try { ch.axes.valueAxis.majorGridlines.visible = false; } catch (e) { /* 部分类型无数值轴 */ }
    ch.dataLabels.showValue = true;
    const pal = TC.Office.resolvePalette(LAST.spec.theme || "consulting");
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
  await xlRun(async (ctx) => {
    const r = ctx.workbook.getSelectedRange(); r.load("values,numberFormat,address"); await ctx.sync();
    setData(rangeText(r.values, r.numberFormat));
    SEL_ADDRESS = r.address;
  });
  renderOpts(); schedule();
  return "已读取选区 " + (SEL_ADDRESS || "");
}

// ------------------------------------------------------------------ 文档诊断与显式恢复
let MAINTENANCE = null;
async function scanHostShapes() {
  if (HOST === "xl") {
    return xlRun(async (ctx) => {
      const sheets = ctx.workbook.worksheets; sheets.load("items/id,items/name"); await ctx.sync();
      sheets.items.forEach((sheet) => sheet.shapes.load("items/id,items/name,items/altTextDescription"));
      await ctx.sync();
      const shapes = [];
      sheets.items.forEach((sheet) => sheet.shapes.items.forEach((shape) => {
        const identity = TC.Office.parseExcelIdentity(shape.altTextDescription);
        shapes.push({
          hostRef: `xl:${sheet.name}:${shape.id}`, host: "xl", sheetName: sheet.name, sheetId: sheet.id,
          shapeId: shape.id, name: shape.name, chartId: identity && identity.chartId,
          revision: identity ? identity.revision : 0, pendingToken: identity && identity.pendingToken,
        });
      }));
      return shapes;
    });
  }
  if (HOST === "ppt") {
    return pptRun(async (ctx) => {
      const slides = ctx.presentation.slides; slides.load("items/id"); await ctx.sync();
      slides.items.forEach((slide) => slide.shapes.load("items/id,items/name")); await ctx.sync();
      if (OFFICE_CAPS.powerPointShapeMetadata) {
        slides.items.forEach((slide) => slide.shapes.items.forEach((shape) => shape.tags.load("items/key,items/value")));
        await ctx.sync();
      }
      const shapes = [];
      slides.items.forEach((slide) => slide.shapes.items.forEach((shape) => {
        const tags = {};
        if (OFFICE_CAPS.powerPointShapeMetadata) shape.tags.items.forEach((tag) => { tags[tag.key] = tag.value; });
        const identity = TC.Office.powerPointIdentity(tags, shape.name);
        shapes.push({
          hostRef: `ppt:${slide.id}:${shape.id}`, host: "ppt", slideId: slide.id, shapeId: shape.id,
          name: shape.name, chartId: identity && identity.chartId,
          revision: identity ? identity.revision : 0, pendingToken: identity && identity.pendingToken,
        });
      }));
      return shapes;
    });
  }
  return [];
}
function maintenanceIssue(text, action, label, data) {
  const button = action ? `<button class="ghost" data-maint="${action}" ${data || ""}>${label}</button>` : "";
  return `<div class="issue">${text}${button}</div>`;
}
function renderMaintenance(report) {
  const total = report.pending.length + report.forks.length + report.duplicates.length + report.orphans.length
    + report.untracked.length + report.brokenLinks.length + report.legacyKeys.length;
  $("docHealthSummary").textContent = total
    ? `发现 ${total} 项需留意的状态；所有恢复操作都保留现有图表。`
    : "文档状态正常，未发现待恢复操作、重复标识或断链。";
  const issues = [];
  report.pending.forEach((item) => issues.push(maintenanceIssue(
    `有一项未完成操作 <code>${esc(item.chartId)}</code><br>`, "recover", "确认已保存并结束恢复", `data-id="${esc(item.chartId)}"`,
  )));
  report.forks.forEach((item, index) => issues.push(maintenanceIssue(
    `发现可安全拆分的图表副本 <code>${esc(item.shape.hostRef)}</code><br>`, "fork", "将副本设为独立图表", `data-index="${index}"`,
  )));
  report.duplicates.forEach((item) => issues.push(maintenanceIssue(
    `图表标识存在无法自动判断的重复项 <code>${esc(item.chartId)}</code>；请先确认要保留的副本。`, null,
  )));
  report.brokenLinks.forEach((item) => issues.push(maintenanceIssue(
    `Excel 数据链接已失效 <code>${esc(item.chartId)}</code><br>`, HOST === "xl" ? "relink" : null, "链接到当前选区", `data-id="${esc(item.chartId)}"`,
  )));
  report.orphans.forEach((item) => issues.push(maintenanceIssue(
    `存在没有对应形状的图表状态 <code>${esc(item.chartId)}</code><br>`, "inspect", "查看信息", `data-id="${esc(item.chartId)}"`,
  )));
  if (report.untracked.length) issues.push(maintenanceIssue(`发现 ${report.untracked.length} 个没有可用状态的 TC: 形状；未作修改。`, null));
  if (report.legacyKeys.length) issues.push(maintenanceIssue(`仍保留 ${report.legacyKeys.length} 个旧版状态键；仅兼容读取，不会自动删除。`, null));
  $("docIssues").innerHTML = issues.join("") || '<div class="issue">无需处理。</div>';
  $("btnCopyDiag").disabled = false;
}
async function checkDocumentMaintenance() {
  const store = documentStore();
  if (!store) throw new Error("当前文档不支持状态检查");
  const classified = store.classifyRecords();
  const records = classified.records.map((entry) => entry.record).filter(Boolean);
  const shapes = await scanHostShapes();
  const report = TC.Store.maintenanceReport({ records, shapes, pending: classified.pending, legacyNames: classified.legacyNames });
  MAINTENANCE = { report, records, shapes };
  renderMaintenance(report);
  return report;
}
async function recoverMaintenancePending(chartId) {
  await documentStore().recoverPending(chartId);
  await checkDocumentMaintenance();
  return "已确认持久化状态并清除未完成标记；未删除任何图表";
}
async function relinkMaintenanceChart(chartId) {
  if (HOST !== "xl") throw new Error("重新链接只适用于 Excel");
  let address = "";
  await xlRun(async (ctx) => { const range = ctx.workbook.getSelectedRange(); range.load("address"); await ctx.sync(); address = range.address; });
  const record = documentStore().load(chartId);
  if (!record) throw new Error("找不到待重新链接的图表状态");
  record.link = await xlSetNamedLink(chartId, address);
  await documentStore().save(record);
  if (record.meta && record.meta.hostName) await refreshLinked(record.meta.hostName, chartId);
  await checkDocumentMaintenance();
  return `已重新链接到 ${record.link.lastAddress}`;
}
async function forkReconciledShape(item, refreshMaintenance) {
  const record = item.forkRecord, shape = item.shape;
  const finalName = newChartName(record.chartId);
  record.meta = Object.assign({}, record.meta, { hostName: finalName, hostRef: shape.hostRef });
  await documentStore().save(record);
  if (HOST === "xl") {
    await xlRun(async (ctx) => {
      const target = ctx.workbook.worksheets.getItem(shape.sheetName).shapes.getItem(shape.name);
      target.name = finalName;
      try { target.altTextDescription = TC.Office.encodeExcelIdentity({ chartId: record.chartId, revision: record.revision, title: record.chart.title || "" }); } catch (e) { /* 名称仍可识别 */ }
      await ctx.sync();
    });
  } else if (HOST === "ppt") {
    await pptRun(async (ctx) => {
      const target = ctx.presentation.slides.getItem(shape.slideId).shapes.getItem(shape.shapeId);
      target.name = finalName;
      try { target.tags.add("TCCHART", "3"); target.tags.add("TC_CHART_ID", record.chartId); target.tags.add("TC_REVISION", String(record.revision)); } catch (e) { /* 名称仍可识别 */ }
      await ctx.sync();
    });
  }
  if (refreshMaintenance) await checkDocumentMaintenance();
  return { record, name: finalName };
}
async function ensureUniqueIdentityForEdit(hostRef) {
  if (!hostRef) return null;
  const store = documentStore(); if (!store) return null;
  const classified = store.classifyRecords();
  const records = classified.records.map((entry) => entry.record).filter(Boolean);
  const shapes = await scanHostShapes();
  const report = TC.Store.maintenanceReport({ records, shapes, pending: classified.pending, legacyNames: classified.legacyNames });
  const disposition = TC.Store.editDisposition(report, hostRef);
  if (disposition.action === "ambiguous") throw new Error("该图表与多个副本共用标识，无法判断原件；请在“文档状态与恢复”中检查");
  if (disposition.action !== "fork") return null;
  const forked = await forkReconciledShape(disposition.item, false);
  status("检测到复制的图表，已为该副本分配独立标识", "ok");
  return forked;
}
async function forkMaintenanceShape(index) {
  if (!MAINTENANCE || !MAINTENANCE.report.forks[index]) throw new Error("该副本状态已变化，请重新检查文档");
  await forkReconciledShape(MAINTENANCE.report.forks[index], true);
  return "已将复制的形状设为独立图表；原图和副本均保留";
}
function maintenanceDiagnostic() {
  if (!MAINTENANCE) throw new Error("请先检查文档");
  return TC.Store.diagnosticSummary({
    addinVersion: "1.0.5.0", engineVersion: "1", host: HOST, capabilities: OFFICE_CAPS, report: MAINTENANCE.report,
  });
}

// ------------------------------------------------------------------ 状态保存
function panelState() {
  return { v: 2, type: $("type").value, data: $("data").value, title: $("title").value, subtitle: $("subtitle").value,
    source: $("source").value, theme: $("theme").value, dec: $("dec").value, size: $("size").value, legend: $("legend").value,
    legendRev: $("legendRev").checked, mag: $("mag").value, opt: OPT, ann: ANN, colors: COLORS,
    json: $("jsonLock").checked ? $("json").value : null, sel: SEL_ADDRESS };
}
function saveState() { if (!EDIT) store.set("state", TC.State.normalize(panelState(), { mode: "write" })); }
function applyState(s) {
  let record;
  try { record = TC.State.normalize(s, { mode: "read" }); }
  catch (e) { return false; }
  s = record.chart;
  if (!s || !T[s.type]) return false;
  $("type").value = s.type;
  ["title", "subtitle", "source", "theme", "dec", "size", "legend", "mag"].forEach((k) => { if (s[k] !== undefined && s[k] !== null) $(k).value = s[k]; });
  $("legendRev").checked = !!s.legendRev;
  OPT = s.opt || {}; ANN = s.ann || {}; COLORS = s.colors || {};
  setData(parseGrid(s.data || "").length > 1 ? s.data : T[s.type].sample);
  SEL_ADDRESS = s.sel || null;
  $("jsonLock").checked = !!s.json;
  if (s.json) $("json").value = s.json;
  COLOR_KEY = ""; renderThemeEditor(); renderOpts();
  return true;
}
function loadState() { return applyState(store.get("state", null)); }

// ------------------------------------------------------------------ 启动
const act = (fn, needChart = true) => async () => {
  if (needChart && !chartReady()) return;
  const endBusy = UI_BUSY.begin(); status("处理中…");
  try { const msg = await fn(); status(msg || "完成", "ok"); }
  catch (e) { status("失败：" + (e.message || e.code || e), "bad"); console.error(e); }
  finally { endBusy(); }
};
function wire() {
  $("type").innerHTML = TYPES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  gridWire(); colorsWire(); themeWire();
  if (!loadState()) { $("type").value = "column"; setData(T.column.sample); $("title").value = DEMO_TITLE; $("subtitle").value = "全球市场规模，亿美元"; ANN = { cagr0: "0", cagr1: "4" }; }
  $("type").addEventListener("change", () => {
    OPT = {}; ANN = {}; SEL_ADDRESS = null;
    const cur = parseGrid($("data").value);
    let fits = cur.length > 1 && !TYPES.some((t) => t.sample === $("data").value);
    if (fits) { try { T[$("type").value].build(cur.slice(1), cur[0], {}); } catch (e) { fits = false; } }
    if (!fits) {   // 现有数据不适合新类型 → 换成该类型的示例
      setData(T[$("type").value].sample);
      if ($("title").value === DEMO_TITLE) { $("title").value = ""; $("subtitle").value = ""; }
    }
    COLORS = {};
    renderOpts(); schedule();
  });
  $("data").addEventListener("paste", (e) => { const t = (e.clipboardData || window.clipboardData).getData("text"); if (pasteChart(t)) e.preventDefault(); });
  $("data").addEventListener("input", () => { GRID = padGrid(parseGrid($("data").value)); SEL_ADDRESS = null; onDataChanged(); });
  ["title", "subtitle", "source"].forEach((k) => $(k).addEventListener("input", schedule));
  ["dec", "size", "legend", "mag", "legendRev"].forEach((k) => $(k).addEventListener("change", schedule));
  $("theme").addEventListener("change", () => { COLOR_KEY = ""; renderThemeEditor(); schedule(); });
  $("btnSample").onclick = () => { setData(T[$("type").value].sample); COLORS = {}; renderOpts(); schedule(); };
  $("btnLoadSel").onclick = () => loadSelectedChart().catch((e) => status("载入图表失败：" + (e.message || e), "bad"));
  $("btnNewChart").onclick = () => endEdit(true);
  $("btnUpdate").onclick = act(pptUpdate);
  $("btnUpdateXl").onclick = act(xlUpdate);
  $("xlCharts").addEventListener("mousedown", () => xlRefreshList());
  $("xlCharts").addEventListener("change", () => {
    const option = $("xlCharts").selectedOptions[0];
    xlPick($("xlCharts").value, option && option.dataset.chartId, option && option.dataset.hostRef)
      .catch((e) => status("载入图表失败：" + (e.message || e), "bad"));
  });
  $("btnJson").onclick = () => render(true);
  $("btnSvgPpt").onclick = act(pptInsertSvg);
  $("btnSlide").onclick = act(pptInsertSlide);
  $("btnSvgXl").onclick = act(xlInsertSvg);
  $("btnNative").onclick = act(xlInsertNative);
  $("btnSel").onclick = act(xlReadSelection, false);
  $("btnWriteXl").onclick = act(xlWriteSelection, false);
  $("btnDocCheck").onclick = async () => {
    $("btnDocCheck").disabled = true; status("正在检查文档状态…");
    try { await checkDocumentMaintenance(); status("文档状态检查完成", "ok"); }
    catch (e) { status("文档状态检查失败：" + (e.message || e), "bad"); }
    finally { $("btnDocCheck").disabled = false; }
  };
  $("btnCopyDiag").onclick = async () => {
    try {
      const ok = await copyText(JSON.stringify(maintenanceDiagnostic(), null, 2));
      status(ok ? "已复制不含图表数据的诊断信息" : "复制诊断信息失败", ok ? "ok" : "bad");
    } catch (e) { status("复制诊断信息失败：" + (e.message || e), "bad"); }
  };
  $("docIssues").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-maint]"); if (!button) return;
    button.disabled = true;
    try {
      let message = "";
      if (button.dataset.maint === "recover") message = await recoverMaintenancePending(button.dataset.id);
      if (button.dataset.maint === "relink") message = await relinkMaintenanceChart(button.dataset.id);
      if (button.dataset.maint === "fork") message = await forkMaintenanceShape(Number(button.dataset.index));
      if (button.dataset.maint === "inspect") {
        const record = documentStore().load(button.dataset.id);
        message = record ? `孤立状态：${record.chartId}，修订 ${record.revision}；未作修改` : "该状态已不存在";
      }
      status(message || "恢复操作完成", "ok");
    } catch (e) { status("恢复操作失败：" + (e.message || e), "bad"); }
    finally { button.disabled = false; }
  });
  $("btnDlSvg").onclick = act(async () => { download(fileBase() + ".svg", new Blob([LAST.svg], { type: "image/svg+xml" })); return "已下载 SVG"; });
  $("btnDlPng").onclick = act(async () => { const u = await svgToPngDataUrl(LAST.svg, LAST.width, LAST.height, 3); download(fileBase() + ".png", b64ToBlob(u.split(",")[1], "image/png")); return "已下载 PNG"; });
  $("btnDlPptx").onclick = act(async () => { download(fileBase() + ".pptx", b64ToBlob(await pptxB64(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")); return "已下载 PPTX"; });
  // 幻灯片比例选择（PPT）
  const r = document.createElement("select"); r.id = "slideRatio"; r.innerHTML = '<option value="16:9">目标幻灯片 16:9</option><option value="4:3">目标幻灯片 4:3</option>';
  r.value = store.get("ratio", "16:9"); r.onchange = () => store.set("ratio", r.value);
  $("btnSlide").after(r);
  renderThemeEditor();
  renderOpts();
  END_STARTUP_BUSY = UI_BUSY.begin();
}
const onDataChanged = (() => { const o = debounce(() => renderOpts(), 400); return () => { o(); schedule(); }; })();
function setHost(h) {
  HOST = h;
  OFFICE_CAPS = TC.Office.getCapabilities(window.Office, HOST);
  document.body.classList.remove("ppt", "xl", "web");
  document.body.classList.add(h);
  $("host").textContent = { ppt: "PowerPoint", xl: "Excel", web: "浏览器预览模式" }[h];
  applyCapabilityUi();
}

wire();
setHost("web");
let hostSet = false;
if (window.Office && Office.onReady) {
  Office.onReady(async (info) => {
    hostSet = true;
    if (info.host === Office.HostType.PowerPoint) {
      setHost("ppt");
      try {
        await TC.Office.fromAsyncResult((callback) => Office.context.document.addHandlerAsync(
          Office.EventType.DocumentSelectionChanged,
          () => { pptSelectionChanged().catch((e) => console.error("PowerPoint selection refresh failed", e)); },
          callback,
        ), Office);
      } catch (e) { status("无法监听 PowerPoint 选区变化；可重新打开任务窗格后再试", "bad"); }
      await pptSelectionChanged();
    } else if (info.host === Office.HostType.Excel) {
      setHost("xl");
      xlRefreshList();
      xlWatch().catch((e) => status("Excel 自动监听初始化失败：" + (e.message || e), "bad"));
    }
  });
}
initPy();
