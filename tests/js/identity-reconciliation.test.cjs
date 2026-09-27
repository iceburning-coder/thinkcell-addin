const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

loadScript("tc-state.js");
const Store = loadScript("tc-store.js");
const OfficeAdapter = loadScript("tc-office.js");

const A = "4eb927f0-c3fa-4ab8-a828-6c809ad19857";
const B = "b13891c2-9330-4d42-9854-32c6f06a35ae";
const C = "fc79af7e-5789-4dd9-a65f-930f35935d4f";
const D = "f3216668-78c0-40fd-89d5-6929e1d257ae";

function record(chartId, revision, meta = {}) { return { chartId, revision, meta }; }
function shape(hostRef, name, chartId, revision, pendingToken = null) {
  return { hostRef, name, chartId, revision, pendingToken };
}

test("PowerPoint and Excel identity metadata round-trip independently of shape names", () => {
  const ppt = OfficeAdapter.powerPointIdentity({ TC_CHART_ID: A, TC_REVISION: "7", TC_PENDING: "op-1" }, "Renamed");
  assert.deepEqual(ppt, { chartId: A, revision: 7, pendingToken: "op-1", source: "tag" });

  const encoded = OfficeAdapter.encodeExcelIdentity({ chartId: A, revision: 7, pendingToken: "op-1", title: "收入" });
  assert.deepEqual(OfficeAdapter.parseExcelIdentity(encoded), {
    chartId: A, revision: 7, pendingToken: "op-1", title: "收入", source: "altText",
  });
});

test("legacy TC names remain a fallback but arbitrary names are untracked", () => {
  assert.deepEqual(OfficeAdapter.powerPointIdentity({}, `TC:${A}`), { chartId: A, revision: 0, pendingToken: null, source: "name" });
  assert.equal(OfficeAdapter.powerPointIdentity({}, "Renamed"), null);
  assert.equal(OfficeAdapter.parseExcelIdentity("ordinary alt text"), null);
});

test("reconciliation adopts a renamed sole survivor and reports deleted originals as orphans", () => {
  const result = Store.reconcileIdentities(
    [record(A, 3, { hostRef: "ppt:slide-1:shape-1" }), record(B, 1, { hostRef: "ppt:slide-1:shape-2" })],
    [shape("ppt:slide-1:shape-1", "User renamed this", A, 3)],
    {},
  );

  assert.deepEqual(result.matches.map((x) => x.chartId), [A]);
  assert.equal(result.matches[0].renamed, true);
  assert.deepEqual(result.orphans.map((x) => x.chartId), [B]);
});

test("a copied duplicate is forked while the recorded host reference remains canonical", () => {
  const result = Store.reconcileIdentities(
    [record(C, 4, { hostRef: "xl:sheet-1:shape-1" })],
    [
      shape("xl:sheet-1:shape-1", `TC:${C}`, C, 4),
      shape("xl:sheet-1:shape-copy", `TC:${C}`, C, 4),
    ],
    {},
  );

  assert.equal(result.matches[0].shape.hostRef, "xl:sheet-1:shape-1");
  assert.deepEqual(result.forks.map((x) => x.shape.hostRef), ["xl:sheet-1:shape-copy"]);
  assert.notEqual(result.forks[0].forkRecord.chartId, C);
  assert.equal(result.forks[0].forkRecord.meta.forkedFrom, C);
  assert.equal(result.duplicates.length, 0);
  assert.equal(Store.editDisposition(result, "xl:sheet-1:shape-copy").action, "fork");
  assert.equal(Store.editDisposition(result, "xl:sheet-1:shape-1").action, "keep");
});

test("pending crash recovery prefers the highest committed revision without deleting the survivor", () => {
  const result = Store.reconcileIdentities(
    [record(D, 3, { hostRef: "ppt:s1:old" })],
    [shape("ppt:s1:old", `TC:${D}`, D, 2), shape("ppt:s1:new", `TC:${D}`, D, 3, "op-3")],
    { [D]: { chartId: D, revision: 3, token: "op-3" } },
  );

  assert.equal(result.matches[0].shape.hostRef, "ppt:s1:new");
  assert.equal(result.pendingRecoveries[0].chartId, D);
  assert.equal(result.autoDelete.length, 0);
});

test("ambiguous duplicates and untracked TC shapes are surfaced without automatic deletion", () => {
  const result = Store.reconcileIdentities(
    [record(A, 2)],
    [shape("one", `TC:${A}`, A, 2), shape("two", `TC:${A}`, A, 2), shape("legacy", "TC:unknown", null, 0)],
    {},
  );

  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.untracked.map((x) => x.hostRef), ["legacy"]);
  assert.deepEqual(result.autoDelete, []);
  assert.equal(Store.editDisposition(result, "one").action, "ambiguous");
});
