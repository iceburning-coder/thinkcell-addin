const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadScript, REPO_ROOT } = require("./helpers/load-script.cjs");

const State = loadScript("tc-state.js");
const Store = loadScript("tc-store.js");
const office = { AsyncResultStatus: { Succeeded: "succeeded" } };

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tests/fixtures", name), "utf8"));
}

function settings() {
  const values = new Map();
  return {
    get: (key) => values.get(key), set: (key, value) => values.set(key, JSON.parse(JSON.stringify(value))),
    remove: (key) => values.delete(key), saveAsync: (callback) => callback({ status: "succeeded" }),
  };
}

for (const name of ["state-v1.json", "state-v2.json", "state-v3.json"]) {
  test(`${name} loads, edits, saves and reopens through the v3 store`, async () => {
    const original = fixture(name);
    const migrated = State.normalize(original, { mode: "read" });
    const edited = JSON.parse(JSON.stringify(migrated));
    edited.chart.title += " edited";
    edited.revision += 1;

    const documentSettings = settings();
    const writer = Store.create(documentSettings, { state: State, office });
    const saved = await writer.save(edited);
    const reopened = Store.create(documentSettings, { state: State, office }).load(saved.chartId);

    assert.equal(reopened.version, 3);
    assert.equal(reopened.chart.title, edited.chart.title);
    assert.equal(reopened.revision, edited.revision);
    if (name === "state-v2.json") assert.equal(reopened.link.kind, "legacy-address");
    if (name === "state-v3.json") assert.equal(reopened.link.kind, "workbook-name");
  });
}

