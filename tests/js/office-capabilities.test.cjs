const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const OfficeAdapter = loadScript("tc-office.js");

function officeWithSupport(supported) {
  return {
    context: {
      requirements: {
        isSetSupported: (name, version) => supported.has(`${name}:${version}`),
      },
    },
  };
}

test("PowerPoint capabilities distinguish slide insertion from shape selection", () => {
  const office = officeWithSupport(new Set(["PowerPointApi:1.2", "ImageCoercion:1.2"]));

  assert.deepEqual(OfficeAdapter.getCapabilities(office, "ppt"), {
    imageInsertion: true,
    svgInsertion: true,
    powerPointSlides: true,
    powerPointShapes: false,
    powerPointShapeMetadata: false,
    powerPointSelection: false,
    powerPointGroups: false,
    excelShapes: false,
    excelSvg: false,
    excelCollectionEvents: false,
    excelWorksheetEvents: false,
  });
});

test("Excel 1.9 enables SVG shapes and collection change events", () => {
  const office = officeWithSupport(new Set(["ExcelApi:1.9"]));

  const capabilities = OfficeAdapter.getCapabilities(office, "xl");
  assert.equal(capabilities.excelShapes, true);
  assert.equal(capabilities.excelSvg, true);
  assert.equal(capabilities.excelCollectionEvents, true);
  assert.equal(capabilities.excelWorksheetEvents, true);
});

test("missing requirement APIs fail closed while retaining baseline image insertion", () => {
  assert.deepEqual(OfficeAdapter.getCapabilities({ context: {} }, "ppt"), {
    imageInsertion: true,
    svgInsertion: false,
    powerPointSlides: false,
    powerPointShapes: false,
    powerPointShapeMetadata: false,
    powerPointSelection: false,
    powerPointGroups: false,
    excelShapes: false,
    excelSvg: false,
    excelCollectionEvents: false,
    excelWorksheetEvents: false,
  });
});

test("Excel 1.7 keeps worksheet events but disables shape operations", () => {
  const capabilities = OfficeAdapter.getCapabilities(officeWithSupport(new Set(["ExcelApi:1.7"])), "xl");

  assert.equal(capabilities.excelWorksheetEvents, true);
  assert.equal(capabilities.excelShapes, false);
  assert.equal(capabilities.excelSvg, false);
});

test("Excel host references remain stable when a worksheet is renamed", () => {
  assert.equal(OfficeAdapter.excelHostRef("sheet-id-42", "shape-id-7"), "xl:sheet-id-42:shape-id-7");
  assert.equal(
    OfficeAdapter.excelHostRef("sheet-id-42", "shape-id-7"),
    OfficeAdapter.excelHostRef("sheet-id-42", "shape-id-7", "Renamed Sheet"),
  );
});

test("PowerPoint shape metadata is gated separately from slide insertion", () => {
  const office = officeWithSupport(new Set(["PowerPointApi:1.2", "PowerPointApi:1.4"]));

  const capabilities = OfficeAdapter.getCapabilities(office, "ppt");
  assert.equal(capabilities.powerPointSlides, true);
  assert.equal(capabilities.powerPointShapes, true);
  assert.equal(capabilities.powerPointShapeMetadata, true);
  assert.equal(capabilities.powerPointSelection, false);
});

test("PowerPoint 1.2 inserts an untracked editable slide while 1.4 enables identity tracking", () => {
  const ppt12 = OfficeAdapter.getCapabilities(officeWithSupport(new Set(["PowerPointApi:1.2"])), "ppt");
  const ppt14 = OfficeAdapter.getCapabilities(officeWithSupport(new Set(["PowerPointApi:1.2", "PowerPointApi:1.4"])), "ppt");

  assert.equal(OfficeAdapter.powerPointSlideInsertionMode(ppt12), "untracked");
  assert.equal(OfficeAdapter.powerPointSlideInsertionMode(ppt14), "tracked");
  assert.equal(OfficeAdapter.powerPointSlideInsertionMode({}), "unsupported");
});

test("capability gate re-enables a supported non-render button after host detection", () => {
  const reason = "unsupported";
  assert.deepEqual(OfficeAdapter.capabilityGate({}, "powerPointSelection", { reason }), {
    disabled: true, title: reason,
  });
  assert.deepEqual(OfficeAdapter.capabilityGate({ powerPointSelection: true }, "powerPointSelection", { reason }), {
    disabled: false, title: "",
  });
});

test("capability gate still waits for a rendered chart on chart actions", () => {
  const capabilities = { powerPointSlides: true };
  assert.equal(OfficeAdapter.capabilityGate(capabilities, "powerPointSlides", {
    requiresChart: true, busy: false, hasChart: false,
  }).disabled, true);
  assert.equal(OfficeAdapter.capabilityGate(capabilities, "powerPointSlides", {
    requiresChart: true, busy: false, hasChart: true,
  }).disabled, false);
});

test("capability gate keeps every supported action disabled while rendering", () => {
  const capabilities = { powerPointSelection: true };
  assert.equal(OfficeAdapter.capabilityGate(capabilities, "powerPointSelection", {
    requiresChart: false, busy: true, hasChart: true,
  }).disabled, true);
});

test("busy tracker remains active until overlapping render and Office work both finish", () => {
  const transitions = [];
  const tracker = OfficeAdapter.createBusyTracker((busy, count) => transitions.push([busy, count]));
  const endOffice = tracker.begin();
  const endRender = tracker.begin();

  endRender();
  assert.equal(tracker.isBusy(), true);
  assert.equal(tracker.count(), 1);

  endOffice();
  assert.equal(tracker.isBusy(), false);
  assert.deepEqual(transitions, [[true, 1], [true, 2], [true, 1], [false, 0]]);
});

test("preview freshness invalidates chart actions immediately during a debounce window", () => {
  const freshness = OfficeAdapter.createFreshnessTracker();
  freshness.publish();
  assert.equal(freshness.isFresh(), true);

  freshness.invalidate();
  assert.equal(freshness.isFresh(), false);
  assert.equal(OfficeAdapter.capabilityGate({ powerPointSelection: true }, "powerPointSelection", {
    requiresChart: true, hasChart: freshness.isFresh(), busy: false,
  }).disabled, true);

  freshness.publish();
  assert.equal(freshness.isFresh(), true);
});

test("selecting a different PowerPoint chart offers an explicit edit switch", () => {
  const editing = { chartId: "chart-a", id: "shape-a" };

  assert.equal(OfficeAdapter.chartSelectionMode(editing, { chartId: "chart-b", id: "shape-b" }), "switch");
  assert.equal(OfficeAdapter.chartSelectionMode(editing, { chartId: "chart-a", id: "shape-a" }), "editing");
  assert.equal(OfficeAdapter.chartSelectionMode(editing, null), "editing");
  assert.equal(OfficeAdapter.chartSelectionMode(null, { chartId: "chart-b", id: "shape-b" }), "selected");
});

test("PowerPoint 1.8 can resolve a selected child through its tracked parent group", () => {
  const chartId = "0818a03d-9dd0-4881-94a8-e6e84014238b";
  const record = { chartId, revision: 3 };
  const candidates = [
    { id: "child", name: "TextBox 3", tags: {} },
    { id: "group", name: `TC:${chartId}`, tags: {} },
  ];

  assert.equal(OfficeAdapter.getCapabilities(officeWithSupport(new Set(["PowerPointApi:1.8"])), "ppt").powerPointGroups, true);
  assert.deepEqual(
    OfficeAdapter.resolvePowerPointChartCandidate(candidates, (name, id) => (id === chartId ? record : null)),
    { shape: candidates[1], identity: { chartId, revision: 0, pendingToken: null, source: "name" }, record },
  );
});
