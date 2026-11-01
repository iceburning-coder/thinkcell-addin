const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

require("../../tc-link.js");
require("../../tc-identity-repair.js");
const ExcelEdit = require("../../tc-excel-edit.js");

const SOURCE = "4eb927f0-c3fa-4ab8-a828-6c809ad19857";
const FORK = "6f1c2a44-2b7e-4d5a-9c31-0a6b8e7d4f21";
const FALLBACK = "未知单元格区域";

function confirmText(address) {
  return `这是复制出来的图表，仍与原图共享 ${address}。继续会把面板数据写回该区域，并同步影响原图。`;
}

function runUpdate(link, options) {
  const opts = options || {};
  const calls = {
    ensure: 0, write: 0, replace: 0, resolve: 0, confirm: 0,
    messages: [], ensuredLink: null, writtenAddress: null,
  };
  const previousRecord = {
    chartId: SOURCE,
    revision: 1,
    chart: { data: opts.previousData || "old" },
    link,
  };
  return ExcelEdit.executeUpdate({
    session: {
      action: "fork-on-save",
      hostRef: "ws/shape",
      sourceChartId: SOURCE,
      expectedRevision: 1,
      chartId: FORK,
    },
    previousRecord,
    panelState: { data: opts.panelData || "new" },
    link,
    parseGrid: (text) => String(text),
    confirmFork: async () => ({
      chartId: FORK, sourceChartId: SOURCE, sourceRevision: 1, hostRef: "ws/shape",
    }),
    prepareRecord: ({ panel }) => ({ chartId: SOURCE, revision: 2, chart: { data: panel.data } }),
    resolveLink: async (value) => {
      calls.resolve += 1;
      if (opts.resolveLink) return opts.resolveLink(value);
      throw new Error("resolveLink should not run");
    },
    confirmSharedWriteback: async ({ link: decisionLink }) => {
      calls.confirm += 1;
      calls.messages.push(ExcelEdit.sharedWritebackConfirmMessage(decisionLink));
      return opts.accept === true;
    },
    ensureLink: async (record) => {
      calls.ensure += 1;
      calls.ensuredLink = record.link;
      const address = typeof record.link === "string"
        ? record.link
        : (record.link && (record.link.address || record.link.lastAddress));
      return { link: { kind: "workbook-name", lastAddress: address, status: "ok" } };
    },
    writeGrid: async (_grid, address) => {
      calls.write += 1;
      calls.writtenAddress = address;
      return address;
    },
    setLink: async (_chartId, address) => ({ kind: "workbook-name", lastAddress: address, status: "ok" }),
    replace: async (record) => {
      calls.replace += 1;
      return { name: "TC:" + record.chartId, record };
    },
    echoes: { clear() {} },
    refreshes: { schedule() {} },
  }).then((outcome) => ({ outcome, calls }));
}

test("confirm copy uses a readable address for every stored link shape", () => {
  const workbook = {
    kind: "workbook-name",
    name: "TC_LINK_TEST",
    lastAddress: "Budget!A1:C3",
    address: "Old!A1",
    status: "ok",
  };
  const legacy = { kind: "legacy-address", address: "'Q1 Sales'!B2:D4", sheet: "Q1 Sales" };
  const legacyWithStaleLast = {
    kind: "legacy-address",
    address: "'Q1 Sales'!B2:D4",
    lastAddress: "Old!A1",
  };

  assert.equal(ExcelEdit.sharedWritebackConfirmMessage(workbook), confirmText("Budget!A1:C3"));
  assert.equal(ExcelEdit.sharedWritebackConfirmMessage("Sheet1!A1:B2"), confirmText("Sheet1!A1:B2"));
  assert.equal(ExcelEdit.sharedWritebackConfirmMessage(legacy), confirmText("'Q1 Sales'!B2:D4"));
  assert.equal(ExcelEdit.sharedWritebackConfirmMessage(legacyWithStaleLast), confirmText("'Q1 Sales'!B2:D4"));
  assert.equal(
    ExcelEdit.sharedWritebackConfirmMessage({ kind: "legacy-address", lastAddress: "Sheet1!A1:B2" }),
    confirmText("Sheet1!A1:B2"),
  );

  for (const link of [undefined, null, "", "   ", {}, { kind: "legacy-address" }, { kind: "workbook-name" }]) {
    const message = ExcelEdit.sharedWritebackConfirmMessage(link);
    assert.equal(message, confirmText(FALLBACK));
    assert.equal(message.includes("undefined"), false);
  }
});

test("string and legacy-address confirms show the cell address and cancel does not write", async () => {
  const legacy = { kind: "legacy-address", address: "'Q1 Sales'!B2:D4", sheet: "Q1 Sales" };
  const cases = [
    ["Sheet1!A1:B2", "Sheet1!A1:B2"],
    [legacy, "'Q1 Sales'!B2:D4"],
    [{ kind: "legacy-address" }, FALLBACK],
  ];
  for (const [link, address] of cases) {
    const { outcome, calls } = await runUpdate(link, { accept: false });
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.writtenAddress, null);
    assert.deepEqual(calls.messages, [confirmText(address)]);
    assert.equal(calls.confirm, 1);
    assert.equal(calls.resolve, 0);
    assert.equal(calls.ensure, 0);
    assert.equal(calls.write, 0);
    assert.equal(calls.replace, 0);
  }
});

test("workbook-name confirms keep the resolved lastAddress", async () => {
  const link = {
    kind: "workbook-name",
    name: "TC_LINK_TEST",
    worksheetId: "ws",
    sheet: "Budget",
    lastAddress: "Budget!A1:C3",
    status: "ok",
  };
  const { outcome, calls } = await runUpdate(link, {
    accept: false,
    resolveLink: async (value) => Object.assign({}, value, { lastAddress: "Budget!D1:F4", status: "ok" }),
  });
  assert.equal(outcome.cancelled, true);
  assert.deepEqual(calls.messages, [confirmText("Budget!D1:F4")]);
  assert.equal(calls.resolve, 1);
  assert.equal(calls.ensure, 0);
  assert.equal(calls.write, 0);
  assert.equal(calls.replace, 0);
});

test("accepting a string link still writes that address, and a blank link does not confirm", async () => {
  const accepted = await runUpdate("  Sheet1!A1:B2  ", { accept: true });
  assert.equal(accepted.outcome.cancelled, false);
  assert.equal(accepted.calls.confirm, 1);
  assert.equal(accepted.calls.messages[0], confirmText("Sheet1!A1:B2"));
  assert.equal(accepted.calls.ensure, 1);
  assert.equal(accepted.calls.ensuredLink, "  Sheet1!A1:B2  ");
  assert.equal(accepted.calls.write, 1);
  assert.equal(accepted.calls.writtenAddress, "  Sheet1!A1:B2  ");
  assert.equal(accepted.calls.replace, 1);

  const blank = await runUpdate("", { accept: true });
  assert.equal(blank.outcome.cancelled, false);
  assert.equal(blank.outcome.writeback, false);
  assert.equal(blank.calls.confirm, 0);
  assert.equal(blank.calls.ensure, 0);
  assert.equal(blank.calls.write, 0);
  assert.equal(blank.calls.replace, 1);
});

test("task pane confirm uses the shared message instead of lastAddress", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../taskpane.js"), "utf8");
  assert.match(source, /confirmSharedWriteback:\s*\(\{\s*link\s*\}\)\s*=>\s*XL_WRITEBACK_CONFIRM\.request\(\s*TC\.ExcelEdit\.sharedWritebackConfirmMessage\(link\),/);
  assert.doesNotMatch(source, /共享 \$\{link\.lastAddress\}/);
});
