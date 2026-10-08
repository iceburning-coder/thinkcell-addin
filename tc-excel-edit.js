(function initExcelEditModule(root, factory) {
  "use strict";
  const api = factory(root);
  root.TC = root.TC || {};
  root.TC.ExcelEdit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : window, function createExcelEditModule(root) {
  "use strict";

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function error(code, message, details) {
    const result = new Error(message);
    result.code = code;
    if (details !== undefined) result.details = details;
    return result;
  }

  function dependencies() {
    const TC = root.TC || {};
    if (!TC.Link || !TC.IdentityRepair) {
      throw error("TC_EXCEL_EDIT_UNAVAILABLE", "Excel 图表编辑服务尚未加载。");
    }
    return TC;
  }

  function dataChanged(previousData, nextData, parseGrid) {
    const TC = dependencies();
    if (typeof parseGrid !== "function") throw error("TC_EXCEL_GRID_PARSER", "Excel 数据比较缺少表格解析器。");
    return TC.Link.stableValueHash(parseGrid(String(previousData || "")))
      !== TC.Link.stableValueHash(parseGrid(String(nextData || "")));
  }

  function addressKey(address) {
    const TC = dependencies();
    const parsed = TC.Link.splitAddress(address);
    return `${String(parsed.sheet || "").trim().toUpperCase()}!${String(parsed.range || "")
      .replace(/\$/g, "").replace(/\s/g, "").toUpperCase()}`;
  }

  function countOtherChartsSharingAddress(records, chartId, lastAddress) {
    if (!String(lastAddress || "").trim()) return 0;
    const target = addressKey(lastAddress);
    return Array.from(records || []).filter((record) => {
      const link = record && record.link;
      return record && record.chartId !== chartId && link && link.status !== "broken"
        && String(link.lastAddress || "").trim() && addressKey(link.lastAddress) === target;
    }).length;
  }

  function ensureResult(value) {
    if (value && Object.prototype.hasOwnProperty.call(value, "link")) return value;
    return { link: value || null, createdName: null };
  }

  function createPanelConfirmation(elements) {
    const input = elements || {};
    const required = [input.container, input.message, input.accept, input.cancel];
    if (required.some((element) => !element || typeof element.addEventListener !== "function")) {
      throw error("TC_PANEL_CONFIRMATION_UI", "写回确认控件不可用。");
    }
    let pending = null;
    const settle = (accepted) => {
      if (!pending) return;
      const current = pending; pending = null;
      input.container.classList.add("hide");
      current.resolve(accepted);
    };
    input.accept.addEventListener("click", () => settle(true));
    input.cancel.addEventListener("click", () => settle(false));
    return Object.freeze({
      request(message) {
        if (pending) settle(false);
        input.message.textContent = String(message || "");
        input.container.classList.remove("hide");
        if (typeof input.container.scrollIntoView === "function") {
          input.container.scrollIntoView({ block: "nearest" });
        }
        if (typeof input.accept.focus === "function") input.accept.focus();
        if (typeof input.onRequest === "function") {
          input.onRequest("请在面板顶部确认是否写回共享区域");
        }
        return new Promise((resolve) => { pending = { resolve }; });
      },
      cancel() { settle(false); },
    });
  }

  async function resolveForDecision(link, resolveLink) {
    if (!link || typeof link === "string" || link.kind === "legacy-address") return clone(link);
    if (link.kind !== "workbook-name") return clone(link);
    if (typeof resolveLink !== "function") throw error("TC_LINK_OPERATIONS", "Excel 链接缺少解析操作。");
    const resolved = await resolveLink(link);
    if (!resolved || resolved.status === "broken") {
      const failure = error("TC_LINK_REF", "Excel 链接已失效；现有图表和最后一次数据已保留。");
      failure.link = resolved;
      throw failure;
    }
    return resolved;
  }

  async function runForkOnSave(options) {
    const input = options || {};
    const TC = dependencies();
    if (!input.previousRecord || !input.panelState) {
      throw error("TC_EXCEL_EDIT_INPUT", "Excel 图表更新缺少原记录或面板状态。");
    }
    for (const name of ["prepareRecord", "persistAndReplace"]) {
      if (typeof input[name] !== "function") throw error("TC_EXCEL_EDIT_OPERATIONS", `Excel 图表更新缺少 ${name} 操作。`);
    }

    const session = input.session || { action: "keep" };
    const fork = session.action === "fork-on-save"
      ? await input.confirmFork(session) : null;
    let record = input.prepareRecord({ fork, panel: input.panelState, previousRecord: input.previousRecord });
    if (fork) {
      const prepareForked = input.prepareForkedRecord || TC.IdentityRepair.prepareForkedRecord;
      record = prepareForked({ panelRecord: record, fork });
    }

    const sourceLink = input.link !== undefined ? input.link : input.previousRecord.link;
    record.link = await resolveForDecision(sourceLink, input.resolveLink);
    const changed = dataChanged(
      input.previousRecord.chart && input.previousRecord.chart.data,
      input.panelState.data,
      input.parseGrid,
    );
    const writeback = !!input.previousRecord.link && changed;
    if (TC.IdentityRepair.requiresSharedLinkWritebackConfirmation({
      session, link: writeback ? record.link : null, dataChanged: writeback,
    })) {
      if (typeof input.confirmSharedWriteback !== "function") {
        throw error("TC_LINK_CONFIRMATION_REQUIRED", "写回共享数据区域前必须取得用户确认。");
      }
      const accepted = await input.confirmSharedWriteback({
        sourceChartId: session.sourceChartId, link: clone(record.link), dataChanged: changed,
      });
      if (!accepted) return {
        cancelled: true, record: null, result: null, dataChanged: changed, writeback,
      };
    }

    let createdName = null;
    if (record.link) {
      if (typeof input.ensureLink !== "function") throw error("TC_LINK_OPERATIONS", "Excel 链接缺少保存操作。");
      const ensured = ensureResult(await input.ensureLink(record));
      record.link = ensured.link;
      createdName = ensured.createdName || null;
    } else {
      delete record.link;
    }

    try {
      const result = await input.persistAndReplace({ record, dataChanged: changed, writeback });
      return { cancelled: false, record, result, dataChanged: changed, writeback };
    } catch (failure) {
      if (createdName && !failure.persisted && typeof input.rollbackLink === "function") {
        try { await input.rollbackLink(createdName); }
        catch (rollbackError) { failure.linkRollbackError = rollbackError; }
      }
      throw failure;
    }
  }

  async function executeUpdate(options) {
    const input = options || {};
    const TC = dependencies();
    let writtenAddress = null;
    const outcome = await runForkOnSave(Object.assign({}, input, {
      persistAndReplace: async ({ record, dataChanged, writeback }) => {
        if (typeof input.replace !== "function") {
          throw error("TC_EXCEL_EDIT_OPERATIONS", "Excel 图表更新缺少 replace 操作。");
        }
        const replace = () => input.replace(record);
        if (!writeback) return replace();
        if (typeof input.writeGrid !== "function" || typeof input.setLink !== "function"
            || !input.echoes || !input.refreshes) {
          throw error("TC_EXCEL_EDIT_OPERATIONS", "Excel 共享数据写回操作不完整。");
        }
        return TC.Link.withWritebackRecovery({
          chartId: record.chartId,
          payload: Object.assign({}, input.payload || {}, { revision: record.revision }),
          echoes: input.echoes,
          refreshes: input.refreshes,
          shouldScheduleRefresh: (failure) => failure && failure.persisted === true,
          replace: async () => {
            const address = await input.writeGrid(
              input.parseGrid(input.panelState.data), record.link.lastAddress, { chartId: record.chartId },
            );
            record.link = await input.setLink(record.chartId, address);
            writtenAddress = record.link.lastAddress;
            return replace();
          },
        });
      },
    }));
    return Object.assign(outcome, { writtenAddress });
  }

  return Object.freeze({
    dataChanged, countOtherChartsSharingAddress, createPanelConfirmation, runForkOnSave, executeUpdate,
  });
}));
