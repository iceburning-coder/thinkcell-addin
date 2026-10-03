const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const State = loadScript("tc-state.js");
const Store = loadScript("tc-store.js");

function chartRecord(overrides = {}) {
  return {
    version: 3,
    chartId: "4eb927f0-c3fa-4ab8-a828-6c809ad19857",
    revision: 2,
    chart: { type: "column", data: "Category\tValue\nA\t1", title: "Revenue" },
    link: null,
    meta: {},
    ...overrides,
  };
}

function fakeSettings(initial = {}, failSave = false) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    remove: (key) => values.delete(key),
    saveAsync: (callback) => callback(failSave
      ? { status: "failed", error: { code: "SaveFailed", message: "disk" } }
      : { status: "succeeded" }),
  };
}

const office = { AsyncResultStatus: { Succeeded: "succeeded" } };

test("v3 store writes chart data and index metadata under stable keys", async () => {
  const settings = fakeSettings();
  const store = Store.create(settings, { state: State, office });

  const saved = await store.save(chartRecord());

  assert.equal(saved.chartId, "4eb927f0-c3fa-4ab8-a828-6c809ad19857");
  assert.deepEqual(settings.get("TC:chart:4eb927f0-c3fa-4ab8-a828-6c809ad19857"), saved);
  assert.deepEqual(settings.get("TC:index:v3").charts[saved.chartId], { revision: 2 });
  assert.deepEqual(store.load(saved.chartId), saved);
});

test("store assigns a chart id before the first durable save", async () => {
  const settings = fakeSettings();
  const store = Store.create(settings, { state: State, office });

  const saved = await store.save(chartRecord({ chartId: null, revision: 0 }));

  assert.match(saved.chartId, /^[0-9a-f-]{36}$/);
  assert.ok(settings.get(`TC:chart:${saved.chartId}`));
});

test("pending operations are checked writes in the v3 index", async () => {
  const settings = fakeSettings();
  const store = Store.create(settings, { state: State, office });
  const pending = { chartId: chartRecord().chartId, kind: "replace", token: "op-1" };

  await store.beginPending(pending);
  assert.deepEqual(settings.get("TC:index:v3").pending[pending.chartId], pending);

  await store.commitPending(chartRecord());
  assert.equal(settings.get("TC:index:v3").pending[pending.chartId], undefined);
  assert.ok(settings.get(`TC:chart:${pending.chartId}`));

  await store.beginPending(pending);
  await store.clearPending(pending.chartId);
  assert.equal(settings.get("TC:index:v3").pending[pending.chartId], undefined);
});

test("store rejects writes when document settings cannot be saved", async () => {
  const settings = fakeSettings({}, true);
  const store = Store.create(settings, { state: State, office });

  await assert.rejects(store.save(chartRecord()), (error) => error.code === "SaveFailed");
  assert.equal(settings.get("TC:index:v3"), undefined);
  assert.equal(settings.get(`TC:chart:${chartRecord().chartId}`), undefined);
});
