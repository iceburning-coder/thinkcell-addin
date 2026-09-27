const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const Link = loadScript("tc-link.js");
const ID = "4eb927f0-c3fa-4ab8-a828-6c809ad19857";

function baseRecord() {
  return Link.createRecord(ID, { worksheetId: "old-id", sheet: "Old", address: "A1:B2" });
}

test("named link resolution follows sheet renames and moved ranges", async () => {
  const resolved = await Link.resolve(baseRecord(), async () => ({ worksheetId: "old-id", sheet: "Renamed", address: "$C$3:$D$8" }));

  assert.equal(resolved.status, "ok");
  assert.equal(resolved.sheet, "Renamed");
  assert.equal(resolved.worksheetId, "old-id");
  assert.equal(resolved.lastAddress, "Renamed!$C$3:$D$8");
});

test("deleted worksheets and #REF names become broken without losing the last good address", async () => {
  const original = baseRecord();
  const deleted = await Link.resolve(original, async () => { throw Object.assign(new Error("missing"), { code: "ItemNotFound" }); });
  const ref = await Link.resolve(original, async () => ({ formula: "=#REF!", worksheetId: null, address: null }));

  for (const broken of [deleted, ref]) {
    assert.equal(broken.status, "broken");
    assert.equal(broken.lastAddress, original.lastAddress);
    assert.match(broken.error.code, /ItemNotFound|TC_LINK_REF/);
  }
});

test("legacy address links remain resolvable during migration", async () => {
  const legacy = { kind: "legacy-address", address: "'Data 2026'!A1:C5", sheet: "Data 2026" };
  const resolved = await Link.resolve(legacy, async () => { throw new Error("resolver should not run"); });

  assert.equal(resolved.status, "legacy");
  assert.equal(resolved.lastAddress, "'Data 2026'!A1:C5");
});
