const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const State = loadScript("tc-state.js");

function validChart(overrides = {}) {
  return {
    type: "column",
    data: "Category\tValue\nA\t1",
    title: "Revenue",
    theme: "consulting",
    opt: {},
    ann: {},
    colors: {},
    ...overrides,
  };
}

test("rejects chart types outside the supported add-in set", () => {
  assert.throws(() => State.validateChart(validChart({ type: "script" })), (error) => error.code === "TC_STATE_INVALID_CHART");
});

test("rejects non-finite numeric values at any depth", () => {
  assert.throws(() => State.validateSpec({ type: "column", series: { Revenue: [1, Infinity] } }), (error) => error.code === "TC_STATE_NON_FINITE");
});

test("rejects colours that can break out of an SVG attribute", () => {
  assert.throws(
    () => State.validateChart(validChart({ colors: { Revenue: '#123456" onload="alert(1)' } })),
    (error) => error.code === "TC_STATE_INVALID_COLOR",
  );
});

test("rejects clipboard payloads larger than the configured byte limit", () => {
  const payload = `${State.PAYLOAD_PREFIX}${"A".repeat(State.MAX_PAYLOAD_BYTES + 1)}`;
  assert.throws(() => State.parseClipboard(payload), (error) => error.code === "TC_STATE_TOO_LARGE");
});

test("rejects objects deeper than the configured nesting limit", () => {
  let nested = { value: 1 };
  for (let index = 0; index <= State.MAX_DEPTH; index += 1) nested = { nested };

  assert.throws(() => State.validateSpec({ type: "column", nested }), (error) => error.code === "TC_STATE_TOO_DEEP");
});

test("rejects prototype-pollution keys parsed from untrusted JSON", () => {
  const polluted = JSON.parse('{"type":"column","__proto__":{"polluted":true}}');

  assert.throws(() => State.validateSpec(polluted), (error) => error.code === "TC_STATE_DANGEROUS_KEY");
  assert.equal({}.polluted, undefined);
});

test("clipboard serialization round-trips Unicode through the shared validator", () => {
  const payload = State.serializeClipboard({ v: 2, ...validChart({ title: "市场增长 📈" }) });
  const parsed = State.parseClipboard(payload);

  assert.equal(parsed.version, 3);
  assert.equal(parsed.chart.title, "市场增长 📈");
});

test("custom themes reject stored markup and fall back to a safe palette", () => {
  const fallback = {
    SERIES: ["#0B2D4F", "#3F86C0"],
    ACCENT: "#E4572E", OTHER: "#D9D9D9", POS: "#2E8B57", NEG: "#C0392B", TOTAL: "#0B2D4F",
  };
  const poisoned = {
    ...fallback,
    SERIES: ['#0B2D4F\"><img src=x onerror=alert(1)>'],
  };

  const normalized = State.normalizeColorTheme(poisoned, fallback);

  assert.deepEqual(normalized, fallback);
  assert.notEqual(normalized, fallback);
});

test("custom themes accept only bounded six-digit hexadecimal palettes", () => {
  const fallback = {
    SERIES: ["#0B2D4F"],
    ACCENT: "#E4572E", OTHER: "#D9D9D9", POS: "#2E8B57", NEG: "#C0392B", TOTAL: "#0B2D4F",
  };
  const valid = { ...fallback, SERIES: ["#123456", "#abcdef"] };

  assert.deepEqual(State.normalizeColorTheme(valid, fallback), valid);
  assert.deepEqual(State.normalizeColorTheme({ ...valid, SERIES: Array(11).fill("#123456") }, fallback), fallback);
  assert.deepEqual(State.normalizeColorTheme({ ...valid, ACCENT: "red" }, fallback), fallback);
});
