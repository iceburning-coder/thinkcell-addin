const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const Link = loadScript("tc-link.js");

test("an expected internal write echo is consumed exactly once", () => {
  let now = 1000;
  const echoes = Link.createEchoTracker({ now: () => now, ttl: 5000 });
  const expected = { chartId: "chart-a", worksheetId: "sheet-1", address: "Sheet1!$A$1:$B$2", values: [["Q1", "Q2"], [1, 2]] };

  echoes.expect(expected);
  assert.equal(echoes.consume({ ...expected, address: "A1:B2" }), true);
  assert.equal(echoes.consume({ ...expected, address: "A1:B2" }), false);
});

test("a different immediate user value is not suppressed", () => {
  const echoes = Link.createEchoTracker({ now: () => 1000, ttl: 5000 });
  const base = { chartId: "chart-a", worksheetId: "sheet-1", address: "A1:B2" };
  echoes.expect({ ...base, values: [[1, 2], [3, 4]] });

  assert.equal(echoes.consume({ ...base, values: [[1, 2], [3, 5]] }), false);
  assert.equal(echoes.consume({ ...base, values: [[1, 2], [3, 4]] }), true);
});

test("worksheet, range and chart identity are all part of echo matching", () => {
  const echoes = Link.createEchoTracker({ now: () => 1000, ttl: 5000 });
  const expected = { chartId: "chart-a", worksheetId: "sheet-1", address: "$A$1:$B$2", values: [[1]] };
  echoes.expect(expected);

  assert.equal(echoes.consume({ ...expected, chartId: "chart-b" }), false);
  assert.equal(echoes.consume({ ...expected, worksheetId: "sheet-2" }), false);
  assert.equal(echoes.consume({ ...expected, address: "A1:B3" }), false);
  assert.equal(echoes.consume({ ...expected, address: "A1:B2" }), true);
});

test("expiry only cleans stale expectations", () => {
  let now = 1000;
  const echoes = Link.createEchoTracker({ now: () => now, ttl: 50 });
  const event = { chartId: "chart-a", worksheetId: "sheet-1", address: "A1", values: [[1]] };
  echoes.expect(event);
  now = 1051;
  assert.equal(echoes.consume(event), false);
});

