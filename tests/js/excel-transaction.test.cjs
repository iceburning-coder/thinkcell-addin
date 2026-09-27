const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const OfficeAdapter = loadScript("tc-office.js");

function fakeAdapter(failAt) {
  const state = {
    shapes: [{ id: "old", name: "TC:chart" }],
    attempts: [],
    persisted: false,
    cleanupCalls: 0,
  };
  const fail = (phase) => { if (failAt === phase) throw new Error(`${phase} failed`); };
  return {
    state,
    async snapshot() { fail("snapshot"); return { oldId: "old" }; },
    async insertSvg() {
      state.attempts.push({ kind: "svg", batch: state.attempts.length + 1 });
      fail("svg-sync");
      state.shapes.push({ id: "new-svg", name: "pending" });
      return { id: "new-svg" };
    },
    async cleanupFailedSvg() { state.attempts.push({ kind: "svg-cleanup", batch: state.attempts.length + 1 }); },
    async insertPng() {
      state.attempts.push({ kind: "png", batch: state.attempts.length + 1 });
      fail("png-sync");
      state.shapes.push({ id: "new-png", name: "pending" });
      return { id: "new-png" };
    },
    async persist() { fail("persist"); state.persisted = true; },
    async rename(_prepared, pending) { fail("rename"); state.shapes.find((s) => s.id === pending.id).name = "TC:chart"; },
    async deleteOld() { fail("delete"); state.shapes = state.shapes.filter((s) => s.id !== "old"); },
    async cleanupPending(_prepared, pending) {
      state.cleanupCalls += 1;
      if (pending) state.shapes = state.shapes.filter((s) => s.id !== pending.id);
    },
  };
}

test("Excel retries PNG in a fresh attempt when SVG context sync fails", async () => {
  const adapter = fakeAdapter("svg-sync");

  const result = await OfficeAdapter.replaceExcelChart(adapter);

  assert.equal(result.format, "png");
  assert.deepEqual(adapter.state.attempts.map((x) => x.kind), ["svg", "svg-cleanup", "png"]);
  assert.equal(new Set(adapter.state.attempts.map((x) => x.batch)).size, 3);
  assert.equal(adapter.state.shapes.some((shape) => shape.id === "old"), false);
});

test("Excel state-save failure removes the pending shape and preserves the old chart", async () => {
  const adapter = fakeAdapter("persist");

  await assert.rejects(OfficeAdapter.replaceExcelChart(adapter), (error) => error.phase === "persist" && !error.persisted);

  assert.ok(adapter.state.shapes.some((shape) => shape.id === "old"));
  assert.equal(adapter.state.shapes.some((shape) => shape.id === "new-svg"), false);
  assert.equal(adapter.state.cleanupCalls, 1);
});

for (const phase of ["rename", "delete"]) {
  test(`Excel ${phase} failure preserves a recoverable old/new pair`, async () => {
    const adapter = fakeAdapter(phase);

    await assert.rejects(
      OfficeAdapter.replaceExcelChart(adapter),
      (error) => error.phase === phase && error.persisted === true && error.recoverableDuplicate === true,
    );

    assert.equal(adapter.state.persisted, true);
    assert.ok(adapter.state.shapes.some((shape) => shape.id === "old"));
    assert.ok(adapter.state.shapes.some((shape) => shape.id === "new-svg"));
    assert.equal(adapter.state.cleanupCalls, 0);
  });
}

test("Excel PNG failure retains the SVG error as diagnostic context", async () => {
  const adapter = fakeAdapter("svg-sync");
  adapter.insertPng = async () => { throw new Error("png-sync failed"); };

  await assert.rejects(
    OfficeAdapter.replaceExcelChart(adapter),
    (error) => error.phase === "insert" && error.svgError && /svg-sync failed/.test(error.svgError.message),
  );

  assert.ok(adapter.state.shapes.some((shape) => shape.id === "old"));
  assert.equal(adapter.state.cleanupCalls, 1);
});
