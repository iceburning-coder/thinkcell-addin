(function initStateModule(root, factory) {
  "use strict";
  const api = factory(root);
  root.TC = root.TC || {};
  root.TC.State = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : window, function createStateModule(root) {
  "use strict";

  const CURRENT_VERSION = 4;
  const V3_VERSION = 3;
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

  function parseGrid(text) {
    const lines = text.replace(/\r/g, "").split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) return [];
    const delimiter = lines.some((line) => line.includes("\t"))
      ? "\t"
      : (lines.some((line) => line.includes(",")) ? "," : /\s{2,}|\s/);
    return lines.map((line) => line.split(delimiter).map((cell) => cell.trim()));
  }

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

  const THEME_KEYS = Object.freeze(["ACCENT", "OTHER", "POS", "NEG", "TOTAL"]);
  function normalizeColorTheme(value, fallback) {
    const safeFallback = cloneData(fallback);
    try {
      assertTree(value, 0, "customTheme");
      if (!value || typeof value !== "object" || Array.isArray(value)) return safeFallback;
      const allowed = new Set(["SERIES"].concat(THEME_KEYS));
      if (Object.keys(value).some((key) => !allowed.has(key))) return safeFallback;
      if (!Array.isArray(value.SERIES) || value.SERIES.length < 1 || value.SERIES.length > 10) return safeFallback;
      if (!value.SERIES.every((color) => typeof color === "string" && COLOR_RE.test(color))) return safeFallback;
      if (!THEME_KEYS.every((key) => typeof value[key] === "string" && COLOR_RE.test(value[key]))) return safeFallback;
      return {
        SERIES: value.SERIES.slice(),
        ACCENT: value.ACCENT, OTHER: value.OTHER, POS: value.POS, NEG: value.NEG, TOTAL: value.TOTAL,
      };
    } catch (error) { return safeFallback; }
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
    if (input.version === V3_VERSION || input.version === CURRENT_VERSION) return normalize(input, { mode: "write" });
    if (typeof input.version === "number" && input.version > CURRENT_VERSION) {
      fail("TC_STATE_FUTURE_VERSION", "该图表由更高版本插件创建，当前版本只能只读打开。", { version: input.version });
    }
    const chart = panelChart(input.chart && typeof input.chart === "object" ? input.chart : input);
    validateChart(chart);
    const link = typeof input.link === "string"
      ? { kind: "legacy-address", address: input.link, sheet: input.sheet || null }
      : (input.link || null);
    const meta = input.sheet ? { sheet: input.sheet } : {};
    return { version: V3_VERSION, chartId: null, revision: 0, chart: cloneData(chart), link: cloneData(link), meta };
  }

  function validPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }

  function validateElementHierarchy(elements) {
    const byId = new Map();
    elements.forEach((element, index) => {
      if (!validPlainObject(element)) fail("TC_STATE_INVALID_V4", "元素记录格式不正确。", { index });
      const required = ["elementId", "type", "parentId", "children", "source", "geometry", "constraints", "style", "dataBinding", "userOverrides", "revision"];
      if (required.some((key) => !Object.prototype.hasOwnProperty.call(element, key))) {
        fail("TC_STATE_INVALID_V4", "元素记录缺少必需字段。", { index });
      }
      if (typeof element.elementId !== "string" || !element.elementId) fail("TC_STATE_INVALID_V4", "元素标识格式不正确。", { index });
      if (byId.has(element.elementId)) fail("TC_ELEMENT_DUPLICATE_ID", "图表包含重复的元素标识。", { elementId: element.elementId });
      if (typeof element.type !== "string" || !element.type) fail("TC_STATE_INVALID_V4", "元素类型格式不正确。", { index });
      if (element.parentId !== null && typeof element.parentId !== "string") fail("TC_STATE_INVALID_V4", "元素父级格式不正确。", { index });
      if (!Array.isArray(element.children) || element.children.some((childId) => typeof childId !== "string" || !childId)) {
        fail("TC_STATE_INVALID_V4", "元素子级格式不正确。", { index });
      }
      if (element.source !== "renderer" && element.source !== "user") fail("TC_STATE_INVALID_V4", "元素来源格式不正确。", { index });
      ["geometry", "constraints", "style", "dataBinding", "userOverrides"].forEach((key) => {
        if (!validPlainObject(element[key])) fail("TC_STATE_INVALID_V4", "元素字段格式不正确。", { index, key });
      });
      if (!Number.isInteger(element.revision) || element.revision < 0) fail("TC_STATE_INVALID_V4", "元素修订号格式不正确。", { index });
      byId.set(element.elementId, element);
    });

    const parentCounts = new Map();
    elements.forEach((parent) => {
      parent.children.forEach((childId) => {
        const child = byId.get(childId);
        if (!child) fail("TC_ELEMENT_INVALID_HIERARCHY", "元素引用了不存在的子级。", { parentId: parent.elementId, childId });
        parentCounts.set(childId, (parentCounts.get(childId) || 0) + 1);
        if (parentCounts.get(childId) > 1 || child.parentId !== parent.elementId) {
          fail("TC_ELEMENT_INVALID_HIERARCHY", "元素父子关系不一致。", { parentId: parent.elementId, childId });
        }
      });
    });
    elements.forEach((element) => {
      if (element.parentId === null) return;
      const parent = byId.get(element.parentId);
      if (!parent || !parent.children.includes(element.elementId)) {
        fail("TC_ELEMENT_INVALID_HIERARCHY", "元素父级不存在或未声明子级。", { elementId: element.elementId, parentId: element.parentId });
      }
    });

    const visiting = new Set();
    const visited = new Set();
    function visit(elementId) {
      if (visiting.has(elementId)) fail("TC_ELEMENT_INVALID_HIERARCHY", "元素层级包含循环。", { elementId });
      if (visited.has(elementId)) return;
      visiting.add(elementId);
      byId.get(elementId).children.forEach(visit);
      visiting.delete(elementId);
      visited.add(elementId);
    }
    elements.forEach((element) => visit(element.elementId));
  }

  function validateV4Record(input) {
    if (!input || input.version !== CURRENT_VERSION || input.minReaderVersion !== CURRENT_VERSION) {
      fail("TC_STATE_INVALID_V4", "v4 图表状态版本字段不正确。");
    }
    const required = ["chartId", "revision", "chart", "link", "meta", "elements", "hostMap"];
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) fail("TC_STATE_INVALID_V4", "v4 图表状态缺少必需字段。");
    if (!UUID_RE.test(input.chartId)) fail("TC_STATE_INVALID_ID", "图表标识格式不正确。");
    if (!Number.isInteger(input.revision) || input.revision < 0) fail("TC_STATE_INVALID_REVISION", "图表修订号格式不正确。");
    validateChart(input.chart);
    if (input.link !== null && !validPlainObject(input.link)) fail("TC_STATE_INVALID_V4", "图表链接格式不正确。");
    if (!validPlainObject(input.meta) || !Array.isArray(input.elements) || !validPlainObject(input.hostMap)) {
      fail("TC_STATE_INVALID_V4", "v4 图表状态字段格式不正确。");
    }
    if (Object.prototype.hasOwnProperty.call(input.meta, "dataKeys")) {
      const dataKeys = input.meta.dataKeys;
      if (!validPlainObject(dataKeys) || !Array.isArray(dataKeys.rows) || !Array.isArray(dataKeys.series)) {
        fail("TC_STATE_INVALID_V4", "元素数据键格式不正确。");
      }
      ["rows", "series"].forEach((axis) => {
        const seen = new Set();
        dataKeys[axis].forEach((entry, index) => {
          if (!validPlainObject(entry) || typeof entry.key !== "string" || !entry.key
              || !/^sha256:[0-9a-f]{64}$/i.test(entry.labelFingerprint)
              || !/^sha256:[0-9a-f]{64}$/i.test(entry.contentFingerprint)) {
            fail("TC_STATE_INVALID_V4", "元素数据键条目格式不正确。", { axis, index });
          }
          if (seen.has(entry.key)) fail("TC_ELEMENT_DUPLICATE_DATA_KEY", "图表包含重复的数据键。", { axis, key: entry.key });
          seen.add(entry.key);
        });
      });
    }
    if (Object.prototype.hasOwnProperty.call(input.meta, "orphanedOverrides")) {
      if (!Array.isArray(input.meta.orphanedOverrides)) fail("TC_STATE_INVALID_V4", "孤立覆盖值格式不正确。");
      if (input.meta.orphanedOverrides.length > 256) {
        fail("TC_ELEMENT_ORPHAN_LIMIT", "单张图最多保留 256 条孤立覆盖值。",
          { count: input.meta.orphanedOverrides.length, limit: 256 });
      }
    }
    validateElementHierarchy(input.elements);
    return input;
  }

  function normalize(input, options) {
    const mode = (options && options.mode) || "write";
    assertTree(input, 0, "state");
    assertSerializedSize(input);
    const hasElementFields = !!(input && (Object.prototype.hasOwnProperty.call(input, "elements")
      || Object.prototype.hasOwnProperty.call(input, "hostMap")));
    if (input && typeof input.version === "number" && input.version < CURRENT_VERSION && hasElementFields) {
      fail("TC_STATE_VERSION_MISMATCH", "包含元素数据的图表必须使用 v4 状态。", { version: input.version });
    }
    if (input && typeof input.version === "number" && input.version > CURRENT_VERSION) {
      if (mode !== "read") fail("TC_STATE_FUTURE_VERSION", "该图表由更高版本插件创建，当前版本不能覆盖。", { version: input.version });
      const future = cloneData(input);
      future.readOnly = true;
      return future;
    }
    if (input && typeof input.minReaderVersion === "number" && input.minReaderVersion > CURRENT_VERSION) {
      if (mode !== "read") fail("TC_STATE_READER_TOO_OLD", "该图表需要更高版本插件，当前版本不能覆盖。", { minReaderVersion: input.minReaderVersion });
      const future = cloneData(input);
      future.readOnly = true;
      return future;
    }
    if (input && input.version === CURRENT_VERSION) {
      validateV4Record(input);
      return cloneData(input);
    }
    if (!input || input.version !== V3_VERSION) return migrate(input);
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

  return Object.freeze({ CURRENT_VERSION, PAYLOAD_PREFIX, MAX_PAYLOAD_BYTES, MAX_DEPTH, TCError, parseGrid, normalize, migrate,
    validateChart, validateSpec, validateV4Record, normalizeColorTheme, serializeClipboard, parseClipboard, createChartId, sanitizeSvg, createRenderLifecycle });
}));
