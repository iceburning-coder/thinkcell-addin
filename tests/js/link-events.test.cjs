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

test("a failed linked-chart replacement clears its echo and schedules a refresh", async () => {
  const event = { chartId: "chart-a", worksheetId: "sheet-1", address: "A1", values: [[2]] };
  const echoes = Link.createEchoTracker({ now: () => 1000, ttl: 5000 });
  const refreshed = [];
  const refreshes = Link.createRefreshQueue({
    delay: 0,
    run: async (chartId, payload) => { refreshed.push([chartId, payload]); },
  });
  echoes.expect(event);

  await assert.rejects(
    Link.withWritebackRecovery({
      chartId: "chart-a", payload: { name: "TC:chart-a" }, echoes, refreshes,
      replace: async () => { throw new Error("replacement failed"); },
    }),
    /replacement failed/,
  );
  await refreshes.idle("chart-a");

  assert.equal(echoes.consume(event), false);
  assert.deepEqual(refreshed, [["chart-a", { name: "TC:chart-a" }]]);
});

test("a named-link failure after cell write receives the same recovery coverage", async () => {
  const event = { chartId: "chart-a", worksheetId: "sheet-1", address: "A1", values: [[3]] };
  const echoes = Link.createEchoTracker({ now: () => 1000, ttl: 5000 });
  const refreshed = [];
  const refreshes = Link.createRefreshQueue({
    delay: 0,
    run: async (chartId, payload) => { refreshed.push([chartId, payload]); },
  });

  await assert.rejects(
    Link.withWritebackRecovery({
      chartId: "chart-a", payload: { name: "TC:chart-a" }, echoes, refreshes,
      replace: async () => {
        echoes.expect(event); // xlWriteGrid 已经写入并登记回声
        throw new Error("defined name failed"); // 随后的 xlSetNamedLink 失败
      },
    }),
    /defined name failed/,
  );
  await refreshes.idle("chart-a");

  assert.equal(echoes.consume(event), false);
  assert.deepEqual(refreshed, [["chart-a", { name: "TC:chart-a" }]]);
});
