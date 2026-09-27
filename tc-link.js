(function initLinkModule(root, factory) {
  "use strict";
  const api = factory(root);
  root.TC = root.TC || {};
  root.TC.Link = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : window, function createLinkModule(root) {
  "use strict";

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function definedName(chartId) {
    if (!UUID_RE.test(String(chartId || ""))) fail("TC_LINK_INVALID_ID", "图表标识不能用于 Excel 定义名称。");
    return `TC_LINK_${String(chartId).replace(/-/g, "").toUpperCase()}`;
  }

  function splitAddress(address) {
    const value = String(address || "");
    const separator = value.lastIndexOf("!");
    if (separator < 0) return { sheet: "", range: value };
    let sheet = value.slice(0, separator);
    if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
    return { sheet, range: value.slice(separator + 1) };
  }

  function quoteSheet(sheet) {
    const value = String(sheet || "");
    return /^[A-Za-z0-9_]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
  }

  function qualifyAddress(sheet, range) {
    return sheet ? `${quoteSheet(sheet)}!${String(range || "")}` : String(range || "");
  }

  function createRecord(chartId, range) {
    if (!range || !range.worksheetId) fail("TC_LINK_INVALID_RANGE", "链接区域缺少工作表标识。");
    const parsed = splitAddress(range.address || "");
    const sheet = String(range.sheet || parsed.sheet || "");
    return {
      kind: "workbook-name",
      name: definedName(chartId),
      worksheetId: String(range.worksheetId),
      sheet,
      lastAddress: qualifyAddress(sheet, parsed.range),
      status: "ok",
    };
  }

  function broken(link, error) {
    const result = clone(link);
    result.status = "broken";
    result.error = {
      code: String((error && error.code) || "TC_LINK_REF"),
      message: String((error && error.message) || "Excel 链接已失效。"),
    };
    return result;
  }

  async function resolve(link, resolver) {
    if (!link) return null;
    if (typeof link === "string") return { kind: "legacy-address", address: link, lastAddress: link, status: "legacy" };
    if (link.kind === "legacy-address") {
      const result = clone(link);
      result.lastAddress = result.address;
      result.status = "legacy";
      return result;
    }
    if (link.kind !== "workbook-name") return broken(link, { code: "TC_LINK_KIND", message: "未知的 Excel 链接类型。" });
    try {
      const current = await resolver(link.name);
      if (!current || !current.address || /#REF!/i.test(String(current.formula || ""))) {
        return broken(link, { code: "TC_LINK_REF", message: "Excel 定义名称已失效。" });
      }
      const parsed = splitAddress(current.address);
      const sheet = String(current.sheet || parsed.sheet || link.sheet || "");
      const result = clone(link);
      result.worksheetId = String(current.worksheetId || link.worksheetId || "");
      result.sheet = sheet;
      result.lastAddress = qualifyAddress(sheet, parsed.range);
      result.status = "ok";
      delete result.error;
      return result;
    } catch (error) { return broken(link, error); }
  }

  function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }

  function stableValueHash(value) {
    const input = canonical(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function rangeKey(address) {
    return splitAddress(address).range.replace(/\$/g, "").replace(/\s/g, "").toUpperCase();
  }

  function createEchoTracker(options) {
    const opts = options || {};
    const now = opts.now || Date.now;
    const ttl = Number(opts.ttl || 10000);
    const expected = new Map();
    const keyFor = (event) => [
      String(event.chartId || ""), String(event.worksheetId || ""), rangeKey(event.address), stableValueHash(event.values),
    ].join("\u0000");
    const cleanup = () => {
      const time = now();
      expected.forEach((expires, key) => { if (expires <= time) expected.delete(key); });
    };
    return Object.freeze({
      expect(event) { cleanup(); expected.set(keyFor(event), now() + ttl); },
      consume(event) {
        cleanup();
        const key = keyFor(event);
        if (!expected.has(key)) return false;
        expected.delete(key);
        return true;
      },
      clear(chartId) {
        const prefix = String(chartId || "") + "\u0000";
        expected.forEach((_expires, key) => { if (key.startsWith(prefix)) expected.delete(key); });
      },
    });
  }

  function createRefreshQueue(options) {
    const opts = options || {};
    if (typeof opts.run !== "function") fail("TC_LINK_QUEUE", "刷新队列缺少执行函数。");
    const delay = Number(opts.delay === undefined ? 600 : opts.delay);
    const setTimer = opts.setTimeout || root.setTimeout;
    const clearTimer = opts.clearTimeout || root.clearTimeout;
    const states = new Map();

    function stateFor(chartId) {
      if (!states.has(chartId)) states.set(chartId, { timer: null, ready: false, running: false, latest: undefined, waiters: [] });
      return states.get(chartId);
    }

    function isIdle(state) {
      return !state.timer && !state.ready && !state.running && state.latest === undefined;
    }

    function notifyIdle(state) {
      if (!isIdle(state)) return;
      const waiters = state.waiters.splice(0);
      waiters.forEach((resolveIdle) => resolveIdle());
    }

    function drain(chartId, state) {
      if (state.running || !state.ready) return;
      state.running = true;
      Promise.resolve().then(async () => {
        while (state.ready) {
          state.ready = false;
          const payload = state.latest;
          state.latest = undefined;
          try { await opts.run(chartId, payload); }
          catch (error) { if (typeof opts.onError === "function") opts.onError(error, chartId, payload); }
        }
      }).finally(() => {
        state.running = false;
        if (state.ready) drain(chartId, state);
        else notifyIdle(state);
      });
    }

    return Object.freeze({
      schedule(chartId, payload) {
        const key = String(chartId || "");
        const state = stateFor(key);
        state.latest = payload;
        state.ready = false;
        if (state.timer) clearTimer(state.timer);
        state.timer = setTimer(() => {
          state.timer = null;
          state.ready = true;
          drain(key, state);
        }, delay);
      },
      idle(chartId) {
        const state = stateFor(String(chartId || ""));
        if (isIdle(state)) return Promise.resolve();
        return new Promise((resolveIdle) => state.waiters.push(resolveIdle));
      },
    });
  }

  return Object.freeze({
    definedName, splitAddress, qualifyAddress, createRecord, resolve,
    stableValueHash, createEchoTracker, createRefreshQueue,
  });
}));
