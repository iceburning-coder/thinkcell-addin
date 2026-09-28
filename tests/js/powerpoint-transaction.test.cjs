const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const OfficeAdapter = loadScript("tc-office.js");

function fakeAdapter(failAt) {
  const state = {
    shapes: [{ id: "old", name: "TC:chart", role: "old" }],
    persisted: false,
    cleanupCalls: 0,
  };
  const fail = (phase) => {
    if (failAt === phase) throw new Error(`${phase} failed`);
  };
  return {
    state,
    async snapshot() { fail("snapshot"); return { oldId: "old", beforeIds: new Set(state.shapes.map((s) => s.id)) }; },
    async insert() { fail("insert"); state.shapes.push({ id: "pending", name: "pending", role: "pending" }); },
    async identify() { fail("identify"); return { id: "pending" }; },
    async persist() { fail("persist"); state.persisted = true; },
    async renameAndTag() {
      fail("rename");
      state.shapes.find((s) => s.id === "pending").name = "TC:chart";
    },
    async deleteOld() {
      fail("delete");
      state.shapes = state.shapes.filter((s) => s.id !== "old");
    },
    async cleanupPending() {
      state.cleanupCalls += 1;
      state.shapes = state.shapes.filter((s) => s.id !== "pending");
    },
  };
}

for (const phase of ["snapshot", "insert", "identify", "persist"]) {
  test(`PowerPoint ${phase} failure preserves the old chart`, async () => {
    const adapter = fakeAdapter(phase);

    await assert.rejects(OfficeAdapter.replacePowerPointChart(adapter), new RegExp(`${phase} failed`));

    assert.ok(adapter.state.shapes.some((shape) => shape.id === "old"));
    assert.equal(adapter.state.persisted, false);
    if (phase === "identify" || phase === "persist") {
      assert.equal(adapter.state.cleanupCalls, 1);
      assert.equal(adapter.state.shapes.some((shape) => shape.id === "pending"), false);
    }
  });
}

for (const phase of ["rename", "delete"]) {
  test(`PowerPoint ${phase} failure keeps a recoverable old/new pair after persistence`, async () => {
    const adapter = fakeAdapter(phase);

    await assert.rejects(
      OfficeAdapter.replacePowerPointChart(adapter),
      (error) => error.phase === phase && error.persisted === true && error.recoverableDuplicate === true,
    );

    assert.equal(adapter.state.persisted, true);
    assert.ok(adapter.state.shapes.some((shape) => shape.id === "old"));
    assert.ok(adapter.state.shapes.some((shape) => shape.id === "pending"));
    assert.equal(adapter.state.cleanupCalls, 0);
  });
}

test("PowerPoint replacement deletes the old chart only after state and pending shape commit", async () => {
  const adapter = fakeAdapter(null);

  const result = await OfficeAdapter.replacePowerPointChart(adapter);

  assert.deepEqual(result.pending, { id: "pending" });
  assert.equal(adapter.state.persisted, true);
  assert.equal(adapter.state.shapes.some((shape) => shape.id === "old"), false);
  assert.equal(adapter.state.shapes.find((shape) => shape.id === "pending").name, "TC:chart");
});

test("inserted-shape resolution prefers selected ids and otherwise requires one id delta", () => {
  const beforeIds = new Set(["old", "other"]);

  assert.equal(OfficeAdapter.resolveInsertedShapeId(beforeIds, ["old", "new"], ["new"]), "new");
  assert.equal(OfficeAdapter.resolveInsertedShapeId(beforeIds, ["old", "new"], []), "new");
  assert.throws(
    () => OfficeAdapter.resolveInsertedShapeId(beforeIds, ["old", "new-a", "new-b"], []),
    (error) => error.code === "TC_PPT_INSERT_AMBIGUOUS"
      && error.details.beforeIds.join(",") === "old,other"
      && error.details.allIds.join(",") === "old,new-a,new-b"
      && error.details.selectedIds.length === 0
      && error.details.deltaIds.join(",") === "new-a,new-b",
  );
});

test("inserted-shape resolution ignores a selected shape from another slide", () => {
  const beforeIds = new Set(["old"]);

  assert.equal(
    OfficeAdapter.resolveInsertedShapeId(beforeIds, ["old", "target-new"], ["foreign-selected"]),
    "target-new",
  );
});

test("selected shape ids are ignored when the active slide is not the transaction target", () => {
  assert.deepEqual(
    OfficeAdapter.selectedShapeIdsOnSlide("target-slide", ["other-slide"], ["same-id-as-target-candidate"]),
    [],
  );
  assert.deepEqual(
    OfficeAdapter.selectedShapeIdsOnSlide("target-slide", ["target-slide"], ["target-new"]),
    ["target-new"],
  );
});

test("PowerPoint render output is captured by value before an asynchronous transaction", () => {
  const live = { svg: "<svg id='first'/>", width: 640, height: 360 };
  const captured = OfficeAdapter.captureChartOutput(live);

  live.svg = "<svg id='second'/>";
  live.width = 320;

  assert.deepEqual(captured, { svg: "<svg id='first'/>", width: 640, height: 360 });
  assert.equal(Object.isFrozen(captured), true);
});

function fakeSlideAdapter(failAt) {
  const state = { slides: [], persisted: false, tagged: false, cleanupCalls: 0 };
  const fail = (phase) => { if (phase === failAt) throw new Error(`${phase} failed`); };
  return {
    state,
    async snapshot() { fail("snapshot"); return { beforeSlideIds: new Set() }; },
    async insert() { fail("insert"); state.slides.push({ slideId: "slide-new", shapeId: "group-new" }); },
    async identify() { fail("identify"); return { slideId: "slide-new", id: "group-new" }; },
    async persist() { fail("persist"); state.persisted = true; },
    async tag() { fail("tag"); state.tagged = true; },
    async cleanupPending() { state.cleanupCalls += 1; state.slides = []; },
  };
}

for (const phase of ["snapshot", "insert", "identify", "persist"]) {
  test(`editable-slide ${phase} failure cleans an uncommitted inserted slide`, async () => {
    const adapter = fakeSlideAdapter(phase);

    await assert.rejects(OfficeAdapter.insertPowerPointSlide(adapter), new RegExp(`${phase} failed`));

    assert.equal(adapter.state.persisted, false);
    if (phase !== "snapshot") {
      assert.equal(adapter.state.cleanupCalls, 1);
      assert.equal(adapter.state.slides.length, 0);
    }
  });
}

test("editable-slide insertion persists identity before tagging the group", async () => {
  const adapter = fakeSlideAdapter(null);

  const result = await OfficeAdapter.insertPowerPointSlide(adapter);

  assert.deepEqual(result.pending, { slideId: "slide-new", id: "group-new" });
  assert.equal(adapter.state.persisted, true);
  assert.equal(adapter.state.tagged, true);
  assert.equal(adapter.state.cleanupCalls, 0);
});

test("editable-slide tag failure keeps the persisted slide for recovery", async () => {
  const adapter = fakeSlideAdapter("tag");

  await assert.rejects(
    OfficeAdapter.insertPowerPointSlide(adapter),
    (error) => error.phase === "tag" && error.persisted === true,
  );

  assert.equal(adapter.state.persisted, true);
  assert.equal(adapter.state.slides.length, 1);
  assert.equal(adapter.state.cleanupCalls, 0);
});

test("editable-slide cleanup failure keeps the pending marker for later recovery", async () => {
  const adapter = fakeSlideAdapter("persist");
  adapter.cleanupPending = async () => { throw new Error("cleanup failed"); };

  await assert.rejects(
    OfficeAdapter.insertPowerPointSlide(adapter),
    (error) => error.phase === "persist" && error.cleanupError && error.retainPending === true,
  );
});

test("editable-slide cleanup only claims a new slide containing the expected chart marker", () => {
  const before = new Set(["slide-old"]);
  assert.equal(
    OfficeAdapter.resolveOwnedInsertedSlideId(before, [
      { id: "slide-old", shapeNames: [] },
      { id: "slide-ours", shapeNames: ["TC:chart"] },
      { id: "slide-theirs", shapeNames: ["Title 1"] },
    ], "TC:chart"),
    "slide-ours",
  );
  assert.throws(
    () => OfficeAdapter.resolveOwnedInsertedSlideId(before, [
      { id: "slide-old", shapeNames: [] },
      { id: "slide-theirs", shapeNames: ["Title 1"] },
    ], "TC:chart"),
    /无法安全确认/,
  );
});
