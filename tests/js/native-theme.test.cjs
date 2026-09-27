const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const OfficeAdapter = loadScript("tc-office.js");

test("native chart palette accepts the custom theme object produced by buildSpec", () => {
  const custom = { base: "consulting", SERIES: ["#123456", "#ABCDEF"], ACCENT: "#FF0000" };

  assert.deepEqual(OfficeAdapter.resolvePalette(custom), ["#123456", "#ABCDEF"]);
});

test("native chart palette resolves built-in themes and safely falls back", () => {
  assert.deepEqual(OfficeAdapter.resolvePalette("semi"), ["#1F5A8C", "#A6A6A6", "#7FB2DC", "#595959", "#D9D9D9"]);
  assert.deepEqual(OfficeAdapter.resolvePalette("unknown"), ["#0B2D4F", "#1F5A8C", "#3F86C0", "#7FB2DC", "#B9D5EC"]);
  assert.deepEqual(OfficeAdapter.resolvePalette({ SERIES: [] }), ["#0B2D4F", "#1F5A8C", "#3F86C0", "#7FB2DC", "#B9D5EC"]);
});
