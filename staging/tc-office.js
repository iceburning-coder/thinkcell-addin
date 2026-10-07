(function initOfficeModule(root, factory) {
  "use strict";
  const api = factory();
  root.TC = root.TC || {};
  root.TC.Office = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : window, function createOfficeModule() {
  "use strict";

  function errorWithCode(code, message, original) {
    const error = original instanceof Error ? original : new Error((original && original.message) || message || code);
    error.code = (original && original.code) || code;
    if (!error.message) error.message = message || code;
    return error;
  }

  function supports(office, name, version) {
    try {
      const requirements = office && office.context && office.context.requirements;
      return !!(requirements && typeof requirements.isSetSupported === "function" && requirements.isSetSupported(name, version));
    } catch (error) {
      return false;
    }
  }

  function getCapabilities(office, host) {
    const ppt12 = host === "ppt" && supports(office, "PowerPointApi", "1.2");
    const ppt14 = host === "ppt" && supports(office, "PowerPointApi", "1.4");
    const ppt15 = host === "ppt" && supports(office, "PowerPointApi", "1.5");
    const ppt18 = host === "ppt" && supports(office, "PowerPointApi", "1.8");
    const excel19 = host === "xl" && supports(office, "ExcelApi", "1.9");
    const excel17 = host === "xl" && (excel19 || supports(office, "ExcelApi", "1.7"));
    return {
      imageInsertion: host === "ppt" || host === "xl",
      svgInsertion: host === "ppt" && supports(office, "ImageCoercion", "1.2"),
      powerPointSlides: ppt12,
      powerPointShapes: ppt14,
      powerPointShapeMetadata: ppt14,
      powerPointSelection: ppt15,
      powerPointGroups: ppt18,
      excelShapes: excel19,
      excelSvg: excel19,
      excelCollectionEvents: excel19,
      excelWorksheetEvents: excel17,
    };
  }

  function capabilityGate(capabilities, capability, options) {
    const opts = options || {};
    const supported = !!(capabilities && capabilities[capability]);
    const waitingForChart = !!opts.requiresChart && !opts.hasChart;
    return {
      disabled: !supported || !!opts.busy || waitingForChart,
      title: supported ? "" : String(opts.reason || ""),
    };
  }

  function createBusyTracker(onChange) {
    let active = 0;
    const notify = () => { if (typeof onChange === "function") onChange(active > 0, active); };
    return Object.freeze({
      begin() {
        active += 1; notify();
        let ended = false;
        return () => {
          if (ended) return;
          ended = true; active = Math.max(0, active - 1); notify();
        };
      },
      isBusy() { return active > 0; },
      count() { return active; },
    });
  }

  function createFreshnessTracker(onChange) {
    let fresh = false;
    const set = (next) => {
      if (fresh === next) return;
      fresh = next;
      if (typeof onChange === "function") onChange(fresh);
    };
    return Object.freeze({
      invalidate() { set(false); },
      publish() { set(true); },
      isFresh() { return fresh; },
    });
  }

  function fromAsyncResult(register, office) {
    return new Promise((resolve, reject) => {
      try {
        register((result) => {
          const succeeded = office && office.AsyncResultStatus ? office.AsyncResultStatus.Succeeded : "succeeded";
          if (result && result.status === succeeded) resolve(result.value);
          else reject(errorWithCode("TC_OFFICE_ASYNC_FAILED", "Office 操作失败。", result && result.error));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function saveSettings(settings, office) {
    if (!settings || typeof settings.saveAsync !== "function") {
      return Promise.reject(errorWithCode("TC_OFFICE_SETTINGS_UNAVAILABLE", "当前文档不支持保存图表状态。"));
    }
    return fromAsyncResult((callback) => settings.saveAsync(callback), office);
  }

  function runHost(api, callback, label) {
    if (!api || typeof api.run !== "function") {
      return Promise.reject(errorWithCode("TC_OFFICE_UNSUPPORTED", `当前环境不支持 ${label} API。`));
    }
    try { return Promise.resolve(api.run(callback)); }
    catch (error) { return Promise.reject(error); }
  }

  function runPowerPoint(powerPoint, callback) {
    return runHost(powerPoint, callback, "PowerPoint");
  }

  function runExcel(excel, callback) {
    return runHost(excel, callback, "Excel");
  }

  function annotatePhase(error, phase, persisted) {
    const result = error instanceof Error ? error : new Error(String(error || `${phase} failed`));
    result.phase = phase;
    result.persisted = !!persisted;
    if (persisted) result.recoverableDuplicate = true;
    return result;
  }

  async function finishPendingCleanup(result, cleanup) {
    try { await cleanup(); }
    catch (error) {
      if (result && typeof result === "object") {
        result.pendingCleanupWarning = {
          code: String((error && error.code) || "TC_PENDING_CLEANUP_FAILED"),
          message: String((error && error.message) || "未完成操作标记清理失败。"),
        };
      }
    }
    return result;
  }

  function resolveInsertedShapeId(beforeIds, allIds, selectedIds) {
    const before = beforeIds instanceof Set ? beforeIds : new Set(beforeIds || []);
    const all = Array.from(allIds || []);
    const allSet = new Set(all);
    const selected = Array.from(selectedIds || []);
    const selectedNew = selected.filter((id) => allSet.has(id) && !before.has(id));
    if (selectedNew.length === 1) return selectedNew[0];
    const delta = all.filter((id) => !before.has(id));
    if (delta.length === 1) return delta[0];
    const error = errorWithCode(
      "TC_PPT_INSERT_AMBIGUOUS",
      `无法唯一识别刚插入的 PowerPoint 形状（插入前 ${before.size}，当前 ${all.length}，选中新对象 ${selectedNew.length}，新增 ${delta.length}）。`,
    );
    error.details = {
      beforeIds: Array.from(before), allIds: all, selectedIds: selected,
      selectedCandidateIds: selectedNew, deltaIds: delta,
    };
    throw error;
  }

  function selectedShapeIdsOnSlide(targetSlideId, selectedSlideIds, selectedShapeIds) {
    const slides = Array.from(selectedSlideIds || []);
    return slides.length === 1 && slides[0] === targetSlideId ? Array.from(selectedShapeIds || []) : [];
  }

  function excelHostRef(worksheetId, shapeId) {
    return `xl:${String(worksheetId || "")}:${String(shapeId || "")}`;
  }

  function powerPointSlideInsertionMode(capabilities) {
    if (!capabilities || !capabilities.powerPointSlides) return "unsupported";
    return capabilities.powerPointShapes ? "tracked" : "untracked";
  }

  function resolveOwnedInsertedSlideId(beforeIds, slides, expectedShapeName) {
    const before = beforeIds instanceof Set ? beforeIds : new Set(beforeIds || []);
    const added = Array.from(slides || []).filter((slide) => slide && !before.has(slide.id));
    const owned = added.filter((slide) => Array.from(slide.shapeNames || []).includes(expectedShapeName));
    if (owned.length === 1) return owned[0].id;
    throw errorWithCode(
      "TC_PPT_SLIDE_OWNERSHIP_AMBIGUOUS",
      `无法安全确认待清理幻灯片的归属（新增 ${added.length} 张，含目标图表 ${owned.length} 张）。`,
    );
  }

  function chartSelectionMode(editing, selected) {
    if (!editing) return selected ? "selected" : "none";
    if (!selected) return "editing";
    const editingChartId = String(editing.chartId || "");
    const selectedChartId = String(selected.chartId || "");
    const sameIdentity = editingChartId && selectedChartId
      ? editingChartId === selectedChartId
      : String(editing.name || "") === String(selected.name || "");
    const sameShape = editing.id && selected.id ? String(editing.id) === String(selected.id) : true;
    return sameIdentity && sameShape ? "editing" : "switch";
  }

  function captureChartOutput(output) {
    if (!output || typeof output.svg !== "string" || !Number.isFinite(output.width) || !Number.isFinite(output.height)) {
      throw errorWithCode("TC_RENDER_SNAPSHOT_INVALID", "当前没有可用的图表渲染结果。");
    }
    return Object.freeze({ svg: output.svg, width: output.width, height: output.height });
  }

  async function preparePptReplacement(adapter) {
    try { return await adapter.snapshot(); }
    catch (error) { throw annotatePhase(error, "snapshot", false); }
  }

  async function insertPendingPptShape(adapter, prepared) {
    try { await adapter.insert(prepared); }
    catch (error) { throw annotatePhase(error, "insert", false); }
    try { return await adapter.identify(prepared); }
    catch (error) { throw annotatePhase(error, "identify", false); }
  }

  async function commitPptReplacement(adapter, prepared, pending) {
    try { await adapter.persist(prepared, pending); }
    catch (error) { throw annotatePhase(error, "persist", false); }
    try { await adapter.renameAndTag(prepared, pending); }
    catch (error) { throw annotatePhase(error, "rename", true); }
    try { await adapter.deleteOld(prepared, pending); }
    catch (error) { throw annotatePhase(error, "delete", true); }
    return { prepared, pending };
  }

  async function replacePowerPointChart(adapter) {
    const prepared = await preparePptReplacement(adapter);
    let pending = null;
    let insertStarted = false;
    try {
      insertStarted = true;
      pending = await insertPendingPptShape(adapter, prepared);
      return await commitPptReplacement(adapter, prepared, pending);
    } catch (error) {
      if (!error.persisted && insertStarted && typeof adapter.cleanupPending === "function") {
        try { await adapter.cleanupPending(prepared, pending); }
        catch (cleanupError) { error.cleanupError = cleanupError; error.retainPending = true; }
      }
      throw error;
    }
  }

  async function insertPowerPointSlide(adapter) {
    let prepared;
    try { prepared = await adapter.snapshot(); }
    catch (error) { throw annotatePhase(error, "snapshot", false); }
    let pending = null;
    let insertStarted = false;
    try {
      insertStarted = true;
      try { await adapter.insert(prepared); }
      catch (error) { throw annotatePhase(error, "insert", false); }
      try { pending = await adapter.identify(prepared); }
      catch (error) { throw annotatePhase(error, "identify", false); }
      try { await adapter.persist(prepared, pending); }
      catch (error) { throw annotatePhase(error, "persist", false); }
      try { await adapter.tag(prepared, pending); }
      catch (error) { throw annotatePhase(error, "tag", true); }
      return { prepared, pending };
    } catch (error) {
      if (!error.persisted && insertStarted && typeof adapter.cleanupPending === "function") {
        try { await adapter.cleanupPending(prepared, pending); }
        catch (cleanupError) { error.cleanupError = cleanupError; error.retainPending = true; }
      }
      throw error;
    }
  }

  const NATIVE_PALETTES = Object.freeze({
    consulting: Object.freeze(["#0B2D4F", "#1F5A8C", "#3F86C0", "#7FB2DC", "#B9D5EC"]),
    semi: Object.freeze(["#1F5A8C", "#A6A6A6", "#7FB2DC", "#595959", "#D9D9D9"]),
    dark: Object.freeze(["#5B9BD5", "#3F86C0", "#7FB2DC", "#B9D5EC", "#DDE9F5"]),
  });

  function resolvePalette(theme) {
    if (theme && typeof theme === "object" && Array.isArray(theme.SERIES) && theme.SERIES.length) {
      return theme.SERIES.slice();
    }
    const name = typeof theme === "string" ? theme : (theme && theme.base);
    return (NATIVE_PALETTES[name] || NATIVE_PALETTES.consulting).slice();
  }

  const CHART_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const EXCEL_IDENTITY_PREFIX = "TCCHART3:";

  function validIdentity(value, source) {
    if (!value || !CHART_ID_RE.test(String(value.chartId || ""))) return null;
    const revision = Number(value.revision || 0);
    if (!Number.isInteger(revision) || revision < 0) return null;
    return {
      chartId: String(value.chartId), revision,
      pendingToken: value.pendingToken ? String(value.pendingToken) : null,
      source,
    };
  }

  function powerPointIdentity(tags, name) {
    const values = tags || {};
    const tagged = validIdentity({
      chartId: values.TC_CHART_ID,
      revision: values.TC_REVISION,
      pendingToken: values.TC_PENDING,
    }, "tag");
    if (tagged) return tagged;
    const match = String(name || "").match(/^TC:([0-9a-f-]{36})$/i);
    return match ? validIdentity({ chartId: match[1], revision: 0 }, "name") : null;
  }

  function resolvePowerPointChartCandidate(candidates, loadRecord) {
    for (const shape of Array.from(candidates || [])) {
      const identity = powerPointIdentity(shape.tags, shape.name);
      const record = typeof loadRecord === "function" ? loadRecord(shape.name, identity && identity.chartId) : null;
      if (record && (identity || String(shape.name || "").startsWith("TC:"))) return { shape, identity, record };
    }
    return null;
  }

  function powerPointSelectionIssue(candidates, resolved) {
    if (resolved) return null;
    for (const shape of Array.from(candidates || [])) {
      if (!shape || shape.level !== 0) continue;
      const tags = shape && shape.tags ? shape.tags : {};
      const identity = powerPointIdentity(tags, shape && shape.name);
      const pluginMarker = identity
        || String((shape && shape.name) || "").startsWith("TC:")
        || Object.prototype.hasOwnProperty.call(tags, "TCCHART")
        || Object.prototype.hasOwnProperty.call(tags, "TC_CHART_ID")
        || Object.prototype.hasOwnProperty.call(tags, "TC_ELEMENT_ID");
      if (pluginMarker) {
        return {
          kind: "ungrouped",
          shapeId: String((shape && shape.id) || ""),
          chartId: identity ? identity.chartId : String(tags.TC_CHART_ID || ""),
        };
      }
    }
    return null;
  }

  function encodeExcelIdentity(identity) {
    const valid = validIdentity(identity, "altText");
    if (!valid) throw errorWithCode("TC_IDENTITY_INVALID", "Excel 图表标识格式不正确。");
    return EXCEL_IDENTITY_PREFIX + JSON.stringify({
      chartId: valid.chartId,
      revision: valid.revision,
      pendingToken: valid.pendingToken,
      title: String((identity && identity.title) || ""),
    });
  }

  function parseExcelIdentity(text) {
    const value = String(text || "");
    if (!value.startsWith(EXCEL_IDENTITY_PREFIX)) return null;
    try {
      const parsed = JSON.parse(value.slice(EXCEL_IDENTITY_PREFIX.length));
      const valid = validIdentity(parsed, "altText");
      return valid ? Object.assign(valid, { title: String(parsed.title || "") }) : null;
    } catch (error) { return null; }
  }

  async function insertExcelImageWithFallback(adapter, prepared) {
    let svgError = null;
    try {
      const pending = await adapter.insertSvg(prepared);
      return { pending, format: "svg" };
    } catch (error) {
      svgError = error;
    }
    if (typeof adapter.cleanupFailedSvg === "function") {
      try { await adapter.cleanupFailedSvg(prepared); }
      catch (error) {
        const result = annotatePhase(error, "insert", false);
        result.svgError = svgError;
        throw result;
      }
    }
    try {
      const pending = await adapter.insertPng(prepared);
      return { pending, format: "png", svgError };
    } catch (error) {
      const result = annotatePhase(error, "insert", false);
      result.svgError = svgError;
      throw result;
    }
  }

  async function commitExcelReplacement(adapter, prepared, pending) {
    try { await adapter.persist(prepared, pending); }
    catch (error) { throw annotatePhase(error, "persist", false); }
    try { await adapter.rename(prepared, pending); }
    catch (error) { throw annotatePhase(error, "rename", true); }
    try { await adapter.deleteOld(prepared, pending); }
    catch (error) { throw annotatePhase(error, "delete", true); }
  }

  async function replaceExcelChart(adapter) {
    let prepared;
    try { prepared = await adapter.snapshot(); }
    catch (error) { throw annotatePhase(error, "snapshot", false); }
    let inserted = null;
    try {
      inserted = await insertExcelImageWithFallback(adapter, prepared);
      await commitExcelReplacement(adapter, prepared, inserted.pending);
      return { prepared, pending: inserted.pending, format: inserted.format };
    } catch (error) {
      if (!error.persisted && typeof adapter.cleanupPending === "function") {
        try { await adapter.cleanupPending(prepared, inserted && inserted.pending); }
        catch (cleanupError) { error.cleanupError = cleanupError; error.retainPending = true; }
      }
      throw error;
    }
  }

  return Object.freeze({
    getCapabilities, capabilityGate, createBusyTracker, createFreshnessTracker,
    fromAsyncResult, saveSettings, runPowerPoint, runExcel, finishPendingCleanup,
    resolveInsertedShapeId, selectedShapeIdsOnSlide, excelHostRef, powerPointSlideInsertionMode,
    resolveOwnedInsertedSlideId, chartSelectionMode, captureChartOutput, preparePptReplacement, insertPendingPptShape,
    commitPptReplacement, replacePowerPointChart, insertPowerPointSlide,
    resolvePalette, insertExcelImageWithFallback, commitExcelReplacement, replaceExcelChart,
    powerPointIdentity, resolvePowerPointChartCandidate, powerPointSelectionIssue,
    encodeExcelIdentity, parseExcelIdentity, EXCEL_IDENTITY_PREFIX,
  });
}));
