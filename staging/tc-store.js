(function initStoreModule(root, factory) {
  "use strict";
  const api = factory(root);
  root.TC = root.TC || {};
  root.TC.Store = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : window, function createStoreModule(root) {
  "use strict";

  const INDEX_KEY = "TC:index:v3";
  const LEGACY_INDEX_KEY = "TC:index";
  const CHART_KEY_PREFIX = "TC:chart:";

  function legacyExcelHostRefMatches(recordedRef, record, shape) {
    const value = String(recordedRef || "");
    if (!value.startsWith("xl:") || !shape || shape.host !== "xl" || !shape.shapeId) return false;
    const stableSheetId = record && ((record.meta && record.meta.sheetId) || (record.link && record.link.worksheetId));
    if (stableSheetId && String(shape.sheetId || "") !== String(stableSheetId)) return false;
    const separator = value.lastIndexOf(":");
    return separator > 2 && value.slice(separator + 1) === String(shape.shapeId);
  }

  function reconcileIdentities(records, shapes, pending) {
    const result = { matches: [], forks: [], orphans: [], duplicates: [], untracked: [], pendingRecoveries: [], autoDelete: [] };
    const recordList = (records || []).filter((record) => record && record.chartId);
    const shapeList = (shapes || []).filter(Boolean);
    const groups = new Map();
    const forkFor = (record, shape) => {
      const forkRecord = clone(record);
      forkRecord.chartId = root.TC && root.TC.State ? root.TC.State.createChartId() : null;
      forkRecord.revision = 0;
      forkRecord.meta = Object.assign({}, forkRecord.meta || {}, {
        forkedFrom: record.chartId, hostRef: shape.hostRef, hostName: shape.name,
      });
      return { chartId: record.chartId, record, shape, forkRecord };
    };
    shapeList.forEach((shape) => {
      if (!shape.chartId) {
        if (String(shape.name || "").startsWith("TC:")) result.untracked.push(shape);
        return;
      }
      if (!groups.has(shape.chartId)) groups.set(shape.chartId, []);
      groups.get(shape.chartId).push(shape);
    });
    recordList.forEach((record) => {
      const candidates = groups.get(record.chartId) || [];
      if (!candidates.length) { result.orphans.push(record); return; }
      const addMatch = (shape) => {
        const expectedName = (record.meta && record.meta.hostName) || `TC:${record.chartId}`;
        result.matches.push({ chartId: record.chartId, record, shape, renamed: shape.name !== expectedName });
      };
      if (candidates.length === 1) { addMatch(candidates[0]); return; }

      const pendingOperation = pending && pending[record.chartId];
      if (pendingOperation) {
        const tokenMatches = candidates.filter((shape) => shape.pendingToken && shape.pendingToken === pendingOperation.token);
        const eligible = tokenMatches.length ? tokenMatches : candidates.filter((shape) => Number(shape.revision || 0) <= record.revision);
        const highest = Math.max(...eligible.map((shape) => Number(shape.revision || 0)));
        const preferred = eligible.filter((shape) => Number(shape.revision || 0) === highest);
        if (preferred.length === 1) {
          addMatch(preferred[0]);
          result.pendingRecoveries.push({ chartId: record.chartId, operation: pendingOperation, shape: preferred[0], survivors: candidates.slice() });
          return;
        }
      }

      const recordedRef = record.meta && record.meta.hostRef;
      const exactHostMatches = recordedRef ? candidates.filter((shape) => shape.hostRef === recordedRef) : [];
      const hostMatches = exactHostMatches.length ? exactHostMatches
        : (recordedRef ? candidates.filter((shape) => legacyExcelHostRefMatches(recordedRef, record, shape)) : []);
      if (hostMatches.length === 1) {
        addMatch(hostMatches[0]);
        candidates.filter((shape) => shape !== hostMatches[0]).forEach((shape) => result.forks.push(forkFor(record, shape)));
        return;
      }

      const committed = candidates.filter((shape) => Number(shape.revision || 0) <= record.revision);
      const highest = committed.length ? Math.max(...committed.map((shape) => Number(shape.revision || 0))) : -1;
      const highestShapes = committed.filter((shape) => Number(shape.revision || 0) === highest);
      if (highestShapes.length === 1) {
        addMatch(highestShapes[0]);
        candidates.filter((shape) => shape !== highestShapes[0]).forEach((shape) => result.forks.push(forkFor(record, shape)));
      } else result.duplicates.push({ chartId: record.chartId, record, shapes: candidates.slice() });
    });
    return result;
  }

  function maintenanceReport(input) {
    const source = input || {};
    const records = (source.records || []).filter(Boolean);
    const pendingMap = source.pending || {};
    const reconciliation = reconcileIdentities(records, source.shapes || [], pendingMap);
    const brokenLinks = records.filter((record) => record.link && record.link.status === "broken");
    const migratedLegacy = records.filter((record) => record.meta && record.meta.legacyKey);
    return Object.assign({}, reconciliation, {
      pending: Object.keys(pendingMap).map((chartId) => Object.assign({ chartId }, clone(pendingMap[chartId]))),
      brokenLinks,
      migratedLegacy,
      legacyKeys: clone(source.legacyNames || []),
    });
  }

  function editDisposition(report, hostRef) {
    const fork = (report.forks || []).find((item) => item.shape && item.shape.hostRef === hostRef);
    if (fork) return { action: "fork", item: fork };
    const ambiguous = (report.duplicates || []).find((item) => (item.shapes || []).some((shape) => shape.hostRef === hostRef));
    if (ambiguous) return { action: "ambiguous", item: ambiguous };
    const match = (report.matches || []).find((item) => item.shape && item.shape.hostRef === hostRef);
    return match ? { action: "keep", item: match } : { action: "unknown", item: null };
  }

  function diagnosticSummary(input) {
    const source = input || {};
    const report = source.report || maintenanceReport({});
    const errorCodes = [];
    report.brokenLinks.forEach((record) => {
      const code = record.link && record.link.error && record.link.error.code;
      if (code && !errorCodes.includes(code)) errorCodes.push(code);
    });
    return {
      schemaVersion: 3,
      addinVersion: source.addinVersion || null,
      engineVersion: source.engineVersion || null,
      host: source.host || null,
      capabilities: clone(source.capabilities || {}),
      counts: {
        records: report.matches.length + report.orphans.length + report.duplicates.length,
        pending: report.pending.length,
        duplicates: report.duplicates.length,
        orphans: report.orphans.length,
        untracked: report.untracked.length,
        brokenLinks: report.brokenLinks.length,
        migratedLegacy: report.migratedLegacy.length,
        legacyKeys: report.legacyKeys.length,
      },
      errorCodes: errorCodes.sort(),
    };
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function create(settings, options) {
    const opts = options || {};
    const state = opts.state || (root.TC && root.TC.State);
    const office = opts.office || root.Office;
    if (!state) throw new Error("TC.State is required before TC.Store");

    function error(code, message) {
      return new state.TCError(code, message);
    }

    function available() {
      return !!(settings && typeof settings.get === "function" && typeof settings.set === "function");
    }

    function chartKey(chartId) { return CHART_KEY_PREFIX + chartId; }

    function emptyIndex() { return { version: 3, charts: {}, pending: {} }; }

    function readIndex(forWrite) {
      if (!available()) return emptyIndex();
      const raw = settings.get(INDEX_KEY);
      if (!raw) return emptyIndex();
      if (typeof raw.version === "number" && raw.version > 3) {
        if (forWrite) throw error("TC_STORE_FUTURE_VERSION", "文档存储由更高版本插件创建，当前版本不能覆盖。");
        return clone(raw);
      }
      const result = clone(raw);
      result.version = 3;
      if (!result.charts || typeof result.charts !== "object") result.charts = {};
      if (!result.pending || typeof result.pending !== "object") result.pending = {};
      return result;
    }

    function saveSettings() {
      if (!available() || typeof settings.saveAsync !== "function") {
        return Promise.reject(error("TC_STORE_UNAVAILABLE", "当前文档不支持保存图表状态。"));
      }
      if (typeof opts.saveSettings === "function") return Promise.resolve(opts.saveSettings(settings));
      if (root.TC && root.TC.Office && typeof root.TC.Office.saveSettings === "function") {
        return root.TC.Office.saveSettings(settings, office);
      }
      return new Promise((resolve, reject) => {
        try {
          settings.saveAsync((result) => {
            const succeeded = office && office.AsyncResultStatus ? office.AsyncResultStatus.Succeeded : "succeeded";
            if (result && result.status === succeeded) resolve(result.value);
            else {
              const original = result && result.error;
              const failure = new Error((original && original.message) || "文档设置保存失败。");
              failure.code = (original && original.code) || "TC_STORE_SAVE_FAILED";
              reject(failure);
            }
          });
        } catch (failure) { reject(failure); }
      });
    }

    function refreshSettings() {
      if (!available() || typeof settings.refreshAsync !== "function") return Promise.resolve();
      return new Promise((resolve, reject) => {
        try {
          settings.refreshAsync((result) => {
            const succeeded = office && office.AsyncResultStatus ? office.AsyncResultStatus.Succeeded : "succeeded";
            if (result && result.status === succeeded) resolve(result.value);
            else {
              const original = result && result.error;
              const failure = new Error((original && original.message) || "文档设置刷新失败。");
              failure.code = (original && original.code) || "TC_STORE_REFRESH_FAILED";
              reject(failure);
            }
          });
        } catch (failure) { reject(failure); }
      });
    }

    async function write(entries) {
      if (!available()) throw error("TC_STORE_UNAVAILABLE", "当前文档不支持保存图表状态。");
      const previous = entries.map(([key]) => [key, clone(settings.get(key))]);
      entries.forEach(([key, value]) => {
        if (value === undefined) {
          if (typeof settings.remove === "function") settings.remove(key);
        } else settings.set(key, clone(value));
      });
      try { await saveSettings(); }
      catch (failure) {
        previous.forEach(([key, value]) => {
          if (value === undefined) {
            if (typeof settings.remove === "function") settings.remove(key);
          } else settings.set(key, value);
        });
        throw failure;
      }
    }

    function load(chartId) {
      if (!available() || !chartId) return null;
      const raw = settings.get(chartKey(chartId));
      return raw ? state.normalize(raw, { mode: "read" }) : null;
    }

    function loadLegacy(name) {
      if (!available() || !name) return null;
      const raw = settings.get(name);
      return raw ? state.normalize(raw, { mode: "read" }) : null;
    }

    async function saveRecord(input, clearPending, saveOptions) {
      if (input && typeof input.version === "number" && input.version > state.CURRENT_VERSION) {
        state.normalize(input, { mode: "write" });
      }
      let record = state.normalize(input, { mode: "write" });
      if (!record.chartId) {
        record = clone(record);
        record.chartId = state.createChartId();
      }
      await refreshSettings();
      const existingRaw = available() ? settings.get(chartKey(record.chartId)) : null;
      if (existingRaw && typeof existingRaw.version === "number" && existingRaw.version > state.CURRENT_VERSION) {
        throw error("TC_STORE_FUTURE_VERSION", "文档中的图表状态由更高版本插件创建，当前版本不能覆盖。");
      }
      if (existingRaw && typeof existingRaw.minReaderVersion === "number"
          && existingRaw.minReaderVersion > state.CURRENT_VERSION) {
        state.normalize(existingRaw, { mode: "write" });
      }
      if (existingRaw && existingRaw.version >= 4 && record.version < 4) {
        throw error("TC_STATE_READER_TOO_OLD", "该图表包含当前写入器不能保留的元素状态，已拒绝覆盖。");
      }
      if (record.version >= 4) {
        const expectedRevision = saveOptions && saveOptions.expectedRevision;
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
          throw error("TC_STORE_REVISION_REQUIRED", "保存元素状态前必须提供已读取的修订号。");
        }
        const storedRevision = existingRaw && Number.isInteger(existingRaw.revision) ? existingRaw.revision : 0;
        if (expectedRevision !== storedRevision || record.revision !== storedRevision + 1) {
          throw error("TC_STORE_REVISION_CONFLICT", "图表已被其他窗口更新，请重新载入后再试。");
        }
      }
      const index = readIndex(true);
      index.charts[record.chartId] = { revision: record.revision };
      if (clearPending) delete index.pending[record.chartId];
      await write([[chartKey(record.chartId), record], [INDEX_KEY, index]]);
      return clone(record);
    }

    async function save(input, saveOptions) { return saveRecord(input, false, saveOptions); }

    async function beginPending(operation) {
      if (!operation || !operation.chartId) throw error("TC_STORE_INVALID_PENDING", "待处理操作缺少图表标识。");
      await refreshSettings();
      const index = readIndex(true);
      index.pending[operation.chartId] = clone(operation);
      await write([[INDEX_KEY, index]]);
      return clone(operation);
    }

    async function commitPending(record, saveOptions) { return saveRecord(record, true, saveOptions); }

    async function clearPending(chartId) {
      await refreshSettings();
      const index = readIndex(true);
      delete index.pending[chartId];
      await write([[INDEX_KEY, index]]);
    }

    async function recoverPending(chartId) {
      await refreshSettings();
      const index = readIndex(true);
      const pending = index.pending[chartId];
      if (!pending) return null;
      const record = load(chartId);
      if (!record || record.readOnly || record.revision < Number(pending.revision || 0)) {
        throw error("TC_STORE_PENDING_UNCOMMITTED", "待恢复操作尚未写入完整图表状态，不能自动提交。");
      }
      delete index.pending[chartId];
      await write([[INDEX_KEY, index]]);
      return clone(record);
    }

    async function migrateLegacy(name) {
      const migrated = loadLegacy(name);
      if (!migrated) return null;
      if (migrated.readOnly) throw error("TC_STORE_FUTURE_VERSION", "旧图表状态由更高版本插件创建，当前版本不能迁移。");
      const record = clone(migrated);
      if (!record.chartId) record.chartId = state.createChartId();
      record.meta = Object.assign({}, record.meta, { legacyKey: name });
      return save(record);
    }

    function classifyRecords() {
      const index = readIndex(false);
      const records = Object.keys(index.charts || {}).map((chartId) => ({ chartId, record: load(chartId) }));
      const legacyNames = available() && Array.isArray(settings.get(LEGACY_INDEX_KEY)) ? clone(settings.get(LEGACY_INDEX_KEY)) : [];
      return { records, pending: clone(index.pending || {}), legacyNames };
    }

    return Object.freeze({
      load, save, beginPending, commitPending, clearPending, recoverPending, loadLegacy, migrateLegacy, classifyRecords,
      chartKey, indexKey: INDEX_KEY,
    });
  }

  return Object.freeze({
    create, reconcileIdentities, maintenanceReport, editDisposition, diagnosticSummary,
    INDEX_KEY, LEGACY_INDEX_KEY, CHART_KEY_PREFIX,
  });
}));
