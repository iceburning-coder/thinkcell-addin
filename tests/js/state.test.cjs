const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

test("state module exposes the current document schema version", () => {
  const state = loadScript("tc-state.js");

  assert.equal(state.CURRENT_VERSION, 3);
});
