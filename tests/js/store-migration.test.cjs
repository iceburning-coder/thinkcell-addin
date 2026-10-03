const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const State = loadScript("tc-state.js");
const Store = loadScript("tc-store.js");
const office = { AsyncResultStatus: { Succeeded: "succeeded" } };

function legacyChart() {
  return { v: 2, type: "column", data: "Category\tValue\nA\t1", title: "Legacy", theme: "consulting" };
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

test("loading a v2 name-keyed record migrates only in memory", () => {
  const settings = fakeSettings({ "TC:old-shape": legacyChart(), "TC:index": ["TC:old-shape"] });
  const store = Store.create(settings, { state: State, office });

  const loaded = store.loadLegacy("TC:old-shape");

  assert.equal(loaded.version, 3);
  assert.equal(loaded.chartId, null);
  assert.equal(settings.get("TC:index:v3"), undefined);
  assert.deepEqual(settings.get("TC:old-shape"), legacyChart());
});

test("successful legacy migration adds v3 data without deleting legacy keys", async () => {
  const legacy = legacyChart();
  const settings = fakeSettings({ "TC:old-shape": legacy, "TC:index": ["TC:old-shape"] });
  const store = Store.create(settings, { state: State, office });

  const migrated = await store.migrateLegacy("TC:old-shape");

  assert.match(migrated.chartId, /^[0-9a-f-]{36}$/);
  assert.ok(settings.get(`TC:chart:${migrated.chartId}`));
  assert.deepEqual(settings.get("TC:old-shape"), legacy);
  assert.deepEqual(settings.get("TC:index"), ["TC:old-shape"]);
});

test("failed legacy migration rolls back v3 writes and preserves legacy data", async () => {
  const legacy = legacyChart();
  const settings = fakeSettings({ "TC:old-shape": legacy, "TC:index": ["TC:old-shape"] }, true);
  const store = Store.create(settings, { state: State, office });

  await assert.rejects(store.migrateLegacy("TC:old-shape"), (error) => error.code === "SaveFailed");

  assert.deepEqual(settings.get("TC:old-shape"), legacy);
  assert.deepEqual(settings.get("TC:index"), ["TC:old-shape"]);
  assert.equal(settings.get("TC:index:v3"), undefined);
  assert.equal([...settings.values.keys()].some((key) => key.startsWith("TC:chart:")), false);
});

test("future-version records load read-only and cannot be overwritten", async () => {
  const id = "4eb927f0-c3fa-4ab8-a828-6c809ad19857";
  const future = { version: 4, chartId: id, revision: 1, chart: { type: "column" }, link: null, meta: {} };
  const settings = fakeSettings({ [`TC:chart:${id}`]: future });
  const store = Store.create(settings, { state: State, office });

  assert.equal(store.load(id).readOnly, true);
  await assert.rejects(store.save(future), (error) => error.code === "TC_STATE_FUTURE_VERSION");
  await assert.rejects(store.save({
    version: 3, chartId: id, revision: 2,
    chart: { type: "column", data: "Category\tValue\nA\t2" }, link: null, meta: {},
  }), (error) => error.code === "TC_STORE_FUTURE_VERSION");
  assert.deepEqual(settings.get(`TC:chart:${id}`), future);
});

test("missing document settings fail with a stable store error", async () => {
  const store = Store.create(null, { state: State, office });

  assert.equal(store.load("missing"), null);
  await assert.rejects(store.save(State.migrate(legacyChart())), (error) => error.code === "TC_STORE_UNAVAILABLE");
});
