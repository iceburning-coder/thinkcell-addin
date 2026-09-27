(function initStateModule(root, factory) {
  "use strict";
  const api = factory(root);
  root.TC = root.TC || {};
  root.TC.State = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : window, function createStateModule(root) {
  "use strict";

  const CURRENT_VERSION = 3;
  const PAYLOAD_PREFIX = "TCCHART1:";
  const MAX_PAYLOAD_BYTES = 1024 * 1024;
  const MAX_DEPTH = 20;
  const MAX_STRING_LENGTH = 512 * 1024;
  const MAX_ROWS = 5000;
  const MAX_COLUMNS = 200;
  const CHART_TYPES = new Set([
    "column", "waterfall", "line", "area", "combo", "pareto", "butterfly", "mekko", "pie",
    "pie_of_pie", "concentric", "scatter", "football", "candlestick", "gauge", "gantt", "table",
  ]);
  const PANEL_KEYS = [
    "type", "data", "title", "subtitle", "source", "theme", "dec", "size", "legend", "legendRev",
    "mag", "opt", "ann", "colors", "json",
  ];
  const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
  const COLOR_KEYS = new Set([
    "FG", "FG_MUTED", "BG", "AXIS", "GRID", "GUIDE", "OTHER", "ACCENT", "POS", "NEG", "TOTAL",
    "PART", "UP", "DOWN", "SHADE", "SERIES", "CAT", "color", "colors", "bar_color", "line_colors",
    "series_colors", "highlight_color", "quadrant_fill", "fill", "stroke",
  ]);
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  class TCError extends Error {
    constructor(code, userMessage, details, recoverable) {
      super(userMessage);
      this.name = "TCError";
      this.code = code;
      this.userMessage = userMessage;
      this.details = details || null;
      this.recoverable = recoverable !== false;
    }
  }

  function fail(code, message, details, recoverable) {
    throw new TCError(code, message, details, recoverable);
  }

  function encodeUtf8(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
    if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(text, "utf8"));
    const bytes = [];
    for (const character of text) {
      const point = character.codePointAt(0);
      if (point <= 0x7f) bytes.push(point);
      else if (point <= 0x7ff) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
      else if (point <= 0xffff) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
      else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    }
    return Uint8Array.from(bytes);
  }

  function byteLength(text) {
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    return encodeUtf8(text).length;
  }

  function assertTree(value, depth, path) {
    if (depth > MAX_DEPTH) fail("TC_STATE_TOO_DEEP", "图表状态嵌套过深。", { path });
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("TC_STATE_NON_FINITE", "图表包含非有限数字。", { path });
      return;
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) fail("TC_STATE_TOO_LARGE", "图表文本过长。", { path });
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ROWS * MAX_COLUMNS) fail("TC_STATE_TOO_LARGE", "图表数组过大。", { path });
      value.forEach((item, index) => assertTree(item, depth + 1, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      fail("TC_STATE_NOT_PLAIN", "图表状态只能包含普通数据。", { path });
    }
    Object.keys(value).forEach((key) => {
      if (DANGEROUS_KEYS.has(key)) fail("TC_STATE_DANGEROUS_KEY", "图表状态包含不允许的字段。", { path, key });
      assertTree(value[key], depth + 1, `${path}.${key}`);
    });
  }

  function assertSerializedSize(value) {
    const size = byteLength(JSON.stringify(value));
    if (size > MAX_PAYLOAD_BYTES) fail("TC_STATE_TOO_LARGE", "图表状态超过大小限制。", { size, limit: MAX_PAYLOAD_BYTES });
  }

  function assertColorValue(value, path) {
    if (value === null || value === undefined || value === "") return;
    if (typeof value === "string") {
      if (!COLOR_RE.test(value)) fail("TC_STATE_INVALID_COLOR", "图表包含无效颜色。", { path });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertColorValue(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      Object.keys(value).forEach((key) => assertColorValue(value[key], `${path}.${key}`));
      return;
    }
    fail("TC_STATE_INVALID_COLOR", "图表包含无效颜色。", { path });
  }

  function validateColours(value, path) {
    if (!value || typeof value !== "object") return;
    Object.keys(value).forEach((key) => {
      if (COLOR_KEYS.has(key) || /(?:^|_)(?:color|colors|fill|stroke)$/.test(key)) assertColorValue(value[key], `${path}.${key}`);
      else validateColours(value[key], `${path}.${key}`);
    });
  }

  function validateGrid(data) {
    const rows = String(data || "").replace(/\r/g, "").split("\n");
    if (rows.length > MAX_ROWS) fail("TC_STATE_TOO_LARGE", "数据表行数超过限制。", { rows: rows.length });
    rows.forEach((row, index) => {
      const columns = row.split("\t").length;
      if (columns > MAX_COLUMNS) fail("TC_STATE_TOO_LARGE", "数据表列数超过限制。", { row: index + 1, columns });
    });
  }

  function validateSpec(spec) {
    assertTree(spec, 0, "spec");
    assertSerializedSize(spec);
    if (!spec || typeof spec !== "object" || !CHART_TYPES.has(spec.type)) {
      fail("TC_STATE_INVALID_CHART", "未知或不支持的图表类型。", { type: spec && spec.type });
    }
    validateColours(spec, "spec");
    return spec;
  }

  function validateChart(chart) {
    assertTree(chart, 0, "chart");
    assertSerializedSize(chart);
    if (!chart || typeof chart !== "object" || !CHART_TYPES.has(chart.type)) {
      fail("TC_STATE_INVALID_CHART", "未知或不支持的图表类型。", { type: chart && chart.type });
    }
    validateGrid(chart.data);
    assertColorValue(chart.colors || {}, "chart.colors");
    if (chart.theme && typeof chart.theme === "object") validateColours(chart.theme, "chart.theme");
    if (chart.json !== null && chart.json !== undefined && chart.json !== "") {
      let spec;
      try { spec = typeof chart.json === "string" ? JSON.parse(chart.json) : chart.json; }
      catch (error) { fail("TC_STATE_INVALID_JSON", "高级 JSON 无法解析。", { message: error.message }); }
      validateSpec(spec);
    }
    return chart;
  }

  function cloneData(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function panelChart(input) {
    const chart = {};
    PANEL_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(input, key)) chart[key] = input[key];
    });
    return chart;
  }

  function migrate(input) {
    assertTree(input, 0, "state");
    if (!input || typeof input !== "object") fail("TC_STATE_INVALID", "图表状态格式不正确。");
    if (input.version === CURRENT_VERSION) return normalize(input, { mode: "write" });
    if (typeof input.version === "number" && input.version > CURRENT_VERSION) {
      fail("TC_STATE_FUTURE_VERSION", "该图表由更高版本插件创建，当前版本只能只读打开。", { version: input.version });
    }
    const chart = panelChart(input.chart && typeof input.chart === "object" ? input.chart : input);
    validateChart(chart);
    const link = typeof input.link === "string"
      ? { kind: "legacy-address", address: input.link, sheet: input.sheet || null }
      : (input.link || null);
    const meta = input.sheet ? { sheet: input.sheet } : {};
    return { version: CURRENT_VERSION, chartId: null, revision: 0, chart: cloneData(chart), link: cloneData(link), meta };
  }

  function normalize(input, options) {
    const mode = (options && options.mode) || "write";
    assertTree(input, 0, "state");
    assertSerializedSize(input);
    if (input && typeof input.version === "number" && input.version > CURRENT_VERSION) {
      if (mode !== "read") fail("TC_STATE_FUTURE_VERSION", "该图表由更高版本插件创建，当前版本不能覆盖。", { version: input.version });
      const future = cloneData(input);
      future.readOnly = true;
      return future;
    }
    if (!input || input.version !== CURRENT_VERSION) return migrate(input);
    if (input.chartId !== null && input.chartId !== undefined && !UUID_RE.test(input.chartId)) fail("TC_STATE_INVALID_ID", "图表标识格式不正确。");
    if (!Number.isInteger(input.revision) || input.revision < 0) fail("TC_STATE_INVALID_REVISION", "图表修订号格式不正确。");
    validateChart(input.chart);
    if (input.link !== null && input.link !== undefined) assertTree(input.link, 0, "link");
    const record = cloneData(input);
    if (!Object.prototype.hasOwnProperty.call(record, "link")) record.link = null;
    if (!record.meta) record.meta = {};
    return record;
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("utf8");
    let encoded = "";
    bytes.forEach((value) => { encoded += `%${value.toString(16).padStart(2, "0")}`; });
    return decodeURIComponent(encoded);
  }

  function toBase64(bytes) {
    if (typeof root.btoa === "function") {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
      return root.btoa(binary);
    }
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    fail("TC_STATE_ENCODING", "当前环境无法编码图表状态。");
  }

  function fromBase64(encoded) {
    let binary;
    try {
      if (typeof root.atob === "function") binary = root.atob(encoded);
      else if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(encoded, "base64"));
      else fail("TC_STATE_ENCODING", "当前环境无法解码图表状态。");
    } catch (error) {
      fail("TC_STATE_INVALID_CLIPBOARD", "剪贴板中的图表数据已损坏。", { message: error.message });
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function serializeClipboard(input) {
    const record = normalize(input, { mode: "write" });
    const json = JSON.stringify(record);
    if (byteLength(json) > MAX_PAYLOAD_BYTES) fail("TC_STATE_TOO_LARGE", "图表状态超过剪贴板大小限制。");
    return PAYLOAD_PREFIX + toBase64(encodeUtf8(json));
  }

  function parseClipboard(text) {
    const value = String(text || "").trim();
    if (!value.startsWith(PAYLOAD_PREFIX)) fail("TC_STATE_INVALID_CLIPBOARD", "剪贴板中没有可识别的图表状态。");
    const encoded = value.slice(PAYLOAD_PREFIX.length);
    if (encoded.length > MAX_PAYLOAD_BYTES) fail("TC_STATE_TOO_LARGE", "剪贴板中的图表状态超过大小限制。");
    let parsed;
    try { parsed = JSON.parse(decodeUtf8(fromBase64(encoded))); }
    catch (error) {
      if (error instanceof TCError) throw error;
      fail("TC_STATE_INVALID_CLIPBOARD", "剪贴板中的图表状态无法解析。", { message: error.message });
    }
    return normalize(parsed, { mode: "write" });
  }

  function createChartId() {
    const cryptoApi = root.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") fail("TC_CRYPTO_UNAVAILABLE", "当前环境无法生成安全的图表标识。", null, false);
    if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  const SVG_TAGS = new Set(["svg", "g", "rect", "line", "polyline", "polygon", "circle", "path", "text", "tspan"]);
  const SVG_ATTRS = new Set([
    "xmlns", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
    "d", "points", "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linejoin", "opacity",
    "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dy", "transform",
  ]);

  function unsafeSvg(message, details) {
    fail("TC_SVG_UNSAFE", message || "图表 SVG 未通过安全检查。", details, false);
  }

  function validateSvgElement(element) {
    const name = String(element.localName || "");
    if (!SVG_TAGS.has(name)) unsafeSvg("图表 SVG 包含不允许的元素。", { element: name });
    Array.from(element.attributes || []).forEach((attribute) => {
      const attrName = String(attribute.name || "");
      const value = String(attribute.value || "");
      if (/^on/i.test(attrName) || !SVG_ATTRS.has(attrName)) unsafeSvg("图表 SVG 包含不允许的属性。", { attribute: attrName });
      if (attrName === "xmlns") {
        if (value !== "http://www.w3.org/2000/svg") unsafeSvg("图表 SVG 命名空间不正确。");
        return;
      }
      if (/(?:javascript\s*:|data\s*:|https?\s*:|url\s*\()/i.test(value)) unsafeSvg("图表 SVG 包含外部或脚本地址。", { attribute: attrName });
      if (/(?:onload|onerror)\s*=/i.test(value)) unsafeSvg("图表 SVG 包含事件处理代码。", { attribute: attrName });
    });
    Array.from(element.children || []).forEach(validateSvgElement);
  }

  function sanitizeSvg(svgText, options) {
    const markup = String(svgText || "");
    if (!markup || byteLength(markup) > MAX_PAYLOAD_BYTES) unsafeSvg("图表 SVG 为空或超过大小限制。");
    const Parser = (options && options.DOMParser) || root.DOMParser;
    if (typeof Parser !== "function") fail("TC_SVG_PARSER_UNAVAILABLE", "当前环境无法安全解析 SVG。", null, false);
    let parsed;
    try { parsed = new Parser().parseFromString(markup, "image/svg+xml"); }
    catch (error) { unsafeSvg("图表 SVG 无法解析。", { message: error.message }); }
    if (!parsed || !parsed.documentElement || (parsed.getElementsByTagName && parsed.getElementsByTagName("parsererror").length)) {
      unsafeSvg("图表 SVG 语法不正确。");
    }
    if (String(parsed.documentElement.localName) !== "svg") unsafeSvg("图表输出不是 SVG。");
    validateSvgElement(parsed.documentElement);
    return parsed.documentElement;
  }

  function createRenderLifecycle() {
    let sequence = 0;
    let snapshot = null;
    return Object.freeze({
      start() { sequence += 1; snapshot = null; return sequence; },
      publish(renderId, value) {
        if (renderId !== sequence) return false;
        snapshot = Object.freeze(Object.assign({}, value));
        return true;
      },
      fail(renderId) { if (renderId === sequence) snapshot = null; },
      current() { return snapshot; },
      isCurrent(renderId) { return renderId === sequence; },
    });
  }

  return Object.freeze({ CURRENT_VERSION, PAYLOAD_PREFIX, MAX_PAYLOAD_BYTES, MAX_DEPTH, TCError, normalize, migrate,
    validateChart, validateSpec, serializeClipboard, parseClipboard, createChartId, sanitizeSvg, createRenderLifecycle });
}));
