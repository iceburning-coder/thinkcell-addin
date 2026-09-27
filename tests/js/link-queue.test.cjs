const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const Link = loadScript("tc-link.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let next = 1;
  const timers = new Map();
  return {
    set(callback) { const id = next++; timers.set(id, callback); return id; },
    clear(id) { timers.delete(id); },
    fire() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); },
    size() { return timers.size; },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("rapid edits debounce to the newest revision", async () => {
  const timers = fakeTimers();
  const calls = [];
  const queue = Link.createRefreshQueue({ delay: 10, setTimeout: timers.set, clearTimeout: timers.clear, run: async (id, payload) => calls.push([id, payload.revision]) });

  queue.schedule("chart-a", { revision: 1 });
  queue.schedule("chart-a", { revision: 2 });
  queue.schedule("chart-a", { revision: 3 });
  assert.equal(timers.size(), 1);
  timers.fire();
  await queue.idle("chart-a");
  assert.deepEqual(calls, [["chart-a", 3]]);
});

test("the browser-facing queue can use the host timer functions", async () => {
  const calls = [];
  const queue = Link.createRefreshQueue({ delay: 0, run: async (_id, payload) => calls.push(payload.revision) });
  queue.schedule("chart-a", { revision: 1 });
  await queue.idle("chart-a");
  assert.deepEqual(calls, [1]);
});

test("an edit arriving during refresh waits and never overlaps", async () => {
  const timers = fakeTimers();
  const first = deferred();
  const calls = [];
  let active = 0, maxActive = 0;
  const queue = Link.createRefreshQueue({
    delay: 10, setTimeout: timers.set, clearTimeout: timers.clear,
    run: async (_id, payload) => {
      active += 1; maxActive = Math.max(maxActive, active); calls.push(payload.revision);
      if (payload.revision === 1) await first.promise;
      active -= 1;
    },
  });

  queue.schedule("chart-a", { revision: 1 }); timers.fire(); await settle();
  queue.schedule("chart-a", { revision: 2 });
  queue.schedule("chart-a", { revision: 3 }); timers.fire(); await settle();
  assert.deepEqual(calls, [1]);
  first.resolve(); await queue.idle("chart-a");
  assert.deepEqual(calls, [1, 3]);
  assert.equal(maxActive, 1);
});

test("different chart ids have independent refresh tails", async () => {
  const timers = fakeTimers();
  const gates = { a: deferred(), b: deferred() };
  const started = [];
  const queue = Link.createRefreshQueue({ delay: 10, setTimeout: timers.set, clearTimeout: timers.clear, run: async (id) => { started.push(id); await gates[id].promise; } });

  queue.schedule("a", { revision: 1 });
  queue.schedule("b", { revision: 1 });
  timers.fire(); await settle();
  assert.deepEqual(started.sort(), ["a", "b"]);
  gates.a.resolve(); gates.b.resolve();
  await Promise.all([queue.idle("a"), queue.idle("b")]);
});

test("a failed refresh does not poison later edits", async () => {
  const timers = fakeTimers();
  const calls = [], errors = [];
  const queue = Link.createRefreshQueue({
    delay: 10, setTimeout: timers.set, clearTimeout: timers.clear,
    run: async (_id, payload) => { calls.push(payload.revision); if (payload.revision === 1) throw new Error("first failed"); },
    onError: (error) => errors.push(error.message),
  });

  queue.schedule("chart-a", { revision: 1 }); timers.fire(); await queue.idle("chart-a");
  queue.schedule("chart-a", { revision: 2 }); timers.fire(); await queue.idle("chart-a");
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(errors, ["first failed"]);
});
