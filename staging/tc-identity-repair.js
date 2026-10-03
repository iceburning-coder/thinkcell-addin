(function initIdentityRepairModule(root, factory) {
  "use strict";
  const api = factory(root);
  root.TC = root.TC || {};
  root.TC.IdentityRepair = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : window, function createIdentityRepairModule(root) {
  "use strict";

  function identityError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function dispositionFor(report, hostRef) {
    const Store = root.TC && root.TC.Store;
    if (!Store) throw identityError("TC_IDENTITY_STORE_UNAVAILABLE", "图表身份服务不可用。");
    return Store.editDisposition(report || {}, hostRef);
  }

  function ambiguousIdentity() {
    return identityError(
      "TC_IDENTITY_AMBIGUOUS",
      "该图表与多个副本共用标识，无法判断原件；请在“文档状态与恢复”中检查",
    );
  }

  function inspectIdentityForEdit(options) {
    const input = options || {};
    const disposition = dispositionFor(input.report, input.hostRef);
    if (disposition.action === "ambiguous") throw ambiguousIdentity();
    if (disposition.action === "keep") return { action: "keep" };
    if (disposition.action !== "fork") {
      throw identityError("TC_IDENTITY_CHANGED", "无法安全确认所选图表身份，请在“文档状态与恢复”中检查。");
    }
    const item = disposition.item;
    if (!item.forkRecord || !item.forkRecord.chartId) {
      throw identityError("TC_IDENTITY_REPAIR_UNAVAILABLE", "当前环境不能安全生成图表副本标识。");
    }
    return {
      action: "fork-on-save",
      hostRef: input.hostRef,
      sourceChartId: item.record.chartId,
      expectedRevision: item.record.revision,
      chartId: item.forkRecord.chartId,
    };
  }

  function confirmForkForSave(options) {
    const input = options || {};
    const session = input.session || {};
    if (session.action !== "fork-on-save") {
      throw identityError("TC_IDENTITY_CHANGED", "图表副本状态已经变化，请重新载入后再试。");
    }
    const disposition = dispositionFor(input.report, session.hostRef);
    if (disposition.action === "ambiguous") throw ambiguousIdentity();
    if (disposition.action !== "fork" || !disposition.item || !disposition.item.record
        || disposition.item.record.chartId !== session.sourceChartId) {
      throw identityError("TC_IDENTITY_CHANGED", "图表副本状态已经变化，请重新载入后再试。");
    }
    if (disposition.item.record.revision !== session.expectedRevision) {
      throw identityError("TC_IDENTITY_REVISION_CONFLICT", "原图已被其他窗口更新，请重新载入副本后再试。");
    }
    return {
      chartId: session.chartId,
      sourceChartId: session.sourceChartId,
      sourceRevision: session.expectedRevision,
      hostRef: session.hostRef,
    };
  }

  function prepareForkedRecord(options) {
    const input = options || {};
    const fork = input.fork || {};
    if (!input.panelRecord || !fork.chartId || !fork.sourceChartId) {
      throw identityError("TC_IDENTITY_REPAIR_UNAVAILABLE", "当前环境不能安全生成图表副本记录。");
    }
    const record = clone(input.panelRecord);
    record.chartId = fork.chartId;
    record.meta = Object.assign({}, record.meta || {}, { forkedFrom: fork.sourceChartId });
    delete record.meta.hostRef;
    delete record.meta.hostName;
    return record;
  }

  async function ensureUniqueIdentityForEdit(options) {
    const input = options || {};
    const disposition = dispositionFor(input.report, input.hostRef);
    if (disposition.action === "ambiguous") throw ambiguousIdentity();
    if (disposition.action !== "fork") return null;
    if (!input.store || typeof input.store.save !== "function" || typeof input.retag !== "function") {
      throw identityError("TC_IDENTITY_REPAIR_UNAVAILABLE", "当前环境不能安全拆分图表副本。");
    }

    const item = disposition.item;
    const record = clone(item.forkRecord);
    const shape = clone(item.shape);
    const nameForChart = typeof input.nameForChart === "function"
      ? input.nameForChart
      : (chartId) => `TC:${chartId}`;
    const name = nameForChart(record.chartId);
    record.meta = Object.assign({}, record.meta || {}, { hostName: name, hostRef: shape.hostRef });
    await input.store.save(record);
    try {
      await input.retag({ shape, record, name });
    } catch (error) {
      error.persisted = true;
      throw error;
    }
    return { record, name, shape };
  }

  return Object.freeze({ inspectIdentityForEdit, confirmForkForSave, prepareForkedRecord, ensureUniqueIdentityForEdit });
}));
