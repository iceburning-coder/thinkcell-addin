const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const State = loadScript("tc-state.js");

function chart(overrides = {}) {
  return {
    type: "column",
    data: "Category\tValue\nA\t1",
    title: "Revenue",
    subtitle: "",
    source: "",
    theme: "consulting",
    dec: "",
    size: "680x400",
    legend: "auto",
    legendRev: false,
    mag: "1",
    opt: {},
    ann: {},
    colors: {},
    json: null,
    ...overrides,
  };
}

test("migrates a flat v2 panel state into a v3 envelope without persisting an id", () => {
  const migrated = State.migrate({ v: 2, ...chart(), sel: "Sheet1!A1:B2" });

  assert.equal(migrated.version, 3);
  assert.equal(migrated.chartId, null);
  assert.equal(migrated.revision, 0);
  assert.deepEqual(migrated.chart, chart());
  assert.equal(migrated.link, null);
});

test("normalizes a v3 record without changing its durable fields", () => {
  const original = {
    version: 3,
    chartId: "4eb927f0-c3fa-4ab8-a828-6c809ad19857",
    revision: 12,
    chart: chart({ title: "市场增长" }),
    link: null,
    meta: { engineVersion: "1", updatedAt: "2026-09-27T00:00:00.000Z" },
  };

  assert.deepEqual(State.normalize(original), original);
});

test("preserves a legacy Excel address and sheet outside the migrated chart payload", () => {
  const migrated = State.migrate({ v: 2, ...chart(), link: "Sales!A1:B2", sheet: "Sales" });

  assert.deepEqual(migrated.link, { kind: "legacy-address", address: "Sales!A1:B2", sheet: "Sales" });
  assert.equal(migrated.meta.sheet, "Sales");
  assert.equal(migrated.chart.link, undefined);
});

test("opens a future record read-only and refuses to normalize it for writing", () => {
  const future = { version: 4, chartId: null, revision: 1, chart: chart(), link: null, meta: {} };

  const opened = State.normalize(future, { mode: "read" });
  assert.equal(opened.readOnly, true);
  assert.equal(opened.version, 4);
  assert.throws(() => State.normalize(future, { mode: "write" }), (error) => error.code === "TC_STATE_FUTURE_VERSION");
});

test("creates RFC 4122 version-4 chart ids", () => {
  assert.match(State.createChartId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
