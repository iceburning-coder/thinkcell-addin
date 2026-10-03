const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const State = loadScript("tc-state.js");
const Store = loadScript("tc-store.js");

const A = "4eb927f0-c3fa-4ab8-a828-6c809ad19857";
const B = "b13891c2-9330-4d42-9854-32c6f06a35ae";
const C = "fc79af7e-5789-4dd9-a65f-930f35935d4f";
const D = "f3216668-78c0-40fd-89d5-6929e1d257ae";

function record(chartId, revision, overrides = {}) {
  return {
    version: 3, chartId, revision,
    chart: { type: "column", data: "Category\tValue\nSecret\t42", title: "Secret title" },
    link: null, meta: {}, ...overrides,
  };
}

function shape(hostRef, name, chartId, revision) { return { hostRef, name, chartId, revision }; }

function fakeSettings(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key), set: (key, value) => values.set(key, value), remove: (key) => values.delete(key),
    saveAsync: (callback) => callback({ status: "succeeded" }),
  };
}

const office = { AsyncResultStatus: { Succeeded: "succeeded" } };

test("maintenance report classifies recoverable state without deleting anything", () => {
  const records = [
    record(A, 3, { meta: { hostRef: "a" } }),
    record(B, 1, { link: { kind: "workbook-name", status: "broken", error: { code: "TC_LINK_REF" } } }),
    record(C, 2),
    record(D, 1, { meta: { hostRef: "d", legacyKey: "TC:old" } }),
  ];
  const shapes = [
    shape("a", `TC:${A}`, A, 3),
    shape("c1", `TC:${C}`, C, 2), shape("c2", `TC:${C}`, C, 2),
    shape("d", `TC:${D}`, D, 1), shape("loose", "TC:legacy", null, 0),
  ];
  const pending = { [A]: { chartId: A, revision: 3, token: "op-3" } };

  const report = Store.maintenanceReport({ records, shapes, pending, legacyNames: ["TC:old"] });

  assert.deepEqual(report.pending.map((item) => item.chartId), [A]);
  assert.deepEqual(report.orphans.map((item) => item.chartId), [B]);
  assert.equal(report.duplicates.length, 1);
  assert.deepEqual(report.untracked.map((item) => item.hostRef), ["loose"]);
  assert.deepEqual(report.brokenLinks.map((item) => item.chartId), [B]);
  assert.deepEqual(report.migratedLegacy.map((item) => item.chartId), [D]);
  assert.deepEqual(report.legacyKeys, ["TC:old"]);
  assert.deepEqual(report.autoDelete, []);
});

test("diagnostic summary includes versions, capabilities and error codes but no chart data", () => {
  const report = Store.maintenanceReport({
    records: [record(B, 1, { link: { kind: "workbook-name", status: "broken", error: { code: "TC_LINK_REF" } } })],
    shapes: [], pending: {}, legacyNames: [],
  });
  const summary = Store.diagnosticSummary({ addinVersion: "1.2.3", engineVersion: "1", host: "xl", capabilities: { excelSvg: true }, report });
  const json = JSON.stringify(summary);

  assert.equal(summary.addinVersion, "1.2.3");
  assert.deepEqual(summary.capabilities, { excelSvg: true });
  assert.deepEqual(summary.errorCodes, ["TC_LINK_REF"]);
  assert.doesNotMatch(json, /Secret title|Secret|42/);
});

test("pending recovery only clears a marker after its revision is durably stored", async () => {
  const committed = record(A, 3);
  const settings = fakeSettings({
    [`TC:chart:${A}`]: committed,
    "TC:index:v3": { version: 3, charts: { [A]: { revision: 3 } }, pending: { [A]: { chartId: A, revision: 3, token: "op-3" } } },
  });
  const store = Store.create(settings, { state: State, office });

  const recovered = await store.recoverPending(A);
  assert.equal(recovered.revision, 3);
  assert.equal(store.classifyRecords().pending[A], undefined);

  const staleSettings = fakeSettings({
    [`TC:chart:${A}`]: record(A, 2),
    "TC:index:v3": { version: 3, charts: { [A]: { revision: 2 } }, pending: { [A]: { chartId: A, revision: 3, token: "op-3" } } },
  });
  const staleStore = Store.create(staleSettings, { state: State, office });
  await assert.rejects(staleStore.recoverPending(A), (error) => error.code === "TC_STORE_PENDING_UNCOMMITTED");
  assert.ok(staleStore.classifyRecords().pending[A]);
});

