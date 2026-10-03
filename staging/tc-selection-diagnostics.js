(function initSelectionDiagnostics(root, factory) {
  "use strict";
  const api = factory();
  root.TC = root.TC || {};
  root.TC.SelectionDiagnostics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : window, function createSelectionDiagnosticsModule() {
  "use strict";

  const MAX_ENTRIES = 200;

  function isEnabledValue(value) {
    return value === 1;
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function errorSummary(error) {
    if (!error) return null;
    return {
      code: String(error.code || error.name || "Error"),
      message: String(error.message || error),
    };
  }

  function safeShapeValue(shape, key) {
    try { return shape && shape[key] !== undefined ? shape[key] : null; }
    catch (e) { return null; }
  }

  async function traceShapeLineage(options) {
    const opts = options || {};
    const ctx = opts.ctx;
    const supportsGroups = opts.supportsGroups === true;
    const loggedCandidates = [];
    const parentTrace = [];
    let current = opts.shape || null;
    let requestedFromShapeId = null;

    for (let depth = 0; current && depth < 8; depth += 1) {
      try {
        current.load(supportsGroups ? "id,name,level" : "id,name");
        await ctx.sync();
      } catch (error) {
        const trace = {
          depth,
          shapeId: safeShapeValue(current, "id"),
          level: null,
          result: depth === 0 ? "load-error" : "parent-error",
          error: errorSummary(error),
        };
        if (requestedFromShapeId) trace.requestedFromShapeId = requestedFromShapeId;
        parentTrace.push(trace);
        return { candidates: [], loggedCandidates, parentTrace, failed: true };
      }

      const tags = {};
      let tagError = null;
      try {
        current.tags.load("items/key,items/value");
        await ctx.sync();
        current.tags.items.forEach((tag) => { tags[tag.key] = tag.value; });
      } catch (error) { tagError = errorSummary(error); }

      const candidate = {
        id: current.id,
        name: current.name,
        level: supportsGroups ? current.level : null,
        tags,
      };
      loggedCandidates.push(candidate);
      const trace = { depth, shapeId: current.id, level: candidate.level, result: "candidate" };
      if (tagError) trace.tagError = tagError;
      if (!supportsGroups) {
        trace.result = "unsupported-before-1.8";
        parentTrace.push(trace);
        break;
      }
      if (!current.level) {
        trace.result = "root";
        parentTrace.push(trace);
        break;
      }
      try {
        requestedFromShapeId = current.id;
        current = current.parentGroup;
        trace.result = "parent-requested";
      } catch (error) {
        trace.result = "parent-error";
        trace.error = errorSummary(error);
        current = null;
      }
      parentTrace.push(trace);
    }

    return { candidates: loggedCandidates, loggedCandidates, parentTrace, failed: false };
  }

  function createSelectionDiagnostics(options) {
    const opts = options || {};
    const now = typeof opts.now === "function" ? opts.now : () => Date.now();
    let enabled = opts.enabled === true;
    let latestIssued = 0;
    const entries = [];

    function begin(context) {
      const startedMs = now();
      latestIssued += 1;
      return {
        requestSeq: latestIssued,
        startedMs,
        context: clone(context || {}),
      };
    }

    function settle(request, outcome, apply) {
      const endedMs = now();
      const stale = !request || request.requestSeq !== latestIssued;
      const applied = !stale;
      if (applied && typeof apply === "function") apply();

      if (enabled && request) {
        const details = outcome || {};
        const context = request.context || {};
        const entry = {
          requestSeq: request.requestSeq,
          trigger: String(context.trigger || "unknown"),
          startedAt: new Date(request.startedMs).toISOString(),
          endedAt: new Date(endedMs).toISOString(),
          durationMs: Math.max(0, endedMs - request.startedMs),
          stale,
          applied,
          officeBuild: clone(context.officeBuild || null),
          requirementSets: clone(context.requirementSets || {}),
          slideId: details.slideId === undefined ? null : details.slideId,
          candidates: clone(details.candidates || []),
          parentTrace: clone(details.parentTrace || []),
          resolution: clone(details.resolution || null),
          error: errorSummary(details.error),
        };
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      }
      return { applied, stale };
    }

    return Object.freeze({
      begin,
      settle,
      setEnabled(value) { enabled = value === true; },
      isEnabled() { return enabled; },
      isLatest(request) { return !!request && request.requestSeq === latestIssued; },
      latestSequence() { return latestIssued; },
      snapshot() { return clone(entries); },
      clear() { entries.splice(0, entries.length); },
    });
  }

  return Object.freeze({ createSelectionDiagnostics, traceShapeLineage, isEnabledValue, MAX_ENTRIES });
}));
