const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const State = loadScript("tc-state.js");

test("a late render cannot publish over a newer render", () => {
  const lifecycle = State.createRenderLifecycle();
  const first = lifecycle.start();
  const second = lifecycle.start();

  assert.equal(lifecycle.publish(first, { svg: "old" }), false);
  assert.equal(lifecycle.publish(second, { svg: "new" }), true);
  assert.equal(lifecycle.current().svg, "new");
  assert.equal(Object.isFrozen(lifecycle.current()), true);
});

test("starting or failing the current render invalidates the previous snapshot", () => {
  const lifecycle = State.createRenderLifecycle();
  const successful = lifecycle.start();
  lifecycle.publish(successful, { svg: "ok" });
  assert.equal(lifecycle.current().svg, "ok");

  const failing = lifecycle.start();
  assert.equal(lifecycle.current(), null);
  lifecycle.fail(failing);
  assert.equal(lifecycle.current(), null);
});
